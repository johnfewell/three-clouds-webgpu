// Rain shafts on hardware: the option must change pixels, must stay finite, and
// must cost what it says it costs. The cost half is a GPU timestamp
// measurement, so it skips without hardware

import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'

import { test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

const CASE = 'sky-horizon-low-sun'

// The three CloudLayer fields this spec sets, which the page's own type does not
// narrow to
interface ConvectiveLayer {
  altitude: number
  height: number
  densityScale: number
}

test.beforeEach(async ({ page }) => {
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
  await page.route('**/stars.bin', route =>
    route.fulfill({
      path: fileURLToPath(
        new URL(
          '../../../node_modules/@takram/three-atmosphere/assets/stars.bin',
          import.meta.url
        )
      )
    })
  )
  await page.route('**/stbn.bin', route =>
    route.fulfill({
      path: fileURLToPath(
        new URL('../../../test/fixtures/experimental/stbn.bin', import.meta.url)
      )
    })
  )
})

test('rain shafts darken pixels under a convective cell', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE}&e2e=1&w=641&h=361`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const ctx = p.sideBHandle!.cloudsContext as unknown as {
      cloudLayers: ConvectiveLayer[]
      experimental: Record<string, boolean>
      convectiveProfile: Record<string, number>
      lightShafts: boolean
    }
    // A convective deck rather than the shipped fair-weather slab: the shafts
    // hang from the cloud base, so 1.5 to 7.5 km is what reads at 20 km
    const base = ctx.cloudLayers[0]!
    base.altitude = 1500
    base.height = 6000
    base.densityScale = 0.4
    ctx.experimental = { convectiveProfile: true }
    ctx.convectiveProfile.cellsPerWeatherTile = 6
    ctx.convectiveProfile.cellThreshold = 0.5
    ctx.lightShafts = true
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 32,
      resetHistory: true
    })
    const off = (await p.readLinear('B')).data
    ctx.experimental = { convectiveProfile: true, rainShafts: true }
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 32,
      resetHistory: true
    })
    const on = (await p.readLinear('B')).data
    let changed = 0
    let darker = 0
    let error = 0
    for (let i = 0; i < off.length; i++) {
      const delta = off[i]! - on[i]!
      if (Math.abs(delta) > 1e-5) changed++
      if (delta > 1e-5) darker++
      error += delta * delta
    }
    return {
      changed,
      darker,
      fraction: changed / off.length,
      rmse: Math.sqrt(error / off.length),
      count: off.length,
      finite: Array.from(on).every(Number.isFinite),
      errors: p.errors
    }
  })
  console.log('[rain-shafts]', JSON.stringify(result))
  expect(result.count).toBeGreaterThan(0)
  expect(result.finite).toBe(true)
  expect(result.changed).toBeGreaterThan(0)
  // It has to dim something, not only veil: measured over a horizon frame it
  // darkens 39k of the 231k samples it changes, and lifts the rest, which is
  // what a veil does in front of dark ground (docs/EXPERIMENTAL.md)
  expect(result.darker).toBeGreaterThan(0)
  expect(result.errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('rain-shafts-on.png') })
})

test('rain shafts cost one closed march of four steps', async ({ page }) => {
  test.skip(
    process.env.PARITY_GPU !== 'hardware',
    'Hardware timestamp measurement'
  )
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE}&e2e=1&w=1920&h=1080`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const handle = p.sideBHandle!
    const ctx = handle.cloudsContext as unknown as {
      cloudLayers: ConvectiveLayer[]
      experimental: Record<string, boolean>
      convectiveProfile: Record<string, number>
      lightShafts: boolean
    }
    const base = ctx.cloudLayers[0]!
    base.altitude = 1500
    base.height = 6000
    base.densityScale = 0.4
    ctx.experimental = { convectiveProfile: true }
    ctx.convectiveProfile.cellsPerWeatherTile = 6
    ctx.convectiveProfile.cellThreshold = 0.5
    ctx.lightShafts = true
    const timings: Array<{ shafts: boolean; medianMs: number; p95Ms: number }> =
      []
    // off, on, on, off, so a drift in the machine cannot read as the option
    for (const shafts of [false, true, true, false]) {
      ctx.experimental = { convectiveProfile: true, rainShafts: shafts }
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 32,
        resetHistory: true
      })
      await handle.renderer.resolveTimestampsAsync('render')
      const samples: number[] = []
      for (let frame = 0; frame < 40; frame++) {
        await new Promise<void>(resolve =>
          requestAnimationFrame(() => resolve())
        )
        handle.cloudsContext.frame = frame
        handle.render()
        await handle.renderer.resolveTimestampsAsync('render')
        samples.push(handle.renderer.info.render.timestamp)
      }
      samples.sort((a, b) => a - b)
      timings.push({ shafts, medianMs: samples[20]!, p95Ms: samples[38]! })
    }
    const mean = (values: number[]) =>
      values.reduce((a, b) => a + b, 0) / values.length
    const off = timings.filter(t => !t.shafts)
    const on = timings.filter(t => t.shafts)
    return {
      timings,
      offMedianMs: mean(off.map(t => t.medianMs)),
      onMedianMs: mean(on.map(t => t.medianMs)),
      errors: p.errors
    }
  })
  const delta =
    result.onMedianMs > 0
      ? (result.onMedianMs - result.offMedianMs) / result.offMedianMs
      : 0
  console.log(
    '[rain-shafts-cost]',
    JSON.stringify({ ...result, relativeMedian: delta })
  )
  expect(result.errors).toEqual([])
  expect(result.offMedianMs).toBeGreaterThan(0)
  expect(result.onMedianMs).toBeGreaterThan(0)
  // Four steps of pure ALU against a march of up to 500, so the option must not
  // double the frame. A larger delta means the segment or the lighting is doing
  // more than the docs claim
  expect(delta).toBeLessThan(0.5)
})

