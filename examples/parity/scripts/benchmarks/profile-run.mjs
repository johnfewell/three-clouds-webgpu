#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { buildDigest } from '../buildDigest.mjs'
import { launchBenchmarkBrowser, runBrowserJob } from './browser.mjs'
import { DEFAULT_PLAN, makePlan } from './plan.mjs'
import {
  ATMOSPHERE_MODES,
  summarisePasses,
  validateAtmosphereReceipt
} from './profile.mjs'
import { buildMetadata, hashSources, verifyServedArtifact } from './run.mjs'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    output: { type: 'string' },
    case: { type: 'string', default: 'baseline-medium' },
    study: { type: 'string', default: 'samples' },
    mode: { type: 'string' }
  }
})
if (!values.url || !values.output)
  throw new Error(
    'Required: --url LOCAL_PARITY_SERVER --output NEW_JSON_FILE [--case NAME|all]'
  )
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(values.url).hostname))
  throw new Error('Profiler requires a local parity server')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
if (!['samples', 'lookup'].includes(values.study))
  throw new Error('Unknown study')
const plan = makePlan({ ...DEFAULT_PLAN, profile: 'standard' })
const scenes =
  values.case === 'all'
    ? plan.cases
    : values.case.split(',').map(caseName => {
        if (!caseName.trim()) throw new Error('Empty case selection')
        return (
          plan.cases.find(scene => scene.caseName === caseName) ?? {
            caseName,
            width: 1280,
            height: 720,
            motion: 'static',
            settings: {}
          }
        )
      })
if (!scenes.length) throw new Error(`Unknown case: ${values.case}`)
const before = await hashSources(root)
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
const build = await buildMetadata('new', root, plan)
if (before.sourceHash !== build.sourceHash)
  throw new Error('Source changed during build')
const scriptHash = createHash('sha256')
for (const name of [
  'profile-run.mjs',
  'profile.mjs',
  'browser.mjs',
  'run.mjs',
  'plan.mjs'
])
  scriptHash.update(name).update(await readFile(new URL(name, import.meta.url)))
const output = resolve(values.output)
await mkdir(dirname(output), { recursive: true })
// Reserve the output before launching Chrome, never overwriting an earlier run
await writeFile(output, '{}\n', { flag: 'wx' })
const report = {
  protocol: 'clouds-profile-v1',
  study: values.study,
  publishable: false,
  idleConfirmed: process.env.BENCHMARK_IDLE === '1',
  note: 'Exploratory ablations, not equal-quality performance claims. Pass spans may overlap; do not add them to infer frame cost.',
  createdAt: new Date().toISOString(),
  scriptHash: scriptHash.digest('hex'),
  build,
  machine: {
    cpu: os.cpus()[0]?.model,
    os: os.version(),
    release: os.release(),
    node: process.version
  },
  warmupFrames: 64,
  sampleFrames: 30,
  runs: []
}
const sampleArms = [
  { id: 'webgl-reference', backend: 'webgl' },
  { id: 'webgpu-parity-256', backend: 'webgpu', profile: {} },
  {
    id: 'webgpu-atmosphere-64',
    backend: 'webgpu',
    profile: { scatteringSamples: [64, 64] }
  },
  {
    id: 'webgpu-atmosphere-16',
    backend: 'webgpu',
    profile: { scatteringSamples: [16, 16] }
  },
  {
    id: 'webgpu-atmosphere-default',
    backend: 'webgpu',
    profile: { scatteringSamples: [4, 14] }
  }
]
const lookupArms = ATMOSPHERE_MODES.map(atmosphereMode => ({
  id: `webgpu-${atmosphereMode}`,
  backend: 'webgpu',
  profile: { atmosphereMode, qualityScreen: true }
}))
const arms = values.study === 'lookup' ? lookupArms : sampleArms
if (values.mode != null) {
  const selected = arms.find(arm => arm.id === `webgpu-${values.mode}`)
  if (selected == null) throw new Error('Unknown study mode')
  arms.splice(0, arms.length, selected)
}
const browser = await launchBenchmarkBrowser()
try {
  for (const scene of scenes)
    for (const repetition of [0, 1]) {
      // Reverse the second sweep to expose order/thermal drift
      for (const arm of repetition ? [...arms].reverse() : arms) {
        const result = await runBrowserJob(browser, {
          baseURL: values.url,
          scene,
          backend: arm.backend,
          profile: arm.profile,
          variant: plan.variants.find(variant => variant.id === 'baseline'),
          warmupFrames: report.warmupFrames,
          sampleFrames: report.sampleFrames
        })
        if (result.environment.errors.length)
          throw new Error(result.environment.errors.join('\n'))
        if (!result.samples.gpuMs) throw new Error('GPU timestamps unavailable')
        if (arm.backend === 'webgpu') {
          if (result.profile?.frames.length !== report.sampleFrames)
            throw new Error('Incomplete pass profile')
          const expected = arm.profile.scatteringSamples ?? [256, 256]
          if (
            !arm.profile.atmosphereMode?.startsWith('samples-') &&
            String(result.profile.effectiveScatteringSamples) !==
              String(expected)
          )
            throw new Error('Atmosphere sample-count override did not apply')
          if (arm.profile.atmosphereMode)
            validateAtmosphereReceipt(
              result.profile,
              arm.profile.atmosphereMode
            )
        }
        const servedArtifact = await verifyServedArtifact(
          values.url,
          result.environment,
          build.sharedSha256,
          build.servedRoot
        )
        const passes = result.profile
          ? summarisePasses(result.profile.frames)
          : null
        report.runs.push({
          scene,
          arm: arm.id,
          repetition,
          servedArtifact,
          ...result,
          passes
        })
        console.log(
          scene.caseName,
          arm.id,
          repetition,
          'GPU ms',
          result.samples.gpuMs.median.toFixed(3),
          JSON.stringify(
            passes &&
              Object.fromEntries(
                Object.entries(passes).map(([name, data]) => [
                  name,
                  data.medianMs.toFixed(3)
                ])
              )
          )
        )
        await writeFile(output, JSON.stringify(report, null, 2) + '\n')
        if (result.screening)
          console.log('screening', JSON.stringify(result.screening))
      }
    }
  if (
    (await hashSources(root)).sourceHash !== build.sourceHash ||
    buildDigest(root).digest !== build.buildDigest
  )
    throw new Error('Source/build changed during profiling')
  report.completed = true
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  await browser.close()
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
