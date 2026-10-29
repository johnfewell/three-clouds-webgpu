import { expect } from '@playwright/test'
import type {
  BakedCloudTextures,
  BakedCloudTextureUrls
} from 'three-clouds-webgpu'

import type * as AssetLifecycle from '../src/e2eSupport/assetLifecycle'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'

const LIB_URL = '/node_modules/three-clouds-webgpu/build/index.js'
const urls: BakedCloudTextureUrls = {
  localWeather: '/assets/local_weather.png',
  turbulence: '/assets/turbulence.png',
  shape: '/assets/shape.bin',
  shapeDetail: '/assets/shape_detail.bin'
}

interface AssetModule {
  loadBakedCloudTextures: (
    urls: BakedCloudTextureUrls,
    options?: { signal: AbortSignal }
  ) => Promise<BakedCloudTextures>
}

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'assets')
})

test('baked assets decode in the browser and transfer ownership', async ({
  page
}) => {
  await loadCase(page, 'baseline-medium', { w: '160', h: '90' })
  const result = await page.evaluate(
    async ({ moduleUrl, urls }) => {
      const { loadBakedCloudTextures } = (await import(
        moduleUrl
      )) as AssetModule
      const controller = new AbortController()
      const baked = await loadBakedCloudTextures(urls, {
        signal: controller.signal
      })
      let disposed = 0
      const textures = Object.values(baked)
      for (const texture of textures) {
        texture.addEventListener('dispose', () => {
          disposed++
        })
      }
      controller.abort()
      const disposedAfterAbort = disposed
      const weather = baked.localWeatherTexture.image as HTMLImageElement
      const turbulence = baked.turbulenceTexture.image as HTMLImageElement
      const dimensions = {
        shape: [
          baked.shapeTexture.image.width,
          baked.shapeTexture.image.height,
          baked.shapeTexture.image.depth
        ],
        detail: [
          baked.shapeDetailTexture.image.width,
          baked.shapeDetailTexture.image.height,
          baked.shapeDetailTexture.image.depth
        ],
        weather: [weather.naturalWidth, weather.naturalHeight],
        turbulence: [turbulence.naturalWidth, turbulence.naturalHeight]
      }
      for (const texture of textures) texture.dispose()
      return {
        keys: Object.keys(baked).sort(),
        dimensions,
        disposedAfterAbort,
        disposedAfterOwnerCleanup: disposed
      }
    },
    { moduleUrl: LIB_URL, urls }
  )
  console.log(`[assets] browser success ${JSON.stringify(result)}`)
  expect(result.keys).toEqual([
    'localWeatherTexture',
    'shapeDetailTexture',
    'shapeTexture',
    'turbulenceTexture'
  ])
  expect(result.dimensions.shape).toEqual([128, 128, 128])
  expect(result.dimensions.detail).toEqual([32, 32, 32])
  for (const size of [
    ...result.dimensions.weather,
    ...result.dimensions.turbulence
  ]) {
    expect(size).toBeGreaterThan(0)
  }
  expect(result.disposedAfterAbort).toBe(0)
  expect(result.disposedAfterOwnerCleanup).toBe(4)
})

test('baked browser loads reject HTML payloads and cancellation clearly', async ({
  page
}) => {
  await loadCase(page, 'baseline-medium', { w: '160', h: '90' })
  const badUrl = '/assets/asset-contract-invalid-shape.bin'
  const html = '<!doctype html><title>Not an asset</title>'
  await page.route(`**${badUrl}`, route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html })
  )
  const result = await page.evaluate(
    async ({ moduleUrl, urls, badUrl }) => {
      const { loadBakedCloudTextures } = (await import(
        moduleUrl
      )) as AssetModule
      const helperUrl = '/src/e2eSupport/assetLifecycle.ts'
      const { measureAssetFailureOwnership } = (await import(
        helperUrl
      )) as typeof AssetLifecycle
      const ownership = await measureAssetFailureOwnership(urls, badUrl)
      const controller = new AbortController()
      const cancelled = loadBakedCloudTextures(urls, {
        signal: controller.signal
      }).then(
        () => null,
        (error: Error) => error.name
      )
      controller.abort()
      return { ...ownership, cancelled: await cancelled }
    },
    { moduleUrl: LIB_URL, urls, badUrl }
  )
  console.log(`[assets] browser failure ${JSON.stringify(result)}`)
  expect(result.failure).toEqual({
    name: 'CloudTextureLoadError',
    asset: 'shape',
    url: badUrl,
    status: 200,
    expectedBytes: 128 ** 3,
    actualBytes: new TextEncoder().encode(html).byteLength
  })
  expect(result.cancelled).toBe('AbortError')
  expect(result.beforeLate[urls.localWeather]).toEqual({
    decoded: true,
    disposals: 1
  })
  expect(result.beforeLate[urls.turbulence]).toEqual({
    decoded: true,
    disposals: 1
  })
  expect(result.afterLate).toEqual(result.beforeLate)
})
