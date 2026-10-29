import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import type { ExperimentalCloudOptions } from 'three-clouds-webgpu'

import { test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

const options: (keyof ExperimentalCloudOptions)[] = [
  'cloudFrontRefinement',
  'distantCloudShadows',
  'directionalSkylight',
  'windReprojection',
  'computeResolve'
]

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

test('experimental options render finite cloud pixels at an odd viewport size', async ({
  page
}) => {
  test.setTimeout(240_000)
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
  const errors: string[] = []
  page.on('response', response => {
    if (response.status() >= 400)
      console.log('[experimental HTTP]', response.status(), response.url())
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/?case=sky-horizon-low-sun&e2e=1&w=641&h=361')
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  for (const option of options) {
    const result = await page.evaluate(
      async ({ option, options }) => {
        const p = (window as ParityWindow).__parity
        const ctx = p.sideBHandle!.cloudsContext
        ctx.experimental = Object.fromEntries(
          options.map(key => [key, key === option])
        )
        await p.renderOnce('B', {
          time: 0,
          frame: 0,
          warmup: 20,
          resetHistory: true
        })
        const layer = await p.readLayer()
        const plate = await p.readLinear('B')
        let occupied = 0
        for (let i = 3; i < layer.data.length; i += 4)
          if (layer.data[i]! > 0) occupied++
        return {
          option,
          enabled: ctx.experimental[option],
          occupied,
          count: layer.data.length,
          finite: Array.from(plate.data).every(Number.isFinite),
          width: plate.width,
          height: plate.height,
          errors: p.errors
        }
      },
      { option, options }
    )
    console.log('[experimental]', JSON.stringify(result))
    expect(result.enabled).toBe(true)
    expect(result.count).toBeGreaterThan(0)
    expect(result.occupied).toBeGreaterThan(0)
    expect(result.finite).toBe(true)
    expect(result.errors).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath(`${option}.png`) })
  }
})

for (const upscale of [false, true]) {
  test(`compute agrees with fragment resolve, upscale=${upscale}`, async ({
    page
  }) => {
    test.setTimeout(240_000)
    await page.goto('/?case=shafts-sky-horizon&e2e=1&w=641&h=361')
    await page.waitForFunction(
      () => (window as ParityWindow).__parity?.sideBHandle != null
    )
    const result = await page.evaluate(async upscale => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext
      p.set({ temporalUpscale: upscale })
      ctx.shadow.temporalPass = true
      const arms = []
      for (const compute of [false, true, false]) {
        ctx.experimental = { computeResolve: compute }
        await p.renderOnce('B', {
          time: 0,
          frame: 0,
          warmup: 32,
          resetHistory: true
        })
        arms.push((await p.readLinear('B')).data)
      }
      const compare = (a: Float32Array, b: Float32Array) => {
        let error = 0
        let energy = 0
        let max = 0
        for (let i = 0; i < a.length; i++) {
          const delta = a[i]! - b[i]!
          error += delta * delta
          energy += a[i]! * a[i]!
          max = Math.max(max, Math.abs(delta))
        }
        return { relativeRmse: Math.sqrt(error / Math.max(energy, 1e-12)), max }
      }
      return {
        upscale: p.readTemporalUpscale().B,
        count: arms[0]!.length,
        compute: compare(arms[0]!, arms[1]!),
        repeat: compare(arms[0]!, arms[2]!),
        errors: p.errors
      }
    }, upscale)
    console.log('[compute comparison]', JSON.stringify(result))
    expect(result.count).toBeGreaterThan(0)
    expect(result.upscale).toBe(upscale)
    expect(result.errors).toEqual([])
    expect(result.compute.relativeRmse).toBeLessThan(0.005)
    expect(result.repeat.relativeRmse).toBeLessThan(0.005)
  })
}

