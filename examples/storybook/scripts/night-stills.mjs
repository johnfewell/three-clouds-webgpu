// Stills and a cost A/B for the night sky: the stock sky, the sky
// with takram's moon and stars behind the clouds, and the same sky with
// experimental.moonlight lighting the clouds. Every arm is driven through
// window.__cloudsStory, so the frame that is screenshotted is the frame that
// was measured. Refresh cap lifted, or every arm reads 16.7 ms.
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
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6135'
const output = process.env.STILLS_DIR ?? join(root, 'test-results/night-stills')
await mkdir(output, { recursive: true })

const DPR = Number(process.env.STILLS_DPR ?? 2)
const VIEWPORT = { width: 1437, height: 897 }
const FRAMES = Number(process.env.STILLS_FRAMES ?? 90)

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    // The cost arms need this. With the cap on, every arm is 16.7 ms
    ...(process.env.STILLS_VSYNC === '1'
      ? []
      : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])
  ]
})

const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: DPR
})
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => {
  if (m.type() !== 'error') return
  // Storybook's own /favicon.ico 404. Plumbing, not the renderer
  if (m.location().url.endsWith('/favicon.ico')) return
  errors.push(`${m.text()} @ ${JSON.stringify(m.location())}`)
})
const failedRequests = []
page.on('requestfailed', r =>
  failedRequests.push(`${r.failure()?.errorText} ${r.url()}`)
)

async function settle(frame, frames = 64) {
  const start = await frame.evaluate(
    () => window.__cloudsStory.cloudsContext.frame
  )
  await frame.waitForFunction(
    target => window.__cloudsStory?.cloudsContext.frame >= target,
    start + frames,
    { timeout: 180000 }
  )
}

