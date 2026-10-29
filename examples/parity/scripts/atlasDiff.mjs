// Read-only shadow-atlas comparison: side A's raw atlas against side B's, per
// cascade and per channel, at one case's own pose and sun. Never
// writes parity/results, and the channel conventions that make the raw values
// non-comparable without saying so are in examples/parity/README.md
//
// Usage: PARITY_URL=http://host:PORT node scripts/atlasDiff.mjs <case> [out]

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const example = join(root, 'examples/parity')
const caseName = process.argv[2] ?? 'shadow-cascades-2x512'
const output =
  process.argv[3] ?? join(root, 'test-results/atlas-diff', caseName)
const base = process.env.PARITY_URL ?? 'http://127.0.0.1:4174'
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname))

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})
const errors = []
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.setDefaultTimeout(120000)
  await page.goto(`${base}/?case=${encodeURIComponent(caseName)}&e2e=1`)
  await page.waitForFunction(() => window.__parity != null)
  const result = await page.evaluate(async () => {
    const { cases } = await import('/cases/index.ts')
    const pc = cases.find(value => value.name === window.__parity.caseName)
    if (!pc) throw new Error('Unknown case')
    for (const side of ['A', 'B'])
      await window.__parity.renderOnce(side, {
        time: 0,
        frame: 0,
        warmup: pc.warmup ?? 64
      })
    const A = window.__parity.readShadowAtlasA()
    const B = await window.__parity.readShadowAtlas()
    const knobs = await window.__parity.readShadowKnobs()
    return {
      caseName: window.__parity.caseName,
      warmup: pc.warmup ?? 64,
      sun: pc.sun,
      pose: pc.pose,
      state: pc.state,
      knobs,
      A: {
        width: A.width,
        height: A.height,
        depth: A.depth,
        temporalPass: A.temporalPass,
        source: A.source,
        maxShadowRayExtentUnit: A.maxShadowRayExtentUnit,
        layers: A.layers.map(layer => Array.from(layer.data)),
        rayExtent: A.rayExtents.extent.map(field => Array.from(field.data))
      },
      B: {
        width: B.width,
        height: B.height,
        depth: B.depth,
        temporalPass: B.temporalPass,
        source: B.source,
        maxShadowRayExtentUnit: B.maxShadowRayExtentUnit,
        layers: B.layers.map(layer => Array.from(layer.data)),
        rayExtent: B.rayExtents.extent.map(field => Array.from(field.data))
      },
      bottomRadius:
        window.__parity.sideBHandle?.cloudsContext?.bottomRadius ?? null
    }
  })
  assert.deepEqual(errors, [])
  assert(result.A.depth > 0 && result.A.depth === result.B.depth)
  assert.equal(result.A.width, result.B.width)
  assert.equal(result.A.height, result.B.height)
  await mkdir(output, { recursive: true })
  await writeFile(
    join(output, 'atlas-pair.json'),
    JSON.stringify(result) + '\n'
  )
  console.log(output)
} finally {
  await browser.close()
}