test('rain shafts stop at bare ground without scene depth', async ({
  page
}) => {
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE}&e2e=1&w=321&h=181`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const handle = p.sideBHandle!
    const ctx = handle.cloudsContext
    handle.sceneResult.ground.visible = false
    handle.sceneResult.sphere.visible = false
    handle.sceneResult.plane.visible = false
    handle.cloudsPass.sceneDepth = null
    handle.camera.position.set(6_378_237, 0, 0)
    handle.camera.up.set(0, 0, 1)
    handle.camera.lookAt(0, 0, 0)
    handle.camera.updateMatrixWorld()
    ctx.haze = false
    ctx.lightShafts = false
    ctx.temporalUpscale = false
    ctx.resolutionScale = 1
    for (const layer of ctx.cloudLayers) layer.densityScale = 0
    ctx.cloudLayers[0]!.altitude = 1600
    ctx.cloudLayers[0]!.height = 1200
    // A full cell makes the bound observable at every sampled pixel
    ctx.convectiveProfile.cellThreshold = -2
    ctx.convectiveProfile.cellSoftness = 0.1
    const capture = async (enabled: boolean, limit: number) => {
      ctx.experimental = { rainShafts: enabled, convectiveProfile: false }
      ctx.clouds.maxRayDistance = limit
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 16,
        resetHistory: true
      })
      const { width, height, data } = await p.readLayer()
      const opacity: number[] = []
      for (let y = Math.floor(height / 4); y < (height * 3) / 4; y++) {
        for (let x = Math.floor(width / 4); x < (width * 3) / 4; x++) {
          opacity.push(data[(y * width + x) * 4 + 3]!)
        }
      }
      return opacity
    }
    const off = await capture(false, 200_000)
    const short = await capture(true, 50_000)
    const long = await capture(true, 200_000)
    // An upward ray must still integrate a real above-ground rain column
    handle.camera.lookAt(6_379_237, 0, 0)
    handle.camera.updateMatrixWorld()
    const up = await capture(true, 200_000)
    const mean = (a: number[]) => a.reduce((sum, v) => sum + v, 0) / a.length
    return {
      count: long.length,
      offMax: Math.max(...off),
      downMax: Math.max(...long),
      downMean: mean(long),
      upMean: mean(up),
      limitDelta: Math.max(...long.map((v, i) => Math.abs(v - short[i]!))),
      finite: [...off, ...short, ...long, ...up].every(Number.isFinite),
      sceneDepth: handle.cloudsPass.sceneDepth === null,
      errors: p.errors
    }
  })
  console.log('[rain-ground-boundary]', JSON.stringify(result))
  expect(result.count).toBeGreaterThan(0)
  expect(result.sceneDepth).toBe(true)
  expect(result.finite).toBe(true)
  expect(result.offMax).toBe(0)
  expect(result.downMean).toBeGreaterThan(1e-4)
  expect(result.downMax).toBeLessThan(0.03)
  expect(result.limitDelta).toBeLessThan(1e-4)
  expect(result.upMean).toBeGreaterThan(result.downMean * 5)
  expect(result.errors).toEqual([])
  await page.screenshot({
    path: test.info().outputPath('rain-above-ground.png')
  })
})
