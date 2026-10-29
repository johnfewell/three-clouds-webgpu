// The cirrus deck on hardware: the option must reach the frame, past the
// configuration's own off-vs-off noise, and its strength must be what moves it
// The cost half is a GPU timestamp measurement, so it skips without hardware

import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'

import { test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// A camera on the ground looking straight up, so most of the frame is sky the
// deck covers, with the case's own 60 degree sun
const CASE = 'surface-up'

// The context fields this spec writes, which the page's own type does not
// narrow to
interface DeckContext {
  experimental: Record<string, boolean>
  cirrusDeck: { strength: number }
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
})

test('the cirrus deck changes the sky, and its strength is what changes it', async ({
  page
}) => {
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE}&e2e=1&w=640&h=360`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const ctx = p.sideBHandle!.cloudsContext as unknown as DeckContext
    const shoot = async (deck: boolean, strength: number) => {
      ctx.experimental = { cirrusDeck: deck }
      ctx.cirrusDeck.strength = strength
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 32,
        resetHistory: true
      })
      return (await p.readLinear('B')).data
    }
    const compare = (a: Float32Array, b: Float32Array) => {
      let error = 0
      let changed = 0
      let brighter = 0
      for (let i = 0; i < a.length; i++) {
        const delta = b[i]! - a[i]!
        error += delta * delta
        if (Math.abs(delta) > 1e-4) changed++
        if (delta > 1e-4) brighter++
      }
      return {
        rmse: Math.sqrt(error / a.length),
        changedFrac: changed / a.length,
        brighterFrac: brighter / a.length
      }
    }
    const off1 = await shoot(false, 0.7)
    const off2 = await shoot(false, 0.7)
    // The graph with the deck in it at zero opacity: the inert control. It
    // must sit inside the off bracket, or something other than the deck's
    // opacity is moving the frame
    const inert = await shoot(true, 0)
    const on = await shoot(true, 0.7)
    return {
      count: on.length,
      noise: compare(off1, off2),
      inert: compare(off1, inert),
      delta: compare(off1, on),
      finite: Array.from(on).every(Number.isFinite),
      errors: p.errors
    }
  })
  console.log('[cirrus-deck]', JSON.stringify(result))
  expect(result.count).toBeGreaterThan(0)
  expect(result.finite).toBe(true)
  expect(result.errors).toEqual([])
  // Four times the noise floor, plus an absolute floor so a near-zero bracket
  // cannot make a speck pass
  expect(result.delta.rmse).toBeGreaterThan(4 * result.noise.rmse)
  expect(result.delta.rmse).toBeGreaterThan(1e-3)
  // A thin bright sheet over a blue sky lifts it: most changed samples brighten
  expect(result.delta.brighterFrac).toBeGreaterThan(
    0.5 * result.delta.changedFrac
  )
  // The harness is deterministic, so the off bracket is exactly 0, but strength
  // 0 is a different shader and its float scheduling moves a few samples by
  // 1e-5. Measured at 0.04 % of the deck's own effect on hardware
  expect(result.inert.rmse).toBeLessThan(0.01 * result.delta.rmse)
  await page.screenshot({ path: test.info().outputPath('cirrus-deck-on.png') })
})

test('the cirrus deck costs one texture read per march fragment', async ({
  page
}) => {
  test.skip(process.env.PARITY_GPU !== 'hardware', 'Hardware timing')
  test.setTimeout(300_000)
  await page.goto(`/?case=${CASE}&e2e=1&w=1920&h=1080`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )
  const result = await page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const handle = p.sideBHandle!
    const ctx = handle.cloudsContext as unknown as DeckContext
    // staticMode.spec.ts's clock: back-to-back frames drained by the queue, so
    // a GPU-bound frame's wall time is its GPU time. The renderer's timestamp
    // read back negative garbage here
    const renderer = handle.renderer as unknown as {
      _nodes?: { nodeFrame?: { frameId: number } }
      backend?: {
        device?: { queue?: { onSubmittedWorkDone: () => Promise<void> } }
      }
    }
    const queue = renderer.backend?.device?.queue
    const arm = async (deck: boolean) => {
      ctx.experimental = { cirrusDeck: deck }
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 32,
        resetHistory: true
      })
      const reps: number[] = []
      for (let r = 0; r < 9; r++) {
        const start = performance.now()
        for (let f = 0; f < 10; f++) {
          if (renderer._nodes?.nodeFrame != null) {
            renderer._nodes.nodeFrame.frameId++
          }
          handle.render()
        }
        await queue?.onSubmittedWorkDone()
        reps.push((performance.now() - start) / 10)
      }
      reps.sort((a, b) => a - b)
      return reps[4]!
    }
    // off, on, on, off: the two off arms are the drift the delta must clear
    const off1 = await arm(false)
    const on1 = await arm(true)
    const on2 = await arm(true)
    const off2 = await arm(false)
    return {
      off: [off1, off2],
      on: [on1, on2],
      hasQueue: queue != null,
      errors: p.errors
    }
  })
  const off = (result.off[0]! + result.off[1]!) / 2
  const on = (result.on[0]! + result.on[1]!) / 2
  const drift = Math.abs(result.off[1]! - result.off[0]!)
  console.log(
    '[cirrus-deck-cost]',
    JSON.stringify({
      ...result,
      offMs: off,
      onMs: on,
      deltaMs: on - off,
      driftMs: drift,
      relative: (on - off) / off
    })
  )
  expect(result.errors).toEqual([])
  expect(result.hasQueue).toBe(true)
  expect(off).toBeGreaterThan(0)
  // One texture read and a handful of LUT reads per march fragment, against a
  // march of hundreds of steps: a quarter of the frame means the deck is doing
  // far more than the docs claim
  expect((on - off) / off).toBeLessThan(0.25)
})
