// Read-only diagnostic, not a replacement for the phase acceptance capture
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

import { validateThresholds } from '../cases/thresholdSchema.mjs'
import { evaluate, METRICS_VERSION } from '../src/metrics/evaluator.mjs'
import { writeLinearReadbacks } from './captureLinear.mjs'
import {
  captureProvenance,
  refuseUnlessServedIsAncestor,
  refuseUnlessServedIsBuilt,
  refuseUnlessServedIsSelf
} from './captureProvenance.mjs'
import { ensureFreshBuild } from './freshBuild.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const example = join(root, 'examples/parity')
const base = process.env.PARITY_URL ?? 'http://localhost:4174'
assert(
  ['localhost', '127.0.0.1'].includes(new URL(base).hostname),
  'Local server required'
)
ensureFreshBuild('maintainer-review', { requireGreenE2e: true })
const provenance = captureProvenance({
  projectRoot: root,
  exampleRoot: example,
  packageName: 'three-clouds-webgpu'
})
refuseUnlessServedIsBuilt(provenance, 'three-clouds-webgpu')
refuseUnlessServedIsSelf(provenance, root)
refuseUnlessServedIsAncestor(provenance, provenance.git.commit, root)
const thresholds = validateThresholds(
  JSON.parse(await readFile(join(example, 'cases/thresholds.json'), 'utf8'))
)
const output = join(
  root,
  'test-results/maintainer/parity',
  new Date().toISOString().replaceAll(':', '-')
)
await mkdir(output, { recursive: true })
const localAssets = {
  'stars.bin': join(
    example,
    'node_modules/@takram/three-atmosphere/assets/stars.bin'
  ),
  'stbn.bin': join(root, 'test/fixtures/experimental/stbn.bin')
}
const assetHashes = {}
for (const [name, path] of Object.entries(localAssets)) {
  assetHashes[name] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})
const report = {
  complete: false,
  node: process.version,
  diagnosticOnly: true,
  provenance,
  assetHashes,
  metricsVersion: METRICS_VERSION,
  browser: browser.version(),
  results: []
}
async function measureInPage(lightShafts) {
  const cases = await import('/cases/index.ts')
  const pc = cases.cases.find(value => value.name === 'shafts-inside-deck')
  if (!pc) throw new Error('Missing case')
  const p = window.__parity
  if (!lightShafts) p.setLightShafts(false)
  for (const side of ['A', 'B'])
    await p.renderOnce(side, {
      time: 0,
      frame: 0,
      warmup: pc.warmup ?? 64
    })
  const a = await p.readLinear('A')
  const b = await p.readLinear('B')
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.data.length === 0 ||
    a.data.length !== b.data.length
  )
    throw new Error('Invalid readback dimensions')
  const m = await import('/src/metrics/index.ts')
  const de = m.computeDeltaE(a.data, b.data, a.width, a.height, 4)
  const encode = data =>
    new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result.split(',')[1])
      reader.readAsDataURL(new Blob([data]))
    })
  return {
    width: a.width,
    height: a.height,
    warmup: pc.warmup ?? 64,
    ssim: m.computeSSIM(a.data, b.data, a.width, a.height, 4),
    deMean: de.deMean,
    deP95: de.deP95,
    histDist: m.computeHistogramDistance(a.data, b.data, a.width, a.height, 4),
    plate: {
      A: m.computePlateStats(a.data, 4),
      B: m.computePlateStats(b.data, 4)
    },
    a64: await encode(a.data),
    b64: await encode(b.data)
  }
}

async function capture(repeat, shafts) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  })
  const errors = []
  const routes = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    const asset = url.pathname.split('/').at(-1)
    if (localAssets[asset]) {
      routes.push(asset)
      return route.fulfill({ path: localAssets[asset] })
    }
    if (url.pathname.endsWith('/favicon.ico'))
      return route.fulfill({ status: 204, body: '' })
    if (
      url.origin === new URL(base).origin ||
      ['data:', 'blob:'].includes(url.protocol)
    )
      return route.continue()
    errors.push(`Blocked egress: ${url.origin}${url.pathname}`)
    return route.abort()
  })
  try {
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.setDefaultTimeout(120000)
    await page.goto(`${base}/?case=shafts-inside-deck&e2e=1`)
    await page.waitForFunction(() => window.__parity != null)
    const result = await page.evaluate(measureInPage, shafts)
    assert.deepEqual(errors, [], 'Diagnostic browser errors')
    for (const key of ['ssim', 'deMean', 'deP95', 'histDist']) {
      assert(Number.isFinite(result[key]), `Missing metric: ${key}`)
    }
    const dir = join(output, `${repeat}-${shafts ? 'baseline' : 'shafts-off'}`)
    await mkdir(dir)
    writeLinearReadbacks(dir, result)
    delete result.a64
    delete result.b64
    const verdict = evaluate(
      result,
      thresholds.phases['3'],
      'shafts-inside-deck',
      thresholds.accepted,
      {
        minStd: thresholds.plate?.minStd ?? 0.002,
        minCloudFraction: thresholds.plate?.minCloudFraction ?? 0.0005,
        plate: result.plate
      }
    )
    await page.screenshot({
      path: join(dir, 'comparison.png'),
      fullPage: true
    })
    const row = { repeat, shafts, ...result, verdict, routes }
    report.results.push(row)
    console.log(JSON.stringify(row))
    await writeFile(
      join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n'
    )
  } finally {
    await context.close()
  }
}

try {
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const shafts of [true, false]) await capture(repeat, shafts)
  }
  assert.equal(report.results.length, 6, 'Incomplete diagnostic')
  report.complete = true
} finally {
  await browser.close()
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
}
