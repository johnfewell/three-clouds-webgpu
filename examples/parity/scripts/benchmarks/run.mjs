#!/usr/bin/env node

// Execute both builds against one deterministic, seeded benchmark schedule
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { buildDigest } from '../buildDigest.mjs'
import {
  BenchmarkUnsupportedError,
  launchBenchmarkBrowser,
  runBrowserJob
} from './browser.mjs'
import { clockStability } from './clock.mjs'
import {
  DEFAULT_PLAN,
  makePlan,
  planFingerprint,
  scheduleFor
} from './plan.mjs'

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))

async function benchmarkSuiteHash() {
  const files = [
    ['plan.mjs', join(benchmarkRoot, 'plan.mjs')],
    ['run.mjs', join(benchmarkRoot, 'run.mjs')],
    ['browser.mjs', join(benchmarkRoot, 'browser.mjs')],
    ['profile.mjs', join(benchmarkRoot, 'profile.mjs')],
    ['clock.mjs', join(benchmarkRoot, 'clock.mjs')],
    [
      'stars.bin',
      join(
        benchmarkRoot,
        '../../node_modules/@takram/three-atmosphere/assets/stars.bin'
      )
    ],
    [
      'stbn.bin',
      join(benchmarkRoot, '../../../../test/fixtures/experimental/stbn.bin')
    ]
  ]
  const hash = createHash('sha256')
  for (const [name, file] of files)
    hash
      .update(name)
      .update('\0')
      .update(await readFile(file))
      .update('\0')
  return hash.digest('hex')
}

function machineInfo(label) {
  return {
    label: label ?? process.env.BENCHMARK_MACHINE ?? os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    osRelease: os.release(),
    osVersion: os.version(),
    node: process.version
  }
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function usage() {
  return 'usage: node run.mjs --old-root DIR --new-root DIR [--output FILE] [--plan FILE] [--profile smoke|standard|full] [--machine LABEL]'
}

async function loadPlan(file) {
  if (file == null) return makePlan(DEFAULT_PLAN)
  return makePlan(JSON.parse(await readFile(file, 'utf8')))
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  if (port === 0) throw new Error('could not reserve a localhost port')
  return port
}

async function prepareBuild(root) {
  const projectRoot = await realpath(root)
  const before = await hashSources(projectRoot)
  const options = {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }
  execFileSync(pnpmCommand(), ['build'], options)
  execFileSync(pnpmCommand(), ['--filter', 'parity', 'setup-assets'], {
    ...options
  })
  if ((await hashSources(projectRoot)).sourceHash !== before.sourceHash)
    throw new Error(`Source changed during build: ${projectRoot}`)
  return projectRoot
}

export async function hashSources(projectRoot) {
  const sourceFiles = [
    ...new Set(
      execFileSync(
        'git',
        [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
          '--',
          'src',
          'examples/parity/src',
          'examples/parity/cases',
          'package.json',
          'examples/parity/package.json',
          'pnpm-lock.yaml',
          ':(glob)**/*vite*',
          ':(glob)**/*tsconfig*'
        ],
        { cwd: projectRoot }
      )
        .toString()
        .split('\0')
        .filter(Boolean)
    )
  ].sort()
  if (sourceFiles.length === 0)
    throw new Error(`source file inventory is empty: ${projectRoot}`)
  const sourceDigest = createHash('sha256')
  for (const file of sourceFiles)
    sourceDigest
      .update(file)
      .update('\0')
      .update(await readFile(join(projectRoot, file)))
      .update('\0')
  return { sourceHash: sourceDigest.digest('hex'), sourceFiles }
}

export async function buildMetadata(id, root, plan) {
  const projectRoot = await realpath(root)
  const packageRoot = await realpath(
    join(projectRoot, 'examples/parity/node_modules/three-clouds-webgpu')
  )
  if (packageRoot !== projectRoot)
    throw new Error(
      `served package for ${id} resolves to ${packageRoot}, not ${projectRoot}`
    )
  const digest = buildDigest(packageRoot)
  const source = await hashSources(projectRoot)
  const sharedSource = await readFile(join(packageRoot, 'build/shared.js'))
  const lockfile = createHash('sha256')
    .update(await readFile(join(projectRoot, 'pnpm-lock.yaml')))
    .digest('hex')
  return {
    id,
    root: projectRoot,
    servedRoot: packageRoot,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim(),
    ...source,
    supportsExperiments: sharedSource.includes('experimental'),
    lockfileHash: lockfile,
    artifactDigest: digest.digest,
    buildDigest: digest.digest,
    sharedSha256: digest.sharedSha256,
    planFingerprint: planFingerprint(plan)
  }
}

async function startServer(root) {
  const port = await reservePort()
  const parityRoot = join(root, 'examples/parity')
  const require = createRequire(join(parityRoot, 'package.json'))
  const vite = join(
    dirname(require.resolve('vite/package.json')),
    'bin/vite.js'
  )
  const child = spawn(
    process.execPath,
    [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: parityRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  const logs = []
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', chunk => {
      if (logs.length < 32) logs.push(String(chunk).trim())
    })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode != null)
      throw new Error(
        `parity server exited before serving ${url}: ${logs.join(' ')}`
      )
    try {
      const response = await fetch(url)
      if (response.ok) return { child, url }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await stopServer({ child, url })
  throw new Error(`parity server did not start at ${url}: ${logs.join(' ')}`)
}

async function stopServer(server) {
  if (server == null || server.child.exitCode != null) return
  server.child.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      server.child.kill('SIGKILL')
      resolve()
    }, 2_000)
    server.child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function hasExperiments(variant) {
  return Object.values(variant.experimental).some(Boolean)
}

