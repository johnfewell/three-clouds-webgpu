// The instrument: one port story under arg
// variants (fresh context each), reading the camera pose and sun from
// window.__cloudsStory and scoring the screenshot (row-profile orientation O,
// horizon row, peak row, sun blob). Frames from different poses do not compare
//   node scripts/ydz3.mjs clouds-webgpu-clouds--basic ydz3 [waitMs] [variant;variant…]
import { writeFileSync } from 'node:fs'
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

const [storyId, prefix, waitMs = '15000', variantList] = process.argv.slice(2)
if (storyId == null || prefix == null) {
  console.error(
    'usage: node scripts/ydz3.mjs <story-id> <prefix> [waitMs] [variant;variant…]'
  )
  process.exit(1)
}
const variants =
  variantList != null
    ? variantList.split('|')
    : [
        '',
        'temporalUpscale:false',
        'cloudsEnabled:false',
        'temporalUpscale:false;cloudsEnabled:false',
        'debug:uv',
        'temporalUpscale:false;debug:uv'
      ]
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6006'
const viewport = { width: 1440, height: 900 }

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan']
})

// Runs in the page: decode a screenshot (a plain PNG, not the WebGPU canvas,
// which drawImage reads as black) and reduce it
const analyse = async (page, pngBase64) =>
  page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const w = img.width
    const h = img.height
    const { data } = g.getImageData(0, 0, w, h)
    const x0 = Math.floor(w * 0.2)
    const x1 = Math.floor(w * 0.8)
    const rows = new Array(h).fill(0)
    let best = { v: -1, row: 0, col: 0 }
    for (let y = 0; y < h; y++) {
      let s = 0
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4
        s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      }
      rows[y] = s / (x1 - x0)
    }
    // brightest 3×3 mean anywhere (the sun disc when in frame)
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        let s = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = ((y + dy) * w + x + dx) * 4
            s += data[i] + data[i + 1] + data[i + 2]
          }
        }
        if (s > best.v) best = { v: s, row: y, col: x }
      }
    }
    const k = 9
    const sm = rows.map((_, y) => {
      let s = 0
      let n = 0
      for (let d = -(k >> 1); d <= k >> 1; d++) {
        if (y + d >= 0 && y + d < h) {
          s += rows[y + d]
          n++
        }
      }
      return s / n
    })
    let hRow = 0
    let minG = Infinity
    for (let y = 0; y + 1 < h; y++) {
      const gy = sm[y + 1] - sm[y]
      if (gy < minG) {
        minG = gy
        hRow = y
      }
    }
    let peakRow = 0
    for (let y = 0; y < h; y++) if (rows[y] > rows[peakRow]) peakRow = y
    return {
      rows,
      hRow,
      peakRow,
      sun: { row: best.row, col: best.col, v: best.v / 27 }
    }
  }, pngBase64)

const corr = (u, v) => {
  const n = u.length
  const mu = u.reduce((a, b) => a + b, 0) / n
  const mv = v.reduce((a, b) => a + b, 0) / n
  let su = 0
  let sv = 0
  let suv = 0
  for (let i = 0; i < n; i++) {
    su += (u[i] - mu) ** 2
    sv += (v[i] - mv) ** 2
    suv += (u[i] - mu) * (v[i] - mv)
  }
  return suv / Math.sqrt(su * sv)
}

const readPose = page =>
  page.evaluate(() => {
    const s = window.__cloudsStory
    if (s == null) return null
    const p = s.camera.position
    const r = Math.hypot(p.x, p.y, p.z)
    const up = { x: p.x / r, y: p.y / r, z: p.z / r }
    const e = s.camera.matrixWorld.elements
    // forward = −Z column of matrixWorld
    const f = { x: -e[8], y: -e[9], z: -e[10] }
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
    const deg = 180 / Math.PI
    const sun = s.atmosphereContext.sunDirectionECEF.value
    return {
      // spherical, for comparing two loads, not a geodetic height
      height_km: +(r / 1000 - 6371).toFixed(3),
      pitch_deg: +(Math.asin(dot(f, up)) * deg).toFixed(2),
      sunElev_deg: +(Math.asin(dot(sun, up)) * deg).toFixed(2),
      fov: s.camera.fov,
      temporalUpscale: s.cloudsContext.temporalUpscale,
      enabled: s.cloudsContext.enabled,
      debug: s.cloudsContext.debug,
      frame: s.cloudsContext.frame,
      graphVersion: s.cloudsContext.graphVersion
    }
  })

const results = []
for (const variant of variants) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = new Set()
  page.on('console', m => {
    if (m.type() === 'error') errors.add(m.text().slice(0, 160))
  })
  const url =
    `${base}/iframe.html?id=${storyId}&viewMode=story&hidePanel=1` +
    (variant ? `&args=${encodeURIComponent(variant)}` : '')
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(+waitMs)
  const pose = await readPose(page)
  const png = await page.screenshot()
  const name = `${prefix}-${variant.replace(/[^a-z0-9]+/gi, '_') || 'default'}.png`
  writeFileSync(name, png)
  const m = await analyse(page, png.toString('base64'))
  results.push({ variant, name, pose, m, errors: [...errors] })
  await context.close()
}
await browser.close()

const ref = results[0].m.rows
console.log(
  `story ${storyId}  viewport ${viewport.width}x${viewport.height}  wait ${waitMs} ms`
)
for (const r of results) {
  const O = corr(r.m.rows, ref) - corr(r.m.rows, [...ref].reverse())
  const p = r.pose
  console.log(
    `${(r.variant || '(default)').padEnd(44)} O ${O.toFixed(3).padStart(6)}  hRow ${String(r.m.hRow).padStart(3)}  peakRow ${String(r.m.peakRow).padStart(3)}  sun (${r.m.sun.row},${r.m.sun.col}) ${r.m.sun.v.toFixed(0)}` +
      (p
        ? `  | pose: h ${p.height_km} km  pitch ${p.pitch_deg}°  sunElev ${p.sunElev_deg}°  fov ${p.fov}  upscale ${p.temporalUpscale}  enabled ${p.enabled}  debug ${p.debug}  frame ${p.frame}  graph v${p.graphVersion}`
        : '  | pose: (no __cloudsStory handle)') +
      (r.errors.length
        ? `  | ${r.errors.length} console error(s): ${r.errors[0]}`
        : '')
  )
}
