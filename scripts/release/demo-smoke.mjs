import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { preview } from 'vite'

import {
  assertContribution,
  assertVisible,
  decodeScreenshot,
  LIMITS
} from '../../examples/parity/scripts/consumer-native/pixels.mjs'
import { chromiumLaunchOptions } from '../../examples/parity/src/e2eSupport/chromeFlags.mjs'
import { digest } from './public-scan.mjs'

const root = resolve(import.meta.dirname, '../..')
// The paused demo frame carries temporal-pipeline residue the recipes do not:
// 0.0017 mean between captures 64 frames apart at 960x640 (2026-10-28), against
// the recipes' 0.001. The contribution guard keeps its 5x-noise margin
const DEMO_LIMITS = { ...LIMITS, stableMean: 0.003, restoreMean: 0.004 }
const output = process.argv[2]
if (!output || process.argv.length !== 3)
  throw new Error('Usage: demo-smoke.mjs <evidence-directory>')
mkdirSync(output, { recursive: true })
const require = createRequire(join(root, 'examples/parity/package.json'))
const { chromium } = require('@playwright/test')
const server = await preview({
  root: join(root, 'examples/demo'),
  configFile: join(root, 'examples/demo/vite.config.ts'),
  preview: { host: '127.0.0.1', port: 0, strictPort: true }
})
let browser
const result = {
  qualification: 'exported-demo-native-hardware',
  status: 'failed'
}
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    ...chromiumLaunchOptions(['--enable-unsafe-webgpu'], [])
  })
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
  const errors = []
  const external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.route('**/*', route => {
    const request = route.request().url()
    if (request.startsWith(origin + '/')) return route.continue()
    external.push(digest(request))
    return route.abort()
  })
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () =>
      window.__demo?.getState().texturesReady &&
      window.__demo.getState().frame > 64,
    null,
    { timeout: 180_000 }
  )
  const adapter = await page.evaluate(async () => {
    const gpu = await navigator.gpu.requestAdapter()
    if (!gpu) throw new Error('No WebGPU adapter')
    return {
      vendor: gpu.info.vendor,
      architecture: gpu.info.architecture,
      description: gpu.info.description,
      fallback: gpu.isFallbackAdapter === true
    }
  })
  if (
    adapter.fallback ||
    /swiftshader|llvmpipe|software/i.test(JSON.stringify(adapter))
  ) {
    throw new Error('Native demo qualification refuses software adapters')
  }
  const initial = await page.evaluate(() => {
    const state = window.__demo.getState()
    window.__demo.setPlaying(false)
    return state
  })
  if (initial.ground !== 'bare')
    throw new Error('Exported demo must use the credential-free bare ground')
  const capture = async name => {
    const frame = await page.evaluate(() => window.__demo.getState().frame)
    await page.waitForFunction(
      frame => window.__demo.getState().frame >= frame + 64,
      frame,
      { timeout: 120_000 }
    )
    const bytes = await page
      .locator('canvas')
      .screenshot({ path: join(output, `${name}.png`) })
    const image = decodeScreenshot(bytes)
    assertVisible(image)
    return { image, sha256: digest(bytes) }
  }
  const clouds = await capture('clouds-on')
  const repeat = await capture('clouds-repeat')
  await page.evaluate(() => window.__demo.setCoverage(0))
  const clear = await capture('clouds-off')
  await page.evaluate(
    coverage => window.__demo.setCoverage(coverage),
    initial.coverage
  )
  const restored = await capture('clouds-restored')
  const metrics = assertContribution(
    clouds.image,
    repeat.image,
    clear.image,
    restored.image,
    DEMO_LIMITS
  )
  if (errors.length || external.length)
    throw new Error('Demo emitted errors or external requests')
  Object.assign(result, {
    status: 'passed',
    adapter,
    browser: browser.version(),
    initial,
    ...metrics,
    screenshots: {
      clouds: clouds.sha256,
      repeat: repeat.sha256,
      clear: clear.sha256,
      restored: restored.sha256
    },
    consoleErrors: errors.length,
    externalRequests: external.length
  })
} catch (error) {
  result.error = error.message
  process.exitCode = 1
} finally {
  writeFileSync(
    join(output, 'receipt.json'),
    JSON.stringify(result, null, 2) + '\n'
  )
  await browser?.close()
  await new Promise(resolveDone => server.httpServer.close(resolveDone))
}
console.log(JSON.stringify(result, null, 2))
