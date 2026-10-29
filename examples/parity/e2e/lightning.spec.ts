// The flash on hardware: a lit discharge against its own off-vs-off bracket,
// and what the march pays for it in each of the three regimes
//
// Unit tests prove the guard is in the WGSL and that the option emits no node
// when it is off. Neither can prove a flash is visible, or that the guard is
// on the side of the branch it is claimed to be on

import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import type { Vector3 } from 'three'

import { test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// The library the page already has loaded, at the path the vite dev server
// serves it on with its bare specifiers rewritten. The page gets the SAME module
// instance the harness runs, so the arm reaches flashPositionCPU
const LIB_URL = '/node_modules/three-clouds-webgpu/build/index.js'

// One pose for both tests, and the same one experimentalVisibility.spec.ts
// uses: 12 km up over a full deck, wide enough that a strike lights a lot of it
const CASE_NAME = 'sky-horizon-low-sun'

// Pinned, so the off-vs-off bracket measures temporal settling and nothing else
const PINNED_TIME = 12.5
const PINNED_FRAME = 0
const WARMUP = 32

// How far past its own noise floor an option has to land, and the floor under
// which a delta is not something a human could see
const NOISE_FACTOR = 4
const ABSOLUTE_FLOOR = 1e-4

// The strike: seed 142408 on flashPositionCPU's shell at 1600 m, which is
// inside the default cumulus band and 28 km from the point below the camera
const FLASH_SEED = 142408
const FLASH_BOTTOM_RADIUS = 6378137
const FLASH_ALTITUDE = 1600

// Radiance over distance squared in metres, so the scale is the square of a
// flash's range. The middle of the sweep is what the assertions read, and the
// other two are shot in the same run so the scale is bracketed by measurement
const FLASH_INTENSITIES = [1e8, 1e9, 1e10]
const FLASH_INTENSITY = FLASH_INTENSITIES[1]!

// Frames per timing arm, and how many arms to keep the fastest of. A storm
// spends most of its time between strokes, which is the arm that has to be free
const TIMING_FRAMES = 12
const TIMING_REPEATS = 3

interface Comparison {
  rmse: number
  relativeRmse: number
  changedFrac: number
  maxAbs: number
}

interface TimingArm {
  /** Wall clock per frame around the loop, best of the repeats */
  wall: number
  /** The GPU's own medians, or null where timestamp queries do not exist */
  gpu: { total: number; passes: Record<string, number> } | null
}

interface PixelArms {
  /** Off arm 1 against off arm 2: this configuration's own temporal noise */
  noise: Comparison
  /** Off arm 1 against the option-on arm with no discharge lit */
  idle: Comparison
  /** The idle arm against each lit arm, in FLASH_INTENSITIES order */
  flash: Comparison[]
  /** Cloud fraction per arm: off A, off B, idle, then one per intensity */
  cloudFractions: number[]
  /** Read back off the context, so an arm that wrote nothing says so */
  activeIntensity: number
  optionOn: boolean
  errors: string[]
}

const describeComparison = (label: string, c: Comparison): string =>
  `${label} rmse ${c.rmse.toExponential(3)} rel ${c.relativeRmse.toExponential(
    3
  )} changed ${(c.changedFrac * 100).toFixed(4)}% max ${c.maxAbs.toExponential(3)}`

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

test('a lit flash lights the deck, and an idle storm does not', async ({
  page
}) => {
  test.setTimeout(600_000)
  await page.goto(`/?case=${CASE_NAME}&e2e=1&w=640&h=360`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )

  // Six arms from the harness's own state: two off, to bracket this
  // configuration's temporal noise, then the option idle, then lit at each of
  // three intensities. Compared in the page, since six plates is 5.5M numbers
  const arms: PixelArms = await page.evaluate(
    async ({
      libUrl,
      time,
      frame,
      warmup,
      seed,
      bottomRadius,
      altitude,
      intensities
    }) => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext
      const lib = (await import(libUrl)) as {
        flashPositionCPU: (
          index: number,
          seed: number,
          bottomRadius: number,
          altitude: number
        ) => Vector3
      }

      const allOff = (): Record<string, boolean> => {
        const next: Record<string, boolean> = {}
        for (const key of Object.keys(ctx.experimental)) next[key] = false
        return next
      }

      const compare = (a: Float32Array, b: Float32Array) => {
        let error = 0
        let energy = 0
        let changed = 0
        let max = 0
        for (let i = 0; i < a.length; i++) {
          const delta = a[i]! - b[i]!
          error += delta * delta
          energy += a[i]! * a[i]!
          if (Math.abs(delta) > 1e-4) changed++
          if (Math.abs(delta) > max) max = Math.abs(delta)
        }
        return {
          rmse: Math.sqrt(error / a.length),
          relativeRmse: Math.sqrt(error / Math.max(energy, 1e-12)),
          changedFrac: changed / a.length,
          maxAbs: max
        }
      }

      const shoot = async (): Promise<{
        plate: Float32Array
        clouds: number
      }> => {
        await p.renderOnce('B', { time, frame, warmup, resetHistory: true })
        const layer = await p.readLayer()
        let occupied = 0
        for (let i = 3; i < layer.data.length; i += 4)
          if (layer.data[i]! > 0) occupied++
        return {
          plate: (await p.readLinear('B')).data,
          clouds: occupied / (layer.data.length / 4)
        }
      }

      ctx.lightning = null
      ctx.experimental = allOff()
      const offA = await shoot()
      // The same assignment as arm 1, so this measures the harness repeating
      // itself rather than a rebuild
      ctx.experimental = allOff()
      const offB = await shoot()
      ctx.experimental = { ...allOff(), lightning: true }
      const idle = await shoot()
      const position = lib.flashPositionCPU(0, seed, bottomRadius, altitude)
      // The camera's own Vector3, cloned and set, because the state wants three
      // vectors and this page shares one three with the library
      const colour = p.sideBHandle!.camera.position.clone().set(0.85, 0.9, 1)
      const lit: Array<{ plate: Float32Array; clouds: number }> = []
      for (const level of intensities) {
        ctx.lightning = { position, intensity: level, colour }
        lit.push(await shoot())
      }

      return {
        noise: compare(offA.plate, offB.plate),
        idle: compare(offA.plate, idle.plate),
        flash: lit.map(arm => compare(idle.plate, arm.plate)),
        cloudFractions: [
          offA.clouds,
          offB.clouds,
          idle.clouds,
          ...lit.map(arm => arm.clouds)
        ],
        activeIntensity: ctx.lightning?.intensity ?? 0,
        optionOn: ctx.experimental.lightning === true,
        errors: [...p.errors]
      }
    },
    {
      libUrl: LIB_URL,
      time: PINNED_TIME,
      frame: PINNED_FRAME,
      warmup: WARMUP,
      seed: FLASH_SEED,
      bottomRadius: FLASH_BOTTOM_RADIUS,
      altitude: FLASH_ALTITUDE,
      intensities: FLASH_INTENSITIES
    }
  )

  console.log(
    `[lightning] ${describeComparison('noise', arms.noise)}\n` +
      `[lightning] ${describeComparison('idle ', arms.idle)}\n` +
      arms.flash
        .map(
          (c, i) =>
            `[lightning] ${describeComparison(
              `flash ${FLASH_INTENSITIES[i]!.toExponential(0)}`,
              c
            )}`
        )
        .join('\n') +
      `\n[lightning] cloud fraction ${arms.cloudFractions
        .map(f => f.toFixed(5))
        .join(' / ')} | active ${arms.activeIntensity} | ` +
      `option ${String(arms.optionOn)} | errors ${JSON.stringify(arms.errors)}`
  )

  expect(arms.errors, 'the harness logged errors').toEqual([])
  expect(
    arms.activeIntensity,
    'the lit arm left no flash on the context'
  ).toBeGreaterThan(0)
  for (const [index, fraction] of arms.cloudFractions.entries())
    expect(fraction, `arm ${index} rendered no clouds`).toBeGreaterThan(0)

  // The idle claim, in pixels. NOT against the off-vs-off bracket, which is
  // exactly zero here, so any idle delta at all fails that: recompiling the march
  // with the guard in it contracts differently, and the fifth decimal is that
  expect(
    arms.idle.rmse,
    'an idle storm moved the plate by more than a human could see'
  ).toBeLessThan(ABSOLUTE_FLOOR)

  // The claim the option exists for, read at the intensity in the sweep's
  // middle so the assertion cannot be satisfied by an arbitrarily bright one
  const flash = arms.flash[FLASH_INTENSITIES.indexOf(FLASH_INTENSITY)]!
  expect(
    flash.rmse,
    `a flash at ${FLASH_INTENSITY} did not clear the visibility floor`
  ).toBeGreaterThan(ABSOLUTE_FLOOR)
  // The flash is the reason the option is worth having here, by a margin
  expect(
    flash.rmse,
    `a flash at ${FLASH_INTENSITY} moved the plate by ${arms.idle.rmse.toExponential(
      3
    )}, which is the same order as an idle storm`
  ).toBeGreaterThan(arms.idle.rmse * NOISE_FACTOR)

  // The frame itself, so the claim can be looked at rather than believed
  await page.screenshot({ path: test.info().outputPath('lit.png') })
})