test('wind reprojection follows shape advection and rejects time cuts', async ({
  page
}) => {
  await page.goto('/?case=sky-horizon-low-sun&e2e=1&w=641&h=361')
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const ctx = p.sideBHandle!.cloudsContext
    ctx.shapeDetail = false
    ctx.localWeatherVelocity.set(0, 0)
    ctx.shapeVelocity.set(0.01, -0.02, 0)
    ctx.experimental = { windReprojection: true }
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 2,
      resetHistory: true
    })
    const before = (await p.readLayer()).data
    await p.renderOnce('B', {
      time: 0.1,
      frame: 1,
      warmup: 0,
      resetHistory: false
    })
    const after = (await p.readLayer()).data
    const history = (
      p.sideBHandle!.cloudsPass as unknown as {
        _windHistory: {
          displacement: { value: { toArray: () => number[] } }
          cloudValid: { value: boolean }
          shadowValid: { value: boolean }
        }
      }
    )._windHistory
    const moving = {
      displacement: history.displacement.value.toArray(),
      valid: history.cloudValid.value,
      shaftValid: history.shadowValid.value
    }
    let changed = 0
    for (let i = 0; i < before.length; i++)
      if (Math.abs(before[i]! - after[i]!) > 1e-5) changed++
    await p.renderOnce('B', {
      time: 10,
      frame: 2,
      warmup: 0,
      resetHistory: false
    })
    return {
      moving,
      expected: ctx.shapeRepeat
        .toArray()
        .map((repeat, i) => [0.001, -0.002, 0][i]! / repeat),
      changed,
      cutValid: history.cloudValid.value,
      errors: p.errors
    }
  })
  console.log('[wind]', JSON.stringify(result))
  expect(result.moving.valid).toBe(true)
  expect(result.moving.shaftValid).toBe(false)
  for (let i = 0; i < 3; i++)
    expect(result.moving.displacement[i]).toBeCloseTo(result.expected[i]!, 6)
  expect(result.changed).toBeGreaterThan(0)
  expect(result.cutValid).toBe(false)
  expect(result.errors).toEqual([])
})

test('compute resolve GPU timing includes render and compute work', async ({
  page
}) => {
  test.skip(
    process.env.PARITY_GPU !== 'hardware',
    'Hardware timestamp measurement'
  )
  test.setTimeout(240_000)
  await page.goto('/?case=shafts-sky-horizon&e2e=1&w=1920&h=1080')
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const h = p.sideBHandle!
    const timings = []
    for (const compute of [false, true, true, false]) {
      h.cloudsContext.experimental = { computeResolve: compute }
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 32,
        resetHistory: true
      })
      await h.renderer.resolveTimestampsAsync('render')
      await h.renderer.resolveTimestampsAsync('compute')
      const samples = []
      for (let frame = 0; frame < 40; frame++) {
        await new Promise<void>(resolve =>
          requestAnimationFrame(() => resolve())
        )
        h.cloudsContext.frame = frame
        h.render()
        await h.renderer.resolveTimestampsAsync('render')
        await h.renderer.resolveTimestampsAsync('compute')
        samples.push(
          h.renderer.info.render.timestamp + h.renderer.info.compute.timestamp
        )
      }
      samples.sort((a, b) => a - b)
      timings.push({
        compute,
        count: samples.length,
        medianMs: samples[20]!,
        p95Ms: samples[38]!
      })
    }
    return { timings, errors: p.errors }
  })
  console.log('[compute GPU timings]', JSON.stringify(result))
  expect(result.errors).toEqual([])
  for (const timing of result.timings) {
    expect(timing.count).toBe(40)
    expect(timing.medianMs).toBeGreaterThan(0)
  }
})

for (const option of [
  'cloudFrontRefinement',
  'distantCloudShadows',
  'directionalSkylight',
  'rainShafts'
] as const) {
  test(`realism option changes cloud pixels: ${option}`, async ({ page }) => {
    const caseName = 'sky-horizon-low-sun'
    await page.goto(`/?case=${caseName}&e2e=1&w=640&h=360`)
    await page.waitForFunction(
      () => (window as ParityWindow).__parity?.sideBHandle != null
    )
    const result = await page.evaluate(async option => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext
      p.setShadow(true)
      // Exercise the zero-step fallback inside shadow-map coverage. The
      // orbit camera is outside coverage and correctly preserves the fallback
      if (option === 'distantCloudShadows')
        ctx.clouds.maxIterationCountToSun = 0
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 32,
        resetHistory: true
      })
      const baseline = (await p.readLayer()).data
      ctx.experimental = { [option]: true }
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 32,
        resetHistory: true
      })
      const modified = (await p.readLayer()).data
      let changed = 0
      let error = 0
      for (let i = 0; i < baseline.length; i++) {
        const delta = baseline[i]! - modified[i]!
        if (Math.abs(delta) > 1e-5) changed++
        error += delta * delta
      }
      return {
        changed,
        rmse: Math.sqrt(error / baseline.length),
        count: baseline.length,
        errors: p.errors
      }
    }, option)
    console.log('[realism difference]', option, JSON.stringify(result))
    expect(result.count).toBeGreaterThan(0)
    expect(result.changed).toBeGreaterThan(0)
    expect(result.errors).toEqual([])
  })
}