/** Frame intervals over N frames, sorted, so the median and p90 are honest */
async function frameStats(frame, count = FRAMES) {
  return frame.evaluate(async n => {
    const context = window.__cloudsStory.cloudsContext
    const start = context.frame
    const stamps = []
    await new Promise(resolve => {
      const tick = () => {
        stamps.push(performance.now())
        if (context.frame >= start + n) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const intervals = []
    for (let i = 1; i < stamps.length; i++)
      intervals.push(stamps[i] - stamps[i - 1])
    intervals.sort((a, b) => a - b)
    const at = q =>
      intervals[
        Math.min(intervals.length - 1, Math.floor(q * intervals.length))
      ]
    return {
      frames: context.frame - start,
      samples: intervals.length,
      median: at(0.5),
      p90: at(0.9)
    }
  }, count)
}

const ARMS = [
  {
    name: '00-stock-sky',
    note: 'sun down, no stars, no moon in the sky, moonlight off',
    set: () => {
      const ctx = window.__cloudsStory.cloudsContext
      ctx.experimental = { moonlight: false }
    }
  },
  {
    name: '01-stars-and-moon',
    note: "the same frame with takram's sky: moon disc, stars, lunar scattering",
    set: () => {
      window.__cloudsStory.cloudsContext.experimental = { moonlight: false }
    }
  },
  {
    name: '02-moonlit-clouds',
    note: 'and experimental.moonlight retargeting the march light onto the moon',
    set: () => {
      window.__cloudsStory.cloudsContext.experimental = { moonlight: true }
    }
  }
]

// Two page loads: the first carries the stock sky (the story's own args), the
// second turns the night sky on, which is a prop on the shared post-processing
// helper and so needs the args the story declares
const VIEW = '?id=clouds-webgpu-night--night&viewMode=story'

async function open(query) {
  await page.goto(`${base}/iframe.html${VIEW}${query}`)
  await page.waitForFunction(
    () => window.__cloudsStory?.cloudsContext.frame > 32,
    null,
    { timeout: 180000 }
  )
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    return {
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      context: canvas.getContext('webgpu') ? 'webgpu' : 'none'
    }
  })
  assert(
    geometry.backingWidth === VIEWPORT.width * DPR,
    `DPR ${DPR} not in effect: backing ${geometry.backingWidth}`
  )
  assert(geometry.context === 'webgpu', 'no WebGPU canvas')
  return geometry
}

const results = {
  view: VIEW,
  dpr: DPR,
  vsync: process.env.STILLS_VSYNC === '1',
  arms: {}
}

const geometry = await open('')
console.log('canvas', JSON.stringify(geometry))

for (const arm of ARMS) {
  await page.evaluate(arm.set)
  await settle(page)
  // The state the shot claims, read back from the page
  const state = await page.evaluate(() => {
    const { cloudsContext } = window.__cloudsStory
    return {
      moonlight: cloudsContext.experimental.moonlight,
      moonGain: cloudsContext.moonGain,
      lightDirection: cloudsContext.lightDirection.toArray(),
      moonIrradianceRatio: cloudsContext.moonIrradianceRatio.toArray(),
      sunDirection: cloudsContext.sunDirection.toArray(),
      frame: cloudsContext.frame
    }
  })
  await page.screenshot({ path: join(output, `${arm.name}.png`) })
  const timing = await frameStats(page)
  results.arms[arm.name] = { note: arm.note, state, timing }
  console.log(arm.name, JSON.stringify({ state, timing }))
}

// The night sky needs its own load: it is a prop, not a runtime toggle
await open('&args=nightSky:true')
await settle(page)
await page.evaluate(() => {
  window.__cloudsStory.cloudsContext.experimental = { moonlight: false }
})
await settle(page)
await page.screenshot({ path: join(output, '10-stars-and-moon.png') })
const skyTiming = await frameStats(page)
results.arms['10-stars-and-moon'] = {
  note: 'stars and the moon disc behind the clouds, moonlight off',
  timing: skyTiming
}
console.log('10-stars-and-moon', JSON.stringify({ timing: skyTiming }))

await page.evaluate(() => {
  window.__cloudsStory.cloudsContext.experimental = { moonlight: true }
})
await settle(page)
await page.screenshot({ path: join(output, '11-moonlit-clouds.png') })
const litTiming = await frameStats(page)
const litState = await page.evaluate(() => {
  const { cloudsContext } = window.__cloudsStory
  return {
    moonlight: cloudsContext.experimental.moonlight,
    moonGain: cloudsContext.moonGain,
    moonIrradianceRatio: cloudsContext.moonIrradianceRatio.toArray()
  }
})
results.arms['11-moonlit-clouds'] = {
  note: 'the same frame with the march light on the moon',
  state: litState,
  timing: litTiming
}
console.log(
  '11-moonlit-clouds',
  JSON.stringify({ state: litState, timing: litTiming })
)

// The control for the cost: the option OFF and the sun moved to where the moon
// was, 14.5 degrees up instead of 21 down. Same graph as the off arm, so the
// difference is what a light above the horizon costs in the existing march
await page.evaluate(() => {
  const { cloudsContext } = window.__cloudsStory
  const cam = cloudsContext.cameraUniforms.cameraPositionECEF.value
  const len = Math.hypot(cam.x, cam.y, cam.z) || 1
  const up = { x: cam.x / len, y: cam.y / len, z: cam.z / len }
  const moon = cloudsContext.moonDirection.clone().normalize()
  // Keep the moon's azimuth, put it at +14.5 degrees of elevation
  const el = (14.5 * Math.PI) / 180
  const flat = Math.sqrt(Math.max(1 - moon.dot(up) ** 2, 0))
  cloudsContext.sunDirection
    .set(
      moon.x * flat * Math.cos(el) + up.x * Math.sin(el),
      moon.y * flat * Math.cos(el) + up.y * Math.sin(el),
      moon.z * flat * Math.cos(el) + up.z * Math.sin(el)
    )
    .normalize()
})
await settle(page)
await page.screenshot({ path: join(output, '20-control-sun-up.png') })
const controlTiming = await frameStats(page)
results.arms['20-control-sun-up'] = {
  note: 'moonlight OFF, the sun moved to 14.5 degrees up: the cost of a light above the horizon with no moonlight involved',
  timing: controlTiming
}
console.log('20-control-sun-up', JSON.stringify({ timing: controlTiming }))

results.errors = errors
results.failedRequests = failedRequests
const report = join(output, 'report.json')
const { writeFileSync } = await import('node:fs')
writeFileSync(report, `${JSON.stringify(results, null, 2)}\n`)
console.log('report', report)
console.log('console errors', errors.length, errors.slice(0, 5))
console.log(
  'failed requests',
  failedRequests.length,
  failedRequests.slice(0, 5)
)

await browser.close()
