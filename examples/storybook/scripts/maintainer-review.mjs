import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(root, 'examples/parity/package.json'))
const playwright = dirname(require.resolve('@playwright/test/package.json'))
const { chromium } = await import(pathToFileURL(join(playwright, 'index.mjs')))
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6008'
assert(
  ['localhost', '127.0.0.1'].includes(new URL(base).hostname),
  'Local Storybook server required'
)
const tiles = process.env.REVIEW_TILES === '1'
const output = join(
  root,
  'test-results/maintainer/storybook',
  tiles ? 'tiles' : 'local'
)
await mkdir(output, { recursive: true })
const index = await fetch(`${base}/index.json`).then(response => {
  assert(response.ok, 'Storybook index unavailable')
  return response.json()
})
const tileStories = Object.keys(index.entries).filter(id =>
  /clouds.*3d-tiles.*--(fuji|toronto)$/.test(id)
)
assert.equal(
  tileStories.length,
  4,
  'Both backends must expose Fuji and Toronto'
)
const stories = tiles
  ? tileStories
  : [
      'clouds-webgpu-clouds--basic',
      'clouds-webgl-clouds--basic',
      'clouds-webgpu-clouds--custom-layers',
      'clouds-webgl-clouds--custom-layers',
      'clouds-webgpu-experiments--wind-reprojection'
    ]
assert(stories.length > 0, 'Empty review plan')
for (const id of stories) assert(index.entries[id], `Missing story: ${id}`)

async function pixels(page) {
  const png = await page.locator('canvas').first().screenshot()
  return page.evaluate(async encoded => {
    const image = new Image()
    image.src = 'data:image/png;base64,' + encoded
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 80
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, 128, 80)
    const data = [...context.getImageData(0, 0, 128, 80).data]
    const values = data.filter((_, i) => i % 4 !== 3)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length
    return { mean, variance, data }
  }, png.toString('base64'))
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})
const report = {
  complete: false,
  requestedStories: stories,
  node: process.version,
  date: new Date().toISOString(),
  base,
  tiles,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim(),
  buildHash: createHash('sha256')
    .update(await readFile(join(root, 'build/shared.js')))
    .digest('hex'),
  browser: browser.version(),
  tileStories,
  results: []
}
try {
  for (const id of stories) {
    const mobile = !tiles && id === stories.at(-1)
    const viewport = mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 900 }
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      recordVideo: { dir: join(output, 'video'), size: viewport }
    })
    // Python's minimal static server has no implicit favicon route
    await context.route('**/favicon.ico', route =>
      route.fulfill({ status: 204, body: '' })
    )
    const page = await context.newPage()
    page.setDefaultTimeout(120000)
    const errors = []
    // Never persist provider URLs or browser messages that might contain keys
    page.on('pageerror', () => errors.push('pageerror'))
    page.on('console', message => {
      if (message.type() === 'error') errors.push('console.error')
    })
    try {
      await page.goto(`${base}/iframe.html?id=${id}&viewMode=story&hidePanel=1`)
      await page.locator('canvas').first().waitFor({ state: 'visible' })
      await page.waitForTimeout(tiles ? 25000 : 12000)
      const before = await pixels(page)
      assert(before.variance > 1, `Blank canvas: ${id}`)
      await page.waitForTimeout(8000)
      const after = await pixels(page)
      const delta =
        after.data.reduce(
          (sum, value, i) => sum + Math.abs(value - before.data[i]),
          0
        ) / after.data.length
      assert(after.variance > 1, `Blank final canvas: ${id}`)
      if (id.includes('wind-reprojection'))
        assert(delta > 0.01, 'Cloud motion not visible')
      await page.screenshot({ path: join(output, `${id}.png`) })
      const video = page.video()
      await context.close()
      await video.saveAs(join(output, `${id}.webm`))
      report.results.push({
        id,
        viewport,
        mean: after.mean,
        variance: after.variance,
        motionDelta: delta,
        errors
      })
      assert.deepEqual(errors, [], `Browser errors: ${id}`)
      console.log(JSON.stringify(report.results.at(-1)))
    } finally {
      await context.close()
    }
  }
  report.complete = true
} finally {
  await browser.close()
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
}
