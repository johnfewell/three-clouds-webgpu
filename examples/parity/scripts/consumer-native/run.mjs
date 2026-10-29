import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromiumLaunchOptions } from '../../src/e2eSupport/chromeFlags.mjs'
import { runScenario } from './browser.mjs'
import { comparePixels, LIMITS } from './pixels.mjs'
import { hash, insist, verifyReceipt } from './proof.mjs'
import { RECURRENCE_LIMITS } from './sampler.mjs'
import { developmentServer, staticServer } from './servers.mjs'

const [receiptPath, outputPath, ...extra] = process.argv.slice(2)
insist(
  receiptPath && outputPath && extra.length === 0,
  'usage: node examples/parity/scripts/consumer-native/run.mjs CPU_RECEIPT OUTPUT_DIRECTORY'
)
const inputBytes = readFileSync(receiptPath)
const receipt = JSON.parse(inputBytes)
const cases = verifyReceipt(receipt)
const output = resolve(outputPath)
mkdirSync(output, { recursive: true })
const directory = dirname(fileURLToPath(import.meta.url))
const harnessFiles = Object.fromEntries(
  readdirSync(directory)
    .filter(name => name.endsWith('.mjs'))
    .sort()
    .map(name => [name, hash(readFileSync(join(directory, name)))])
)
harnessFiles['../flipFamily.mjs'] = hash(
  readFileSync(join(directory, '../flipFamily.mjs'))
)
harnessFiles['../../src/e2eSupport/chromeFlags.mjs'] = hash(
  readFileSync(join(directory, '../../src/e2eSupport/chromeFlags.mjs'))
)
const evidence = {
  schemaVersion: 1,
  qualification: 'installed-recipes-native-hardware',
  status: 'failed',
  started: new Date().toISOString(),
  cpuReceipt: { path: resolve(receiptPath), sha256: hash(inputBytes) },
  archive: {
    sha256: receipt.archive.sha256,
    contentSha256: receipt.archive.contentSha256,
    filesSha256: receipt.archive.files.sha256
  },
  inputs: receipt.recipes.map(recipe => ({
    name: recipe.name,
    root: recipe.root,
    sources: recipe.sources.sha256,
    installed: recipe.installed.files.sha256,
    versions: recipe.versions,
    lockfileSha256: recipe.lockfileSha256,
    builds: recipe.builds.map(build => ({
      base: build.base,
      root: build.root,
      sha256: build.files.sha256
    }))
  })),
  harnessFiles,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  limits: LIMITS,
  recurrence: RECURRENCE_LIMITS,
  scenarios: [],
  comparisons: []
}
const require = createRequire(new URL('../../package.json', import.meta.url))
const { chromium } = require('@playwright/test')
evidence.playwright = require('@playwright/test/package.json').version
const launch = {
  channel: 'chrome',
  headless: false,
  ...chromiumLaunchOptions(['--enable-unsafe-webgpu'], ['Vulkan'])
}
evidence.launch = launch
let browser
const images = new Map()
const save = () =>
  writeFileSync(
    join(output, 'receipt.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
try {
  browser = await chromium.launch(launch)
  evidence.browser = browser.version()
  for (const scenario of cases) {
    console.log(`Consumer native: ${scenario.id}`)
    const server = await (scenario.development
      ? developmentServer(scenario.recipe)
      : staticServer(scenario.build))
    try {
      const referenceName = `helper-${scenario.build.base === '/' ? 'root' : 'nested'}`
      const reference =
        scenario.mode === 'manual'
          ? {
              image: images.get(referenceName)?.image,
              before: images.get(referenceName)?.before,
              name: referenceName,
              limit: LIMITS.restoreMean
            }
          : undefined
      if (reference != null)
        insist(
          reference.image != null,
          'manual scenario lacks its helper reference'
        )
      const { result, capture } = await runScenario(
        browser,
        scenario,
        server,
        join(output, scenario.id),
        reference
      )
      result.served = server.served
      evidence.scenarios.push(result)
      save()
      insist(result.status === 'passed', `${scenario.id}: ${result.error}`)
      if (capture != null) images.set(scenario.id, capture)
    } finally {
      await server.close()
    }
  }
  for (const base of ['root', 'nested']) {
    const comparison = comparePixels(
      images.get(`helper-${base}`).image,
      images.get(`manual-${base}`).image
    )
    evidence.comparisons.push({ base, ...comparison })
    insist(
      comparison.meanDifference <= LIMITS.restoreMean,
      `helper/manual ${base} output differs`
    )
  }
  insist(
    evidence.scenarios.length === 7 && evidence.comparisons.length === 2,
    'incomplete native scenario matrix'
  )
  verifyReceipt(receipt)
  for (const [name, digest] of Object.entries(harnessFiles))
    insist(
      hash(readFileSync(join(directory, name))) === digest,
      `harness changed during run: ${name}`
    )
  insist(
    hash(readFileSync(receiptPath)) === evidence.cpuReceipt.sha256,
    'CPU receipt changed during native run'
  )
  evidence.immutableInputsRechecked = true
  evidence.status = 'passed'
} catch (error) {
  evidence.error = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  await browser?.close()
  evidence.finished = new Date().toISOString()
  save()
  console.log(
    `Consumer native: ${evidence.status}; ${join(output, 'receipt.json')}`
  )
}
