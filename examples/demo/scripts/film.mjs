#!/usr/bin/env node
// Record a demo film shot frame-locked on the hardware GPU. Usage and the
// shot list: examples/demo/src/film/README.md
import { spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

// The workspace installs Playwright for the parity harness only
const { chromium } = createRequire(
  new URL('../../parity/package.json', import.meta.url)
)('@playwright/test')

const { values } = parseArgs({
  options: {
    shot: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:5241/' },
    out: { type: 'string', default: 'film-out' },
    fps: { type: 'string', default: '60' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
    dpr: { type: 'string', default: '2' },
    stills: { type: 'string' },
    video: { type: 'boolean', default: false },
    warmup: { type: 'string', default: '90' },
    bitrate: { type: 'string', default: '120e6' },
    frames: { type: 'string' },
    headed: { type: 'boolean', default: false },
    // Extra query string for scouting overrides, e.g. tod=0.78&exp=12
    query: { type: 'string', default: '' },
    tag: { type: 'string', default: '' }
  }
})

if (values.shot == null) {
  console.error('film: --shot <id> is required')
  process.exit(2)
}
if (values.stills == null && !values.video) {
  console.error('film: nothing to do, pass --stills and/or --video')
  process.exit(2)
}

const shot = values.shot
const stem = values.tag === '' ? shot : `${shot}_${values.tag}`
const fps = Number(values.fps)
const out = resolve(values.out)
mkdirSync(out, { recursive: true })

// Real Chrome: the bundled headless shell loses the WebGPU device here
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !values.headed,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ]
})
const context = await browser.newContext({
  viewport: { width: Number(values.width), height: Number(values.height) },
  deviceScaleFactor: Number(values.dpr)
})
const page = await context.newPage()
const consoleLines = []
page.on('console', msg => {
  const line = `[${msg.type()}] ${msg.text()}`
  if (msg.type() === 'error' || msg.type() === 'warning')
    consoleLines.push(line)
  if (msg.type() === 'error') console.error(line)
})
page.on('pageerror', error => {
  consoleLines.push(`[pageerror] ${error.message}`)
  console.error('[pageerror]', error.message)
})

const streamPath = join(out, `${stem}.h264`)
let stream = null
let chunkCount = 0
await page.exposeFunction('__filmSink', (base64, _key, _timestamp) => {
  stream?.write(Buffer.from(base64, 'base64'))
  ++chunkCount
})

const url = new URL(values.url)
url.searchParams.set('film', shot)
url.searchParams.set('fps', String(fps))
for (const [key, value] of new URLSearchParams(values.query)) {
  url.searchParams.set(key, value)
}
const started = Date.now()
await page.goto(url.toString())
await page.waitForFunction(
  () => {
    const state = window.__demo?.getState()
    return (
      window.__film != null &&
      state != null &&
      state.texturesReady &&
      state.oceanReady
    )
  },
  null,
  { timeout: 120_000, polling: 250 }
)

const info = await page.evaluate(() => window.__film.info())
console.log('[film]', JSON.stringify(info))
if (info.id !== shot)
  throw new Error(`film: page loaded ${info.id}, not ${shot}`)

await page.evaluate(w => window.__film.prepare(w), Number(values.warmup))
console.log(
  `[film] prepared in ${((Date.now() - started) / 1000).toFixed(1)} s`
)

const frameCount =
  values.frames != null ? Number(values.frames) : info.frameCount
let rendered = -1

async function renderTo(index, capture) {
  return page.evaluate(([i, c]) => window.__film.frame(i, c), [index, capture])
}

if (values.stills != null) {
  const times = values.stills.split(',').map(Number)
  const lead = Math.round(fps / 2)
  for (const time of times) {
    const target = Math.min(frameCount - 1, Math.round(time * fps))
    const from = Math.max(rendered + 1, target - lead)
    for (let i = from; i < target; ++i) await renderTo(i, 'none')
    const dataUrl = await renderTo(target, 'png')
    rendered = target
    const file = join(out, `${stem}_t${time.toFixed(1).padStart(4, '0')}.png`)
    writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log(`[film] still ${file}`)
  }
}

if (values.video) {
  if (rendered >= 0) {
    throw new Error('film: record --video in its own run, not after --stills')
  }
  stream = createWriteStream(streamPath)
  const config = await page.evaluate(
    b => window.__film.startVideo({ bitrate: b }),
    Number(values.bitrate)
  )
  console.log('[film] encoder', JSON.stringify(config))
  const t0 = Date.now()
  for (let i = 0; i < frameCount; ++i) {
    await renderTo(i, 'video')
    if (i % fps === 0 || i === frameCount - 1) {
      const elapsed = (Date.now() - t0) / 1000
      const perFrame = elapsed / (i + 1)
      console.log(
        `[film] frame ${i + 1}/${frameCount} ${(perFrame * 1000).toFixed(0)} ms/frame, eta ${((frameCount - i - 1) * perFrame).toFixed(0)} s`
      )
    }
  }
  await page.evaluate(() => window.__film.finishVideo())
  await new Promise(done => stream.end(done))
  if (chunkCount !== frameCount) {
    throw new Error(
      `film: encoded ${chunkCount} chunks for ${frameCount} frames`
    )
  }
  const mp4 = join(out, `${stem}.mp4`)
  const mux = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      String(fps),
      '-i',
      streamPath,
      '-c',
      'copy',
      // The raw stream carries no usable timing: number frames at exactly fps
      '-bsf:v',
      `setts=ts=N/(${fps}*TB)`,
      '-video_track_timescale',
      String(fps * 1000),
      '-movflags',
      '+faststart',
      mp4
    ],
    { stdio: 'inherit' }
  )
  if (mux.status !== 0) throw new Error(`film: ffmpeg exited ${mux.status}`)
  rmSync(streamPath)
  console.log(`[film] video ${mp4}`)
}

writeFileSync(
  join(out, `${stem}.log.json`),
  JSON.stringify(
    {
      shot,
      info,
      url: url.toString(),
      frameCount,
      seconds: (Date.now() - started) / 1000,
      console: consoleLines
    },
    null,
    2
  )
)
await browser.close()
