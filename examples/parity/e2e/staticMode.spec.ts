// Hardware verification of static mode
//
// Asserts that static mode produces identical pixels to normal rendering
// and measures paired frame time reduction when scene inputs are unchanged

import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'

import { test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

const CASE_NAME = 'baseline-medium'
const PINNED_TIME = 10.0
const PINNED_FRAME = 0
// Past the first skip: static mode waits until the shadow history has
// converged, 688 frames at the default alpha (contextConvergenceFrames)
const WARMUP = 720
const REPEATS = 5
const FRAMES_PER_REP = 20

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
})

test('static mode produces identical visual output on hardware', async ({
  page
}) => {
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE_NAME}&e2e=1&w=640&h=360`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )

  const comparison = await page.evaluate(
    async ({ time, frame, warmup }) => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext

      // 1. Converged baseline with staticMode = false
      ctx.experimental = { ...ctx.experimental, staticMode: false }
      await p.renderOnce('B', { time, frame, warmup, resetHistory: true })
      const plateOff = (await p.readLinear('B')).data

      // 2. Converged render with staticMode = true
      ctx.experimental = { ...ctx.experimental, staticMode: true }
      await p.renderOnce('B', { time, frame, warmup, resetHistory: true })
      const plateOnConverged = (await p.readLinear('B')).data

      // 3. Subsequent idle frame with staticMode = true (reusing output)
      await p.renderOnce('B', { time, frame, warmup: 0, resetHistory: false })
      const plateOnReused = (await p.readLinear('B')).data

      const diff = (a: Float32Array, b: Float32Array) => {
        let error = 0
        let maxAbs = 0
        let changed = 0
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i]! - b[i]!)
          error += d * d
          if (d > maxAbs) maxAbs = d
          if (d > 1e-4) changed++
        }
        return {
          rmse: Math.sqrt(error / a.length),
          maxAbs,
          changedFrac: changed / a.length
        }
      }

      return {
        reusedVsConverged: diff(plateOnConverged, plateOnReused),
        staticVsBaseline: diff(plateOff, plateOnConverged),
        errors: [...p.errors]
      }
    },
    { time: PINNED_TIME, frame: PINNED_FRAME, warmup: WARMUP }
  )

  console.log(
    `[staticMode still] reused vs converged: rmse ${comparison.reusedVsConverged.rmse.toExponential(3)}, maxAbs ${comparison.reusedVsConverged.maxAbs.toExponential(3)}`
  )
  console.log(
    `[staticMode still] static vs baseline: rmse ${comparison.staticVsBaseline.rmse.toExponential(3)}, maxAbs ${comparison.staticVsBaseline.maxAbs.toExponential(3)}`
  )
  expect(comparison.errors).toEqual([])
  // Reused frame in static mode must be bit-identical to converged frame
  expect(comparison.reusedVsConverged.rmse).toBe(0)
  expect(comparison.reusedVsConverged.maxAbs).toBe(0)
  // Static converged output agrees with baseline within temporal noise floor
  expect(comparison.staticVsBaseline.rmse).toBeLessThan(0.01)
})

test('static mode reduces idle-scene frame time', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE_NAME}&e2e=1&w=640&h=360`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )

  const results = await page.evaluate(
    async ({ time, frame, warmup, repeats, framesPerRep }) => {
      const p = (window as ParityWindow).__parity
      const sideB = p.sideBHandle!
      const ctx = sideB.cloudsContext
      const rendererAny = sideB.renderer as unknown as {
        _nodes?: { nodeFrame?: { frameId: number } }
        backend?: {
          device?: { queue?: { onSubmittedWorkDone: () => Promise<void> } }
        }
      }
      const queue = rendererAny.backend?.device?.queue

      const measureArm = async (staticMode: boolean) => {
        ctx.experimental = { ...ctx.experimental, staticMode }
        // Warmup and converge
        await p.renderOnce('B', { time, frame, warmup, resetHistory: true })

        const repTimes: number[] = []
        for (let r = 0; r < repeats; r++) {
          const start = performance.now()
          for (let f = 0; f < framesPerRep; f++) {
            if (rendererAny._nodes?.nodeFrame != null) {
              rendererAny._nodes.nodeFrame.frameId++
            }
            sideB.render()
          }
          if (queue != null) {
            await queue.onSubmittedWorkDone()
          }
          repTimes.push((performance.now() - start) / framesPerRep)
        }
        repTimes.sort((a, b) => a - b)
        const median = repTimes[Math.floor(repTimes.length / 2)]!
        return { repTimes, median }
      }

      const off = await measureArm(false)
      const on = await measureArm(true)

      return { off, on, errors: [...p.errors] }
    },
    {
      time: PINNED_TIME,
      frame: PINNED_FRAME,
      warmup: WARMUP,
      repeats: REPEATS,
      framesPerRep: FRAMES_PER_REP
    }
  )

  console.log(
    `[staticMode timing] off median = ${results.off.median.toFixed(3)} ms, on median = ${results.on.median.toFixed(3)} ms, speedup = ${(results.off.median / results.on.median).toFixed(1)}x`
  )
  expect(results.errors).toEqual([])
  expect(results.on.median).toBeLessThan(results.off.median)
})
