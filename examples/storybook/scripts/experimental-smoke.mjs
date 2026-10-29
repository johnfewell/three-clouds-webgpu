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
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6007'
const output = join(root, 'test-results/storybook-experiments')
await mkdir(output, { recursive: true })

const stories = [
  ['cloud-front-refinement', 'cloudFrontRefinement'],
  ['compute-resolve', 'computeResolve'],
  ['wind-reprojection', 'windReprojection'],
  ['distant-cloud-shadows', 'distantCloudShadows'],
  ['directional-skylight', 'directionalSkylight'],
  ['procedural-weather', 'proceduralWeather']
]
assert(stories.length > 0, 'No Storybook experiments selected')
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu']
})

async function settle(frame) {
  const start = await frame.evaluate(
    () => window.__cloudsStory.cloudsContext.frame
  )
  await frame.waitForFunction(
    frameNumber =>
      window.__cloudsStory?.cloudsContext.frame >= frameNumber + 32,
    start
  )
}

async function pixelStats(page, png) {
  return page.evaluate(async encoded => {
    const image = new Image()
    image.src = 'data:image/png;base64,' + encoded
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    let square = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
      sum += value
      square += value * value
    }
    const count = pixels.length / 4
    const mean = sum / count
    return { count, mean, variance: square / count - mean * mean }
  }, png.toString('base64'))
}

try {
  for (const [story, option] of stories) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 }
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(`${base}/?path=/story/clouds-webgpu-experiments--${story}`)
    const frame = await (
      await page.waitForSelector('#storybook-preview-iframe')
    ).contentFrame()
    await frame.waitForFunction(
      () => window.__cloudsStory?.cloudsContext.frame > 32
    )
    await frame.waitForFunction(
      key => window.__cloudsStory?.cloudsContext.experimental[key],
      option
    )
    const before = await frame.evaluate(() => ({
      camera: window.__cloudsStory.camera.uuid,
      position: window.__cloudsStory.camera.position.toArray(),
      time: window.__cloudsStory.cloudsContext.time
    }))
    await page.getByRole('radio', { name: 'Baseline', exact: true }).check()
    await frame.waitForFunction(
      () =>
        window.__cloudsStory != null &&
        Object.values(window.__cloudsStory.cloudsContext.experimental).every(
          value => !value
        )
    )
    await settle(frame)
    await page.screenshot({ path: join(output, story + '-baseline.png') })
    await page.getByRole('radio', { name: 'Experiments', exact: true }).check()
    await frame.waitForFunction(
      key => window.__cloudsStory?.cloudsContext.experimental[key],
      option
    )
    await settle(frame)
    const after = await frame.evaluate(() => ({
      camera: window.__cloudsStory.camera.uuid,
      position: window.__cloudsStory.camera.position.toArray(),
      time: window.__cloudsStory.cloudsContext.time,
      flags: window.__cloudsStory.cloudsContext.experimental,
      shapeSpeed:
        window.__cloudsStory.cloudsContext.shapeVelocity.x /
        window.__cloudsStory.cloudsContext.shapeRepeat.x,
      detailSpeed:
        window.__cloudsStory.cloudsContext.shapeDetailVelocity.x /
        window.__cloudsStory.cloudsContext.shapeDetailRepeat.x,
      weatherSpeed:
        window.__cloudsStory.cloudsContext.localWeatherVelocity.length()
    }))
    assert.equal(after.camera, before.camera, 'Comparison remounted the camera')
    assert.deepEqual(
      after.position,
      before.position,
      'Comparison moved the camera'
    )
    assert(after.time >= before.time, 'Comparison reset the scene clock')
    if (option === 'windReprojection') {
      assert.equal(after.shapeSpeed, 20)
      assert.equal(after.detailSpeed, 20)
      assert.equal(after.weatherSpeed, 0)
    }
    const pixels = await pixelStats(
      page,
      await frame.locator('canvas').first().screenshot()
    )
    assert(pixels.count > 0 && pixels.variance > 1, 'Blank cloud canvas')
    await page.screenshot({ path: join(output, story + '-experiments.png') })
    assert.deepEqual(errors, [], 'Browser errors')
    console.log(JSON.stringify({ story, pixels, ...after }))
    await page.close()
  }

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 }
  })
  await mobile.goto(
    `${base}/iframe.html?id=clouds-webgpu-experiments--cloud-front-refinement&viewMode=story`
  )
  await mobile.waitForFunction(
    () => window.__cloudsStory?.cloudsContext.frame > 32
  )
  const pixels = await pixelStats(
    mobile,
    await mobile.locator('canvas').first().screenshot()
  )
  assert(pixels.count > 0 && pixels.variance > 1, 'Blank mobile cloud canvas')
  await mobile.screenshot({ path: join(output, 'mobile.png') })
  console.log(JSON.stringify({ viewport: '390x844', pixels }))
  await mobile.close()
} finally {
  await browser.close()
}