function staticUnsupportedReason(job, buildId, builds = null) {
  if (job.backend === 'webgl' && hasExperiments(job.variant))
    return 'WebGL does not implement port experiments'
  if (
    job.backend === 'webgpu' &&
    hasExperiments(job.variant) &&
    (builds == null
      ? buildId === 'old'
      : builds[buildId]?.supportsExperiments !== true)
  )
    return `${buildId} build does not expose port experiments`
  return null
}

export function expectedRunCounts(plan) {
  const jobs = scheduleFor(plan)
  let unsupported = 0
  for (const job of jobs)
    for (const buildId of ['old', 'new'])
      if (staticUnsupportedReason(job, buildId) != null) unsupported++
  return {
    jobCount: jobs.length,
    totalRuns: jobs.length * 2,
    expectedUnsupported: unsupported,
    expectedSupported: jobs.length * 2 - unsupported
  }
}

async function assertAbsent(file, label) {
  try {
    await access(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Refusing to overwrite ${label}: ${file}`)
}

export async function verifyServedArtifact(
  baseURL,
  environment,
  expectedSha256,
  servedRoot
) {
  const urls = [...new Set(environment.servedLibraryUrls ?? [])]
  if (urls.length === 0)
    throw new Error('browser recorded no served library URLs')
  const origin = new URL(baseURL).origin
  const sharedUrl = urls.find(url => {
    try {
      const parsed = new URL(url)
      return (
        parsed.origin === origin &&
        /\/build\/shared\.js(?:$|\?)/.test(parsed.pathname + parsed.search)
      )
    } catch {
      return false
    }
  })
  if (sharedUrl == null)
    throw new Error('browser did not record a local build/shared.js URL')
  const pathname = decodeURIComponent(new URL(sharedUrl).pathname)
  let requestedPath
  if (pathname.startsWith('/@fs/')) {
    requestedPath = pathname.slice(4)
    if (process.platform === 'win32')
      requestedPath = requestedPath.replace(/^\/(?=[a-z]:\/)/i, '')
  } else if (pathname === '/build/shared.js') {
    requestedPath = join(servedRoot, pathname.slice(1))
  } else throw new Error(`Unrecognized served library path: ${pathname}`)
  const actualPath = await realpath(requestedPath)
  if (actualPath !== (await realpath(join(servedRoot, 'build/shared.js'))))
    throw new Error(`Browser loaded a different library root: ${actualPath}`)
  const response = await fetch(sharedUrl)
  if (!response.ok)
    throw new Error(`served shared.js returned HTTP ${response.status}`)
  const actual = createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex')
  const disk = createHash('sha256')
    .update(await readFile(actualPath))
    .digest('hex')
  if (disk !== expectedSha256)
    throw new Error(
      `served root shared.js digest mismatch: ${disk} != ${expectedSha256}`
    )
  return {
    url: sharedUrl,
    resolvedPath: actualPath,
    sha256: actual,
    diskSha256: disk,
    transformed: actual !== disk
  }
}

export async function runBenchmark({
  plan,
  roots,
  machineLabel,
  checkpointPath,
  browserOptions,
  idleConfirmed = false,
  prepare = true
}) {
  if (plan.profile !== 'smoke' && !idleConfirmed)
    throw new Error(
      'benchmark requires BENCHMARK_IDLE=1 (exclusive idle machine)'
    )
  if (roots?.old == null || roots?.new == null)
    throw new Error('both roots are required: --old-root and --new-root')
  const jobs = scheduleFor(plan)
  if (jobs.length === 0) throw new Error('benchmark plan produced zero jobs')
  const prepared = {}
  for (const id of ['old', 'new'])
    prepared[id] = prepare
      ? await prepareBuild(roots[id])
      : await realpath(roots[id])
  const builds = {
    old: await buildMetadata('old', prepared.old, plan),
    new: await buildMetadata('new', prepared.new, plan)
  }
  const suiteHash = await benchmarkSuiteHash()
  const servers = {}
  let browser = null
  const machine = machineInfo(machineLabel)
  const runs = []
  let checkpointStarted = false
  const checkpoint = async () => {
    if (checkpointPath == null) return
    if (!checkpointStarted) {
      await mkdir(dirname(resolve(checkpointPath)), { recursive: true })
      await writeFile(
        checkpointPath,
        JSON.stringify({
          kind: 'header',
          schemaVersion: plan.schemaVersion,
          protocolVersion: plan.protocolVersion,
          suiteHash,
          createdAt: new Date().toISOString(),
          idleConfirmed,
          publishable: false,
          machine,
          plan,
          builds,
          runs: []
        }) + '\n',
        { flag: 'wx' }
      )
      checkpointStarted = true
    }
    // Append only the completed arm: full matrices must not rewrite gigabytes
    // of previous samples between measurements
    await appendFile(
      checkpointPath,
      JSON.stringify({ kind: 'run', run: runs.at(-1) }) + '\n'
    )
  }
  try {
    for (const id of ['old', 'new'])
      servers[id] = await startServer(prepared[id])
    const needsBrowser = jobs.some(job =>
      ['old', 'new'].some(
        id => staticUnsupportedReason(job, id, builds) == null
      )
    )
    browser = needsBrowser ? await launchBenchmarkBrowser(browserOptions) : null
    if (browser != null && typeof browser.version === 'function')
      machine.browserVersion = await browser.version()
    for (const job of jobs) {
      const buildOrder =
        job.repetition % 2 === 0 ? ['old', 'new'] : ['new', 'old']
      for (
        let buildOrderIndex = 0;
        buildOrderIndex < buildOrder.length;
        buildOrderIndex++
      ) {
        const buildId = buildOrder[buildOrderIndex]
        const base = {
          caseName: job.scene.caseName,
          width: job.scene.width,
          height: job.scene.height,
          dpr: job.scene.dpr,
          motion: job.scene.motion,
          variantId: job.variant.id,
          workloadId: job.scene.workloadId,
          backend: job.backend,
          buildId,
          repetition: job.repetition,
          orderIndex: job.orderIndex,
          buildOrderIndex,
          settings: {
            ...(job.scene.settings ?? {}),
            experimental: job.variant.experimental,
            warmupFrames: plan.warmupFrames,
            sampleFrames: plan.sampleFrames,
            seed: plan.seed
          }
        }
        const unsupported = staticUnsupportedReason(job, buildId, builds)
        if (unsupported != null) {
          runs.push({
            ...base,
            status: 'unsupported',
            reason: unsupported,
            samples: { wallMs: [], renderMs: [], gpuMs: [], computeMs: [] },
            gpuUnavailableReason: unsupported
          })
          await checkpoint()
          continue
        }
        try {
          const result = await runBrowserJob(browser, {
            baseURL: servers[buildId].url,
            scene: job.scene,
            variant: job.variant,
            backend: job.backend,
            warmupFrames: plan.warmupFrames,
            sampleFrames: plan.sampleFrames
          })
          const failedErrors = result.environment.errors ?? []
          if (machine.browser == null)
            machine.browser =
              result.environment.browser ?? result.environment.userAgent
          if (machine.gpu == null)
            machine.gpu =
              result.environment.gpu ??
              result.environment.webgpu ??
              result.environment.webgl
          const served = await verifyServedArtifact(
            servers[buildId].url,
            result.environment,
            builds[buildId].sharedSha256,
            builds[buildId].servedRoot
          )
          runs.push({
            ...base,
            status: failedErrors.length === 0 ? 'ok' : 'failed',
            ...(failedErrors.length > 0
              ? { reason: failedErrors.join('; ') }
              : {}),
            samples: {
              wallMs: result.samples.wallMs.values,
              renderMs: result.samples.renderMs.values,
              gpuMs: result.samples.gpuMs?.values ?? [],
              computeMs: result.samples.computeMs?.values ?? [],
              gpuRenderMs: result.samples.gpuRenderMs?.values ?? [],
              probeMs: result.samples.probeMs?.values ?? []
            },
            clock: clockStability(
              result.samples.gpuMs?.values ?? result.samples.wallMs.values,
              result.samples.probeMs?.values
            ),
            gpuUnavailableReason:
              result.gpuUnavailableReason ?? result.gpuReason ?? null,
            environment: result.environment,
            servedLibrary: served
          })
          const clock = runs.at(-1).clock
          if (!clock.stable)
            console.error(
              `UNSTABLE CLOCK ${base.caseName} ${base.width}x${base.height} ${base.backend}/${base.buildId} rep ${base.repetition}: ${clock.reasons.join('; ')}`
            )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          runs.push({
            ...base,
            status:
              error instanceof BenchmarkUnsupportedError
                ? 'unsupported'
                : 'failed',
            reason,
            samples: { wallMs: [], renderMs: [], gpuMs: [], computeMs: [] }
          })
        }
        await checkpoint()
      }
    }
  } finally {
    await browser?.close()
    await stopServer(servers.old)
    await stopServer(servers.new)
  }
  for (const id of ['old', 'new']) {
    const after = await buildMetadata(id, prepared[id], plan)
    for (const field of [
      'commit',
      'sourceHash',
      'lockfileHash',
      'artifactDigest',
      'sharedSha256'
    ])
      if (after[field] !== builds[id][field])
        throw new Error(`${id} build changed during benchmark (${field})`)
    if (after.sourceFiles.join('\0') !== builds[id].sourceFiles.join('\0'))
      throw new Error(`${id} source file inventory changed during benchmark`)
  }
  const hasOk = runs.some(run => run.status === 'ok')
  if ((await benchmarkSuiteHash()) !== suiteHash)
    throw new Error('Benchmark instrumentation changed during the run')
  return {
    schemaVersion: plan.schemaVersion,
    protocolVersion: plan.protocolVersion,
    suiteHash,
    createdAt: new Date().toISOString(),
    idleConfirmed,
    publishable:
      plan.profile !== 'smoke' &&
      idleConfirmed &&
      hasOk &&
      runs.every(run => run.status !== 'failed'),
    machine,
    plan,
    builds,
    runs
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'old-root': { type: 'string' },
      'new-root': { type: 'string' },
      output: { type: 'string' },
      checkpoint: { type: 'string' },
      plan: { type: 'string' },
      profile: { type: 'string' },
      machine: { type: 'string' },
      headless: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' }
    },
    strict: true,
    allowPositionals: false
  })
  if (values.help) {
    console.log(usage())
    return
  }
  if (values.plan != null && values.profile != null)
    throw new Error('--plan and --profile cannot be combined')
  const plan =
    values.profile != null
      ? makePlan({ profile: values.profile })
      : await loadPlan(values.plan)
  if (values['dry-run']) {
    const jobs = scheduleFor(plan)
    console.log(
      JSON.stringify({ plan, ...expectedRunCounts(plan), jobs }, null, 2)
    )
    return
  }
  const oldRoot = values['old-root']
  const newRoot = values['new-root']
  if (oldRoot == null || newRoot == null) throw new Error(usage())
  const outputFile = values.output
  const checkpointPath =
    values.checkpoint ??
    (outputFile == null ? null : `${outputFile}.checkpoint.jsonl`)
  if (outputFile != null) await assertAbsent(outputFile, 'output')
  if (checkpointPath != null) await assertAbsent(checkpointPath, 'checkpoint')
  if (
    outputFile != null &&
    checkpointPath != null &&
    resolve(checkpointPath) === resolve(outputFile)
  )
    throw new Error('output and checkpoint must be different files')
  const receipt = await runBenchmark({
    plan,
    roots: { old: oldRoot, new: newRoot },
    machineLabel: values.machine,
    checkpointPath,
    browserOptions: { headless: values.headless ?? false },
    idleConfirmed: process.env.BENCHMARK_IDLE === '1'
  })
  if (
    receipt.runs.some(run => run.status === 'failed') ||
    !receipt.runs.some(run => run.status === 'ok')
  )
    process.exitCode = 1
  const serialized = JSON.stringify(receipt, null, 2) + '\n'
  if (outputFile == null) process.stdout.write(serialized)
  else {
    await mkdir(dirname(resolve(outputFile)), { recursive: true })
    await writeFile(outputFile, serialized, { flag: 'wx' })
  }
}

const isMain =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    await main()
  } catch (error) {
    console.error(
      `[benchmark run] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
