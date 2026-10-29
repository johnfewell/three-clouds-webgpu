// A/B capture: the WebGL reference story and the port story at one size, leva
// hidden, fresh headed-Chrome context each (the parity harness's WebGPU flags)
// Writes <prefix>-A.png (WebGL) and <prefix>-B.png. @playwright/test resolves
// from examples/parity. Story ids are Storybook's (title + name, kebab-case)
//   node scripts/ab.mjs clouds-webgl-clouds--basic clouds-webgpu-clouds--basic ab-basic [waitMs]
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

// Optional 5th argument: Storybook `args=` string applied to the WebGPU story
// only (e.g. `jitter:hash`), so a knob can be A/B'd against the reference.
const [webglId, webgpuId, prefix, waitMs = '10000', argsB] =
  process.argv.slice(2)
if (webglId == null || webgpuId == null || prefix == null) {
  console.error(
    'usage: node scripts/ab.mjs <webgl-story-id> <webgpu-story-id> <prefix> [waitMs] [argsB]'
  )
  process.exit(1)
}
const base = process.env.STORYBOOK_URL ?? 'http://localhost:6006'
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan']
})
for (const [id, side] of [
  [webglId, 'A'],
  [webgpuId, 'B']
]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  const errors = new Set()
  page.on('console', m => {
    if (m.type() === 'error') errors.add(m.text().slice(0, 120))
  })
  const args = side === 'B' && argsB ? `&args=${encodeURIComponent(argsB)}` : ''
  await page.goto(
    `${base}/iframe.html?id=${id}&viewMode=story&hidePanel=1${args}`,
    { waitUntil: 'load' }
  )
  await page.waitForTimeout(+waitMs)
  await page.screenshot({ path: `${prefix}-${side}.png` })
  console.log(`${prefix}-${side}.png  ${id}  console errors: ${errors.size}`)
  for (const e of [...errors].slice(0, 3)) console.log(`    ${e}`)
  await context.close()
}
await browser.close()
