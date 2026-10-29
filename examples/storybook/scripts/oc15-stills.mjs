// Stills and a GPU cost check for the seeded weather map
// DPR 2 at 2874x1794, baseline and opt-in from the same camera, then the same
// measurement again per pattern so the cost is attributed

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')
const require = createRequire(join(here, '../../parity/package.json'))
const playwright = dirname(require.resolve('@playwright/test/package.json'))
const { chromium } = await import(pathToFileURL(join(playwright, 'index.mjs')))
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6115'
const output = join(root, 'test-results/oc15-stills')
await mkdir(output, { recursive: true })

const DPR = 2
const VIEWPORT = { width: 1437, height: 897 }

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})

async function settle(frame, frames = 48) {
  const start = await frame.evaluate(
    () => window.__cloudsStory.cloudsContext.frame
  )
  await frame.waitForFunction(
    target => window.__cloudsStory?.cloudsContext.frame >= target,
    start + frames,
    { timeout: 120000 }
  )
}

/** Frame rate over N frames, on the live canvas */
async function measureFps(frame, frames = 90) {
  return frame.evaluate(async count => {
    const context = window.__cloudsStory.cloudsContext
    const start = context.frame
    const wall = performance.now()
    await new Promise(resolve => {
      const tick = () => {
        if (context.frame >= start + count) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const elapsed = performance.now() - wall
    const frames = context.frame - start
    return { frames, ms: elapsed, fps: (frames / elapsed) * 1000 }
  }, frames)
}

async function readback(frame) {
  return frame.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const context = canvas.getContext('webgpu')
    return {
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      context: context ? 'webgpu' : 'none'
    }
  })
}

const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: DPR
})
const errors = []
const network404 = []
page.on('response', r => {
  if (r.status() >= 400) network404.push(`${r.status()} ${r.url()}`)
})
page.on('requestfailed', r => network404.push(`failed ${r.url()}`))
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => {
  if (m.type() !== 'error') return
  // Storybook's own /favicon.ico 404. Storybook plumbing, not the renderer
  if (m.location().url.endsWith('/favicon.ico')) return
  errors.push(`${m.text()} @ ${JSON.stringify(m.location())}`)
})

// The iframe directly, not through the manager: the manager pane narrows the
// preview, and the still has to be 2874x1794 backing at DPR 2
const VIEW = `?id=clouds-webgpu-experiments--procedural-weather&viewMode=story`
await page.goto(`${base}/iframe.html${VIEW}`)
const frame = page
await frame.waitForFunction(
  () => window.__cloudsStory?.cloudsContext.frame > 32,
  null,
  {
    timeout: 120000
  }
)

const geometry = await readback(frame)
console.log('canvas', JSON.stringify(geometry))
assert(
  geometry.backingWidth === VIEWPORT.width * DPR,
  `DPR ${DPR} not in effect: backing ${geometry.backingWidth} for ${VIEWPORT.width} css`
)
assert(geometry.context === 'webgpu', 'No WebGPU canvas')

const results = { geometry, off: null, on: null, patterns: {} }

// Baseline: the flag off, the baked PNG
await frame.evaluate(() => {
  window.__cloudsStory.cloudsContext.experimental.proceduralWeather = false
})
await settle(frame)
await page.screenshot({ path: join(output, '00-baseline.png') })
results.off = await measureFps(frame)
console.log('OFF  ', JSON.stringify(results.off))

// Opt-in, default patterns (low/mid clumps, high bands)
await frame.evaluate(() => {
  window.__cloudsStory.cloudsContext.experimental.proceduralWeather = true
})
await settle(frame)
await page.screenshot({ path: join(output, '01-defaults.png') })
results.on = await measureFps(frame)
console.log('ON   ', JSON.stringify(results.on))

// Per pattern on the HIGH channel, driven through the URL args so the control
// is the story's own. Each shot reads the generator back first, since a shot
// over a null generator is a still of the baked PNG and looks like a pattern
for (const pattern of ['bands', 'clumps', 'scattered']) {
  await frame.goto(
    `${base}/iframe.html${VIEW}&args=weatherHighPattern:${pattern}`
  )
  await frame.waitForFunction(
    () => window.__cloudsStory?.cloudsContext.frame > 32,
    null,
    { timeout: 120000 }
  )
  // The story passes its own generator, so ctx.proceduralWeather is null by
  // design. What is bound is localWeatherTexture
  await frame.waitForFunction(
    () => window.__cloudsStory?.cloudsContext.localWeatherTexture?.seed != null,
    null,
    { timeout: 120000 }
  )
  await settle(frame)
  const read = await frame.evaluate(() => {
    const weather = window.__cloudsStory.cloudsContext.localWeatherTexture
    return {
      seed: weather.seed,
      bands: weather.bands.toArray(),
      coverage: weather.coverage.toArray(),
      size: weather.texture.image.width
    }
  })
  assert(read.seed != null, `No generator for ${pattern}`)
  await page.screenshot({ path: join(output, `02-high-${pattern}.png`) })
  results.patterns[pattern] = await measureFps(frame)
  console.log(
    'PATTERN',
    pattern,
    JSON.stringify(read),
    JSON.stringify(results.patterns[pattern])
  )
}

console.log('errors', JSON.stringify(errors))
console.log('network404', JSON.stringify(network404))
assert.deepEqual(errors, [], 'Browser errors')

await browser.close()
console.log('DONE', JSON.stringify(results))
