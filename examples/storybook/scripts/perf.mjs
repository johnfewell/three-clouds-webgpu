// Perceived performance A/B: rAF frame times of the WebGL and port stories at
// one viewport and DPR after a settle, fresh context each, leva hidden. Two
// modes: vsync-capped (what a user feels) and uncapped (--disable-gpu-vsync
// --disable-frame-rate-limit, the headroom the cap hides)
//   node scripts/perf.mjs <webgl-story-id> <webgpu-story-id> [width] [height] [dpr] [settleMs] [sampleMs]
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const parity = join(here, '../../parity')
const playwright = createRequire(join(parity, 'package.json')).resolve(
  '@playwright/test/package.json'
)
const { chromium } = await import(
  pathToFileURL(join(dirname(playwright), 'index.mjs'))
)
const [
  webglId,
  webgpuId,
  width = '1440',
  height = '900',
  dpr = '2',
  settleMs = '8000',
  sampleMs = '6000',
  extraB = ''
] = process.argv.slice(2)
if (webglId == null || webgpuId == null) {
  console.error(
    'usage: node scripts/perf.mjs <webgl-story-id> <webgpu-story-id> [width] [height] [dpr] [settleMs] [sampleMs]'
  )
  process.exit(1)
}
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6006'
const baseArgs = ['--enable-unsafe-webgpu', '--enable-features=Vulkan']

const sample = page =>
  page.evaluate(
    ms =>
      new Promise(resolve => {
        const deltas = []
        let last = performance.now()
        const start = last
        const tick = now => {
          deltas.push(now - last)
          last = now
          if (now - start < ms) requestAnimationFrame(tick)
          else resolve(deltas.slice(1))
        }
        requestAnimationFrame(tick)
      }),
    +sampleMs
  )

const summarise = d => {
  const s = [...d].sort((a, b) => a - b)
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const mean = d.reduce((a, b) => a + b, 0) / d.length
  return { n: d.length, median: q(0.5), p95: q(0.95), mean, fps: 1000 / q(0.5) }
}

const results = []
const modes =
  process.env.PERF_MODES === 'uncapped'
    ? [true]
    : process.env.PERF_MODES === 'vsync'
      ? [false]
      : [false, true]
for (const uncapped of modes) {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: uncapped
      ? [...baseArgs, '--disable-gpu-vsync', '--disable-frame-rate-limit']
      : baseArgs
  })
  for (const [id, side] of [
    [webglId, 'A'],
    [webgpuId, 'B']
  ]) {
    // skip a side
    if (id === '-') continue
    const context = await browser.newContext({
      viewport: { width: +width, height: +height },
      deviceScaleFactor: +dpr
    })
    const page = await context.newPage()
    const errors = []
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 160))
    })
    page.on('pageerror', e =>
      errors.push(`pageerror: ${String(e).slice(0, 160)}`)
    )
    await page.goto(
      `${base}/iframe.html?id=${id}&viewMode=story&hidePanel=1${side === 'B' ? extraB : ''}`,
      { waitUntil: 'load' }
    )
    await page.waitForTimeout(+settleMs)
    const stats = summarise(await sample(page))
    results.push({
      mode: uncapped ? 'uncapped' : 'vsync',
      side,
      id,
      ...stats,
      errors
    })
    await context.close()
  }
  await browser.close()
}
console.log(
  `viewport ${width}x${height} @ dpr ${dpr} (${width * dpr}x${height * dpr} px)  settle ${settleMs} ms  sample ${sampleMs} ms`
)
for (const r of results) {
  console.log(
    `${r.mode.padEnd(9)} ${r.side} ${r.id.padEnd(36)} frames ${String(r.n).padStart(4)}  median ${r.median.toFixed(2).padStart(7)} ms  p95 ${r.p95.toFixed(2).padStart(7)} ms  mean ${r.mean.toFixed(2).padStart(7)} ms  → ${r.fps.toFixed(1).padStart(6)} fps` +
      (r.errors.length ? `  | ${r.errors.length} error(s): ${r.errors[0]}` : '')
  )
}