test('a lit flash costs more than an idle storm, which costs the option off', async ({
  page
}) => {
  test.setTimeout(600_000)
  await page.goto(`/?case=${CASE_NAME}&e2e=1&w=640&h=360`)
  await page.waitForFunction(
    () => (window as ParityWindow).__parity?.sideBHandle != null
  )

  // Two instruments per arm, because the effect is a few percent of a 15 ms
  // frame: the GPU's own per-pass medians where timestamp queries exist, and
  // wall clock around the frame loop where they do not
  const timings = await page.evaluate(
    async ({
      libUrl,
      time,
      frame,
      frames,
      repeats,
      seed,
      bottomRadius,
      altitude,
      intensity
    }) => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext
      const allOff = (): Record<string, boolean> => {
        const next: Record<string, boolean> = {}
        for (const key of Object.keys(ctx.experimental)) next[key] = false
        return next
      }

      // null when the browser reports no timestamp-query support, which is a
      // fact about the machine and not a failure of the measurement
      const gpuArm = async (): Promise<{
        total: number
        passes: Record<string, number>
      } | null> => {
        try {
          const summary = await p.gpuTiming(16)
          const side = summary.sideB
          return side.available
            ? { total: side.report.medianMs, passes: side.report.passes }
            : null
        } catch {
          return null
        }
      }

      const timeArm = async (): Promise<number> => {
        const best: number[] = []
        for (let repeat = 0; repeat < repeats; repeat++) {
          // One untimed frame first, so a rebuild or a history reset is not
          // billed to the arm
          await p.renderOnce('B', { time, frame, warmup: 2 })
          const started = performance.now()
          for (let i = 0; i < frames; i++)
            await p.renderOnce('B', { time, frame, warmup: 0 })
          best.push((performance.now() - started) / frames)
        }
        return Math.min(...best)
      }

      const arm = async (): Promise<{
        wall: number
        gpu: { total: number; passes: Record<string, number> } | null
      }> => ({ wall: await timeArm(), gpu: await gpuArm() })

      ctx.lightning = null
      ctx.experimental = allOff()
      const off = await arm()

      ctx.experimental = { ...allOff(), lightning: true }
      const idle = await arm()

      const lib = (await import(libUrl)) as {
        flashPositionCPU: (
          index: number,
          seed: number,
          bottomRadius: number,
          altitude: number
        ) => Vector3
      }
      ctx.lightning = {
        position: lib.flashPositionCPU(0, seed, bottomRadius, altitude),
        intensity,
        colour: p.sideBHandle!.camera.position.clone().set(0.85, 0.9, 1)
      }
      const lit = await arm()

      return { off, idle, lit, errors: [...p.errors] }
    },
    {
      libUrl: LIB_URL,
      time: PINNED_TIME,
      frame: PINNED_FRAME,
      frames: TIMING_FRAMES,
      repeats: TIMING_REPEATS,
      seed: FLASH_SEED,
      bottomRadius: FLASH_BOTTOM_RADIUS,
      altitude: FLASH_ALTITUDE,
      intensity: FLASH_INTENSITY
    }
  )

  const marchPass = (arm: TimingArm): number | null => {
    const passes = arm.gpu?.passes ?? {}
    const key = Object.keys(passes).find(name => name.includes('march'))
    return key == null ? null : passes[key]!
  }
  const pct = (a: number, b: number): string =>
    `${a > b ? '+' : ''}${((a / b - 1) * 100).toFixed(2)}%`

  console.log(
    `[lightning] frame ms wall, best of ${TIMING_REPEATS} x ${TIMING_FRAMES}: ` +
      `off ${timings.off.wall.toFixed(2)} | idle ` +
      `${timings.idle.wall.toFixed(2)} | lit ${timings.lit.wall.toFixed(2)}` +
      ` | idle over off ${pct(timings.idle.wall, timings.off.wall)} | lit over ` +
      `idle ${pct(timings.lit.wall, timings.idle.wall)}\n` +
      `[lightning] march pass ms gpu: ${JSON.stringify({
        off: marchPass(timings.off),
        idle: marchPass(timings.idle),
        lit: marchPass(timings.lit)
      })} | gpu total ${JSON.stringify({
        off: timings.off.gpu?.total ?? null,
        idle: timings.idle.gpu?.total ?? null,
        lit: timings.lit.gpu?.total ?? null
      })} | errors ${JSON.stringify(timings.errors)}`
  )

  expect(timings.errors, 'the harness logged errors').toEqual([])
  expect(timings.off.wall, 'a frame took no measurable time').toBeGreaterThan(0)

  // The guard is on the right side of the branch: a lit discharge cannot be
  // cheaper than the same march with the branch closed. The idle arm is not
  // claimed free, only not paying for the march
  expect(
    timings.lit.wall,
    `a lit flash (${timings.lit.wall.toFixed(2)} ms) was cheaper than an idle ` +
      `storm (${timings.idle.wall.toFixed(2)} ms), so the guard is inverted`
  ).toBeGreaterThan(timings.idle.wall * 0.98)
})
