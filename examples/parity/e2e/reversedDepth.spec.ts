import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'

import {
  assertVisible,
  comparePixels,
  decodeScreenshot,
  LIMITS
} from '../scripts/consumer-native/pixels.mjs'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

const SETTINGS = [
  { name: 'midday', elevation: 60, azimuth: 0 },
  { name: 'sunset', elevation: 2, azimuth: 180 }
] as const

const hardware =
  (process.env.PARITY_GPU ?? (process.env.CI ? 'software' : 'hardware')) ===
  'hardware'
test.skip(!hardware, 'native hardware comparison')
test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'reversed-depth')
})

async function measure(
  page: Page,
  reversed: boolean,
  elevation: number,
  azimuth: number
) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await loadCase(page, 'shadow-sphere', {
    w: '640',
    h: '360',
    reversedDepth: reversed ? '1' : '0'
  })
  const metrics = await page.evaluate(
    async ({ elevation, azimuth }) => {
      const probe = (window as ParityWindow).__parity
      const side = probe.sideBHandle
      if (side == null) throw new Error('Missing WebGPU side')
      const { camera, cloudsContext: context, sceneResult } = side
      const frame = sceneResult.enuAtAnchor
      camera.position.set(0, 0, 500).applyMatrix4(frame)
      camera.up.set(0, 0, 1).transformDirection(frame)
      const angle = (azimuth * Math.PI) / 180
      camera.lookAt(
        camera.position
          .clone()
          .set(Math.sin(angle) * 10_000, Math.cos(angle) * 10_000, 2500)
          .applyMatrix4(frame)
      )
      camera.near = 1
      camera.far = 60_000
      if ('fov' in camera) camera.fov = 60
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
      context.shadow.cascadeCount = 3
      context.shadow.mapSize.set(256, 256)
      context.shadow.maxFar = 60_000
      context.shadow.splitLambda = 0.6
      context.shadow.temporalPass = false
      context.temporalUpscale = false
      probe.setShadow(true)
      probe.setLightShafts(true)
      side.setSun(elevation, 180)
      await probe.renderOnce('B', { time: 0, frame: 64, warmup: 64 })
      const layer = await probe.readLayer()
      let cloudPixels = 0
      let cloudLuminance = 0
      for (let offset = 0; offset < layer.data.length; offset += 4) {
        if (layer.data[offset + 3]! <= 0.01) continue
        cloudPixels++
        cloudLuminance +=
          layer.data[offset]! * 0.2126 +
          layer.data[offset + 1]! * 0.7152 +
          layer.data[offset + 2]! * 0.0722
      }
      const maps = context.shadowMaps
      if (maps == null) throw new Error('Missing cloud shadow cascades')
      return {
        rendererReversed: side.renderer.reversedDepthBuffer,
        cameraReversed: camera.reversedDepth,
        backend:
          'isWebGPUBackend' in side.renderer.backend &&
          side.renderer.backend.isWebGPUBackend === true,
        cameraPosition: camera.position.toArray(),
        cameraDirection: camera
          .getWorldDirection(camera.position.clone())
          .toArray(),
        sunDirection: context.sunDirection.toArray(),
        cloudPixels,
        cloudLuminance: cloudLuminance / Math.max(cloudPixels, 1),
        cascades: maps.cascades.map(cascade => ({
          interval: cascade.interval.toArray(),
          width: 2 / cascade.projectionMatrix.elements[0],
          texel: 2 / cascade.projectionMatrix.elements[0] / maps.mapSize.x
        })),
        errors: [...probe.errors]
      }
    },
    { elevation, azimuth }
  )
  return { metrics, errors }
}

for (const setting of SETTINGS) {
  test(`reversed depth preserves ${setting.name} cloud shadows`, async ({
    page
  }, testInfo) => {
    test.setTimeout(240_000)
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
    const directory =
      process.env.REVERSED_DEPTH_EVIDENCE_DIR == null
        ? testInfo.outputPath('evidence')
        : resolve(process.env.REVERSED_DEPTH_EVIDENCE_DIR)
    mkdirSync(directory, { recursive: true })
    const ordinary = await measure(
      page,
      false,
      setting.elevation,
      setting.azimuth
    )
    const normalBytes = await page
      .locator('#canvas-b')
      .screenshot({ path: resolve(directory, `${setting.name}-ordinary.png`) })
    const reversed = await measure(
      page,
      true,
      setting.elevation,
      setting.azimuth
    )
    const reversedBytes = await page
      .locator('#canvas-b')
      .screenshot({ path: resolve(directory, `${setting.name}-reversed.png`) })
    const normalImage = decodeScreenshot(normalBytes)
    const reversedImage = decodeScreenshot(reversedBytes)
    const pixels = comparePixels(normalImage, reversedImage)
    const libraryRoot = realpathSync(
      resolve(import.meta.dirname, '../node_modules/three-clouds-webgpu')
    )
    expect(libraryRoot).toBe(resolve(import.meta.dirname, '../../..'))
    const result = {
      libraryRoot,
      buildSha256: createHash('sha256')
        .update(readFileSync(resolve(libraryRoot, 'build/shared.js')))
        .digest('hex'),
      setting,
      ordinary,
      reversed,
      pixels,
      pixelMeanLimit: LIMITS.restoreMean
    }
    const receiptPath = resolve(directory, `${setting.name}.json`)
    writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n')
    await testInfo.attach(`${setting.name} metrics`, {
      path: receiptPath,
      contentType: 'application/json'
    })
    await testInfo.attach(`${setting.name} ordinary`, {
      body: normalBytes,
      contentType: 'image/png'
    })
    await testInfo.attach(`${setting.name} reversed`, {
      body: reversedBytes,
      contentType: 'image/png'
    })
    for (const [expectedReversed, sample] of [
      [false, ordinary],
      [true, reversed]
    ] as const) {
      expect(sample.errors).toEqual([])
      expect(sample.metrics.errors).toEqual([])
      expect(sample.metrics.rendererReversed).toBe(expectedReversed)
      expect(sample.metrics.cameraReversed).toBe(expectedReversed)
      expect(sample.metrics.backend).toBe(true)
      expect(sample.metrics.cloudPixels).toBeGreaterThan(100)
      expect(sample.metrics.cloudLuminance).toBeGreaterThan(0.005)
    }
    expect(reversed.metrics.cloudPixels).toBe(ordinary.metrics.cloudPixels)
    expect(reversed.metrics.cloudLuminance).toBeCloseTo(
      ordinary.metrics.cloudLuminance,
      8
    )
    assertVisible(normalImage)
    assertVisible(reversedImage)
    for (let index = 0; index < ordinary.metrics.cascades.length; index++) {
      expect(reversed.metrics.cascades[index]!.interval).toEqual(
        ordinary.metrics.cascades[index]!.interval
      )
      expect(reversed.metrics.cascades[index]!.width).toBeCloseTo(
        ordinary.metrics.cascades[index]!.width,
        5
      )
    }
    expect(pixels.meanDifference).toBeLessThanOrEqual(LIMITS.restoreMean!)
    expect(pixels.changedFraction).toBeLessThanOrEqual(0.01)
  })
}
