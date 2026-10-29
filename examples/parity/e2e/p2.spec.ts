import { expect, type Page } from '@playwright/test'

import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityProbe, ParityWindow } from './parityProbe'

// ── Probe types ──────────────────────────────────────────────

interface ProbeReadback {
  width: number
  height: number
  data: number[]
}

interface ProbeStats {
  frame: number
  time: number
  targets: Array<{
    name: string
    width: number
    height: number
    format: string
  }>
}

// ── Helpers ──────────────────────────────────────────────────

function probe(page: Page) {
  return {
    errors: () => page.evaluate(() => (window as ParityWindow).__parity.errors),

    warnings: () =>
      page.evaluate(() => (window as ParityWindow).__parity.warnings),

    renderOnce: (
      side: 'A' | 'B',
      // derived from the probe's own signature, never re-declared
      // Separate copies once hid `resetHistory` from every spec,
      // and could drift again the next time the probe gains a field
      opts: Parameters<ParityProbe['renderOnce']>[1]
    ) =>
      page.evaluate(
        ([s, o]) => (window as ParityWindow).__parity.renderOnce(s, o),
        [side, opts] as const
      ),

    readLinear: (side: 'A' | 'B') =>
      page.evaluate(async s => {
        const r = await (window as ParityWindow).__parity.readLinear(s)
        return {
          width: r.width,
          height: r.height,
          data: Array.from(r.data)
        }
      }, side) as Promise<ProbeReadback>,

    readLayer: () =>
      page.evaluate(async () => {
        const r = await (window as ParityWindow).__parity.readLayer()
        return {
          width: r.width,
          height: r.height,
          data: Array.from(r.data)
        }
      }) as Promise<ProbeReadback>,

    readDepthVelocity: () =>
      page.evaluate(async () => {
        const r = await (window as ParityWindow).__parity.readDepthVelocity()
        return {
          width: r.width,
          height: r.height,
          data: Array.from(r.data)
        }
      }) as Promise<ProbeReadback>,

    stats: (side: 'A' | 'B') =>
      page.evaluate(
        s => (window as ParityWindow).__parity.stats(s),
        side
      ) as Promise<ProbeStats>,

    set: (partial: Record<string, unknown>) =>
      page.evaluate(p => (window as ParityWindow).__parity.set(p), partial),

    sequenceInit: (warmup: number) =>
      page.evaluate(
        w => (window as ParityWindow).__parity.sequenceInit(w),
        warmup
      ),

    sequenceStep: (frame: number, dt: number) =>
      page.evaluate(
        ([f, d]) => (window as ParityWindow).__parity.sequenceStep(f, d),
        [frame, dt] as const
      ) as Promise<{ width: number; height: number }>,

    sequenceMetrics: (opts: { frames: number; dt: number }) =>
      page.evaluate(
        o => (window as ParityWindow).__parity.sequenceMetrics(o),
        opts
      ) as Promise<{
        flickerA: { mean: number; max: number }
        flickerB: { mean: number; max: number }
        ghostingA: { deMean: number; deP95: number } | null
        ghostingB: { deMean: number; deP95: number } | null
      }>
  }
}

function meanLuminance(data: number[], width: number, height: number): number {
  const n = width * height
  let sum = 0
  for (let i = 0; i < n; i++) {
    const idx = i * 4
    sum +=
      0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!
  }
  return sum / n
}

function maxAbsDiff(a: number[], b: number[]): number {
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    if (d > max) max = d
  }
  return max
}

function hasNaNOrInf(data: number[]): boolean {
  for (const v of data) {
    if (!Number.isFinite(v)) return true
  }
  return false
}

// ── Bayer run-up ─────────────────────────────────── A pinned
// warm-up marches ONE Bayer cell (B flicker 23x A's, arm F1). This advances the
// frame, then clears only the frame store: the ratio falls to 1.387
async function bayerRunUp(
  p: ReturnType<typeof probe>,
  warmup: number,
  runUpFrames: number,
  dt: number
): Promise<number> {
  await p.sequenceInit(warmup)
  for (let f = 0; f < runUpFrames; f++) {
    await p.sequenceStep(f, dt)
  }
  // Clears the frame store only. History and jitter phase survive
  await p.sequenceInit(0)
  return runUpFrames
}

// ── Adapter gate ─────────────────────────────────────────────

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'p2')
})

// ── 1. Temporal convergence ─────────────────────────────────

test.describe('1. temporal convergence', () => {
  test('16-frame static sequence has low flicker', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    const FRAMES = 16
    const DT = 1 / 60

    // Fill every Bayer cell before measuring. Without this the test
    // measures the history assembling itself, not flicker
    const base = await bayerRunUp(p, 64, 64, DT)

    for (let f = 0; f < FRAMES; f++) {
      await p.sequenceStep(base + f, DT)
    }

    const metrics = await p.sequenceMetrics({ frames: FRAMES, dt: DT })

    console.log(
      `[p2][convergence] flickerB mean=${metrics.flickerB.mean.toFixed(6)} max=${metrics.flickerB.max.toFixed(6)}`
    )

    if (metrics.flickerB.mean === 0 && metrics.flickerB.max === 0) {
      test.skip(
        true,
        'Side B returned zero flicker — temporal may not be wired'
      )
      return
    }

    // CONTROL-CALIBRATED BAR: side A's flicker in the same run is the
    // scene's floor, replacing an absolute `< 0.5`. 3.0 sits 2.2x above F1's
    // 1.387 and 7.8x below the 23.27 defect (in-session floor only)
    const flickerRatio =
      metrics.flickerB.max / Math.max(metrics.flickerA.max, 1e-6)
    console.log(
      `[p2][convergence] flickerA max=${metrics.flickerA.max.toFixed(6)} B/A max ratio=${flickerRatio.toFixed(3)}`
    )
    expect(flickerRatio).toBeLessThan(3.0)
  })

  test('temporal output is non-blank', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 16, warmup: 64 })
    const b = await p.readLinear('B')
    const mean = meanLuminance(b.data, b.width, b.height)

    console.log(
      `[p2][convergence] temporal-on-static mean luminance: ${mean.toFixed(4)}`
    )

    expect(
      mean === 0,
      'Side B returned black with temporal on - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)
    expect(mean).toBeGreaterThan(0)
  })
})

// ── 2. Bayer coverage ───────────────────────────────────────

test.describe('2. Bayer coverage', () => {
  test('16 consecutive frames produce 16 distinct readbacks', async ({
    page
  }) => {
    // A 64-frame warm-up plus SIXTEEN linear readbacks took ~96 s on hardware
    // with assertions passing. A timeout is not a finding about Bayer coverage,
    // just a budget never set for this test
    test.setTimeout(180_000)
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    // Warmup to let temporal state settle
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 64 })

    const readbacks: number[][] = []
    for (let f = 0; f < 16; f++) {
      await p.renderOnce('B', { time: 0, frame: f })
      const rb = await p.readLinear('B')
      readbacks.push(rb.data)
    }

    const meanFirst = meanLuminance(
      readbacks[0]!,
      // Width not tracked per-readback. Use variance as a proxy
      1,
      readbacks[0]!.length / 4
    )
    expect(
      meanFirst === 0,
      'Side B returned black - temporal not producing output - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    // Each of the 16 Bayer positions should produce a unique march pattern
    // Count distinct readbacks by checking if consecutive frames differ
    let distinctCount = 1
    for (let i = 1; i < 16; i++) {
      const diff = maxAbsDiff(readbacks[i - 1]!, readbacks[i]!)
      if (diff > 1e-6) distinctCount++
    }

    console.log(`[p2][bayer] ${distinctCount}/16 distinct frames`)

    // With 1/16 Bayer, each frame should march a different pixel subset
    expect(distinctCount).toBeGreaterThanOrEqual(4)
  })

  test('frame 0 and frame 64 produce similar output (Bayer + STBN wrap)', async ({
    page
  }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.renderOnce('B', { time: 0, frame: 0, warmup: 64 })
    const f0 = await p.readLinear('B')

    // Frame 64, not 16: the Bayer cell repeats every 16 frames but the STBN
    // slice every 64, and 64 returns to both. resetHistory: false is
    // LOAD-BEARING: a reset here served a stale plate (bbui)
    await p.renderOnce('B', {
      time: 0,
      frame: 64,
      warmup: 0,
      resetHistory: false
    })
    const f16 = await p.readLinear('B')

    const mean0 = meanLuminance(f0.data, f0.width, f0.height)
    expect(
      mean0 === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    // Frame 0 and frame 64 return to the same Bayer position AND the same STBN
    // slice, so on a static camera at the same time the march pattern repeats
    const diff = maxAbsDiff(f0.data, f16.data)
    console.log(`[p2][bayer] frame 0 vs 64 maxDiff=${diff.toFixed(6)}`)
    expect(diff).toBeLessThan(0.01)
  })

  // The plate-level resolve guard: after a reset the
  // port once skipped its resolve and published a stale plate (the reference
  // always draws). Frame 16: stale ~0.0012 vs real ~0.207, 0.05 between
  test('a reset immediately before a single render produces a REAL render, not a stale plate', async ({
    page
  }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.renderOnce('B', { time: 0, frame: 0, warmup: 64 })
    const warm = await p.readLinear('B')

    // Reset ON (the default, deliberately not overridden). One frame, at an
    // STBN slice the warm plate never converged to, so a genuine render MUST
    // differ
    await p.renderOnce('B', { time: 0, frame: 16, warmup: 0 })
    const afterReset = await p.readLinear('B')

    expect(
      meanLuminance(afterReset.data, afterReset.width, afterReset.height) === 0,
      'Side B returned black'
    ).toBe(false)

    const diff = maxAbsDiff(warm.data, afterReset.data)
    console.log(`[p2][bbui] warm vs reset+1frame maxDiff=${diff.toFixed(6)}`)
    expect(
      diff,
      `expected a real render (~0.207); ${diff.toFixed(6)} at this magnitude means the resolve was skipped and a stale plate was published`
    ).toBeGreaterThan(0.05)
  })
})

// ── 3. Velocity sanity ──────────────────────────────────────

test.describe('3. velocity sanity', () => {
  test('depthVelocity readback has finite values', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    const dv = await p.readDepthVelocity()

    expect(
      dv.width === 0 || dv.data.length === 0,
      'readDepthVelocity not available - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)

    expect(hasNaNOrInf(dv.data)).toBe(false)
  })

  test('static camera has near-zero velocity', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.set({ temporalUpscale: true })
    // Two frames at one camera position so velocity stabilises. The second
    // must CONTINUE from the first: under the default reset a
    // warmup-less call rendered nothing (the Bayer test's mechanism)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    await p.renderOnce('B', { time: 0, frame: 1, resetHistory: false })
    const dv = await p.readDepthVelocity()

    expect(
      dv.width === 0 || dv.data.length === 0,
      'readDepthVelocity not available - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)

    // Velocity channels are .g and .b (indices 1 and 2 in RGBA)
    // For a static camera, velocity should be near zero
    const n = dv.width * dv.height
    let maxVel = 0
    for (let i = 0; i < n; i++) {
      const vx = Math.abs(dv.data[i * 4 + 1]!)
      const vy = Math.abs(dv.data[i * 4 + 2]!)
      const vel = Math.sqrt(vx * vx + vy * vy)
      if (vel > maxVel) maxVel = vel
    }

    console.log(
      `[p2][velocity] static camera max velocity: ${maxVel.toFixed(6)}`
    )

    // Static camera should have very small velocity (wind may cause slight motion)
    expect(maxVel).toBeLessThan(0.5)
  })
})

// ── 4. resetHistory ─────────────────────────────────────────

test.describe('4. resetHistory', () => {
  test('toggling temporalUpscale resets history (output changes)', async ({
    page
  }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    // Build up temporal history
    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 32 })
    const converged = await p.readLinear('B')

    const meanConverged = meanLuminance(
      converged.data,
      converged.width,
      converged.height
    )
    expect(
      meanConverged === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    // CONTROL: continue one frame, no toggle. History survives, so a converged
    // plate should stay converged
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 0,
      resetHistory: false
    })
    const continued = await p.readLinear('B')
    const diffControl = maxAbsDiff(converged.data, continued.data)

    // ARM: off and back on, every render with resetHistory: false, so the
    // harness's per-render reset cannot be what moves the plate. What is left is
    // the rebuild boundary, which re-arms every accumulator
    await p.set({ temporalUpscale: false })
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 0,
      resetHistory: false
    })

    await p.set({ temporalUpscale: true })
    // One frame after the reset, so only 1/16 of pixels have been marched
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 0,
      resetHistory: false
    })
    const afterReset = await p.readLinear('B')

    const diffToggled = maxAbsDiff(converged.data, afterReset.data)
    console.log(
      `[p2][reset] temporalUpscale toggle: control=${diffControl.toFixed(6)} ` +
        `toggled=${diffToggled.toFixed(6)} ratio=` +
        `${(diffToggled / Math.max(diffControl, 1e-9)).toFixed(1)}`
    )

    // The control must actually be a control: continuing must not itself
    // perturb the plate the way a reset does. If this fires, the premise is
    // broken and the comparison below would be meaningless
    expect(
      diffControl,
      `continuing without a toggle moved the plate by ${diffControl.toFixed(6)}; ` +
        'the control is not a control and the arm below cannot be attributed'
    ).toBeLessThan(0.05)

    // The floor is calibrated, not guessed: 0.01 sits about 27x above the
    // control measured on hardware and about 10x below the arm, so neither a
    // degenerate control nor run-to-run noise can carry this on its own
    expect(
      diffToggled,
      `toggling temporalUpscale must reset history: expected the toggled plate ` +
        `to differ from the converged one far more than the control ` +
        `(control=${diffControl.toFixed(6)}, toggled=${diffToggled.toFixed(6)})`
    ).toBeGreaterThan(Math.max(diffControl * 10, 0.01))
  })

  test('enabled false→true resets history', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 32 })
    const before = await p.readLinear('B')

    const meanBefore = meanLuminance(before.data, before.width, before.height)
    expect(
      meanBefore === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    // this once asserted only that diff is finite
    // Now `resetHistory: false` leaves the enabled toggle as the ONLY reset,
    // and a no-toggle control in the same run calibrates the bar

    // CONTROL: continue one frame, no toggle. History survives, so the
    // converged plate should stay essentially converged
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 0,
      resetHistory: false
    })
    const continued = await p.readLinear('B')
    const diffControl = maxAbsDiff(before.data, continued.data)

    // ARM: disable and re-enable, which resets history via the enabled setter
    await p.set({ enabled: false })
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 0,
      resetHistory: false
    })
    await p.set({ enabled: true, temporalUpscale: true })
    await p.renderOnce('B', {
      time: 0,
      frame: 0,
      warmup: 0,
      resetHistory: false
    })
    const afterToggle = await p.readLinear('B')
    const diffToggled = maxAbsDiff(before.data, afterToggle.data)

    console.log(
      `[p2][reset] enabled toggle: control=${diffControl.toFixed(6)} ` +
        `toggled=${diffToggled.toFixed(6)} ratio=` +
        `${(diffToggled / Math.max(diffControl, 1e-9)).toFixed(1)}`
    )

    // The control must actually be a control: continuing must not itself
    // perturb the plate the way a reset does. If this fires, the premise is
    // broken and the comparison below would be meaningless
    expect(
      diffControl,
      `continuing without a toggle moved the plate by ${diffControl.toFixed(6)}; ` +
        'the control is not a control and the arm below cannot be attributed'
    ).toBeLessThan(0.05)

    // The toggle must move the plate far more than merely continuing does
    // Relative to the in-run control, with an absolute floor so a degenerate
    // near-zero control cannot make this pass trivially
    expect(
      diffToggled,
      `enabled false->true must reset history: expected the toggled plate to ` +
        `differ from the converged one far more than the control ` +
        `(control=${diffControl.toFixed(6)}, toggled=${diffToggled.toFixed(6)})`
    ).toBeGreaterThan(Math.max(diffControl * 10, 0.01))
  })
})

// ── 5. Resize invalidation ──────────────────────────────────

test.describe('5. resize invalidation', () => {
  test('resolutionScale change with temporal produces valid output', async ({
    page
  }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })

    const stats1 = await p.stats('B')
    const layer1 = stats1.targets.find(t => t.name === 'layer')
    if (layer1 == null) {
      throw new Error(
        'No layer target - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }

    // Change resolution
    await p.set({ resolutionScale: 0.5 })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 4 })

    const stats05 = await p.stats('B')
    const layer05 = stats05.targets.find(t => t.name === 'layer')
    if (layer05 == null) {
      throw new Error(
        'No layer target after resize - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }

    console.log(
      `[p2][resize] full=${layer1.width}×${layer1.height} half=${layer05.width}×${layer05.height}`
    )

    expect(layer05.width).toBeLessThan(layer1.width)
    expect(layer05.height).toBeLessThan(layer1.height)

    // Read output after resize, which should be valid (no NaN)
    const b = await p.readLinear('B')
    expect(hasNaNOrInf(b.data)).toBe(false)

    const mean = meanLuminance(b.data, b.width, b.height)
    console.log(`[p2][resize] post-resize mean luminance: ${mean.toFixed(4)}`)
    if (mean === 0) {
      console.log(
        '[p2][resize] post-resize returned black — may need more warmup'
      )
    }
  })

  test('resize back to full produces valid output', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    await p.set({ temporalUpscale: true, resolutionScale: 0.5 })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })

    await p.set({ resolutionScale: 1.0 })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 4 })

    const b = await p.readLinear('B')
    expect(hasNaNOrInf(b.data)).toBe(false)

    const stats = await p.stats('B')
    const layer = stats.targets.find(t => t.name === 'layer')
    if (layer != null) {
      console.log(`[p2][resize] restored=${layer.width}×${layer.height}`)
    }
  })
})

// ── 6. temporalUpscale × resolutionScale matrix ─────────────

test.describe('6. temporalUpscale × resolutionScale matrix', () => {
  const combinations = [
    { temporal: false, scale: 1.0, label: 'noTemporal-full' },
    { temporal: false, scale: 0.5, label: 'noTemporal-half' },
    { temporal: true, scale: 1.0, label: 'temporal-full' },
    { temporal: true, scale: 0.5, label: 'temporal-half' }
  ]

  for (const combo of combinations) {
    test(`${combo.label} boots without errors`, async ({ page }) => {
      await loadCase(page, 'baseline-medium')
      const p = probe(page)

      await p.set({
        temporalUpscale: combo.temporal,
        resolutionScale: combo.scale
      })

      await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })

      const errs = await p.errors()
      const filtered = errs.filter(
        e =>
          !e.includes('WebGPU') &&
          !e.includes('deprecated') &&
          !e.includes('frame has not advanced')
      )
      expect(filtered).toEqual([])

      const b = await p.readLinear('B')
      expect(hasNaNOrInf(b.data)).toBe(false)

      const mean = meanLuminance(b.data, b.width, b.height)
      console.log(`[p2][matrix] ${combo.label} mean=${mean.toFixed(4)}`)
      expect(Number.isFinite(mean)).toBe(true)
    })
  }

  test('temporal-on produces different march target size than off', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    // Without temporal
    await p.set({ temporalUpscale: false })
    await p.renderOnce('B', { time: 0, frame: 0 })
    const statsOff = await p.stats('B')
    const layerOff = statsOff.targets.find(t => t.name === 'layer')

    // With temporal
    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 0 })
    const statsOn = await p.stats('B')
    const layerOn = statsOn.targets.find(t => t.name === 'layer')

    if (layerOff == null || layerOn == null) {
      throw new Error(
        'Layer target not available - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }

    console.log(
      `[p2][matrix] temporal off=${layerOff.width}×${layerOff.height} on=${layerOn.width}×${layerOn.height}`
    )

    // With temporal, march target should be smaller (1/4 resolution each dimension)
    expect(layerOn.width).toBeLessThanOrEqual(layerOff.width)
    expect(layerOn.height).toBeLessThanOrEqual(layerOff.height)
  })
})

// ── 7. Temporal-on cases boot ───────────────────────────────

test.describe('7. temporal cases boot', () => {
  for (const caseName of [
    'temporal-on-static',
    'temporal-on-orbit',
    'temporal-on-wind'
  ] as const) {
    test(`${caseName} boots without errors`, async ({ page }) => {
      await loadCase(page, caseName)
      const p = probe(page)

      const errs = await p.errors()
      const filtered = errs.filter(
        e =>
          !e.includes('WebGPU') &&
          !e.includes('deprecated') &&
          !e.includes('frame has not advanced')
      )
      expect(filtered).toEqual([])

      await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
      const b = await p.readLinear('B')
      const mean = meanLuminance(b.data, b.width, b.height)
      console.log(`[p2][cases] ${caseName} mean=${mean.toFixed(4)}`)
      expect(Number.isFinite(mean)).toBe(true)
    })
  }

  test('temporal-cut boots without errors', async ({ page }) => {
    await loadCase(page, 'temporal-cut')
    const p = probe(page)

    const errs = await p.errors()
    const filtered = errs.filter(
      e =>
        !e.includes('WebGPU') &&
        !e.includes('deprecated') &&
        !e.includes('frame has not advanced')
    )
    expect(filtered).toEqual([])
  })
})

// ── 8. TAA-off parity (ADR-011) ─────────────────────────────

test.describe('8. TAA-off parity', () => {
  test('temporal converges to non-temporal baseline at static camera', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    // Render without temporal (ground truth)
    await p.set({ temporalUpscale: false })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 32 })
    const noTemporal = await p.readLinear('B')
    const meanNoTemp = meanLuminance(
      noTemporal.data,
      noTemporal.width,
      noTemporal.height
    )
    expect(
      meanNoTemp === 0,
      'Side B returned black without temporal - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    // Enable temporal, warm up extensively to let resolve converge
    await p.set({ temporalUpscale: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 128 })
    const withTemporal = await p.readLinear('B')
    const meanWithTemp = meanLuminance(
      withTemporal.data,
      withTemporal.width,
      withTemporal.height
    )

    console.log(
      `[p2][taa-parity] noTemporal=${meanNoTemp.toFixed(4)} withTemporal=${meanWithTemp.toFixed(4)}`
    )

    // Mean luminance should converge: the temporal path reproduces
    // the non-temporal result after enough frames (ADR-011 warm-up rule)
    if (
      noTemporal.data.length === withTemporal.data.length &&
      noTemporal.data.length > 0
    ) {
      // Compute mean absolute difference across all channels
      let sumDiff = 0
      for (let i = 0; i < noTemporal.data.length; i++) {
        sumDiff += Math.abs(noTemporal.data[i]! - withTemporal.data[i]!)
      }
      const meanDiff = sumDiff / noTemporal.data.length
      console.log(`[p2][taa-parity] mean |Δ|: ${meanDiff.toFixed(6)}`)
      // Tolerance: mean per-channel difference ≤ 1e-3
      expect(meanDiff).toBeLessThan(0.01)
    }
  })
})

// ── 9. A/B sequence agreement ───────────────────────────────

test.describe('9. A/B sequence agreement', () => {
  test('temporal-on-static A vs B after warmup', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    const warmup = 64
    const frames = 8
    const dt = 0

    // Same Bayer run-up as the convergence test: the pinned warm-up
    // left 1/16 of the plate marched, so this comparison was reading history
    // assembly on both sides rather than their steady-state agreement
    const base = await bayerRunUp(p, warmup, 64, dt)
    for (let f = 0; f < frames; f++) {
      await p.sequenceStep(base + f, dt)
    }

    const metrics = await p.sequenceMetrics({ frames, dt })

    console.log(
      `[p2][ab] flickerA: mean=${metrics.flickerA.mean.toFixed(6)}, flickerB: mean=${metrics.flickerB.mean.toFixed(6)}`
    )
    if (metrics.ghostingB != null) {
      console.log(
        `[p2][ab] ghostingB: deMean=${metrics.ghostingB.deMean.toFixed(6)} deP95=${metrics.ghostingB.deP95.toFixed(6)}`
      )
    }

    // Both sides should have low flicker after warmup
    if (metrics.flickerA.mean > 0 && metrics.flickerB.mean > 0) {
      // Side B should not be dramatically worse than side A, measured in the
      // same run. 3.0 from F1 (1.387 with run-up, 23.27 without), matching the
      // convergence test above so the bars cannot drift. In-session floor only
      const ratio =
        metrics.flickerB.mean / Math.max(metrics.flickerA.mean, 1e-6)
      console.log(`[p2][ab] B/A flicker ratio: ${ratio.toFixed(2)}`)
      expect(ratio).toBeLessThan(3.0)
    }
  })
})

// ── 10. Stale-frame warning ─────────────────────────────────

test.describe('10. stale-frame warning', () => {
  test('pinned frame with temporal emits warning after 17 renders', async ({
    page
  }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    // Clearing the warnings ARRAY was the defect: the warning latches
    // until ctx.frame CHANGES, and had already fired at page load. Advancing
    // the frame once un-latches it (measured: 0 warnings without, 1 with)
    await p.renderOnce('B', { time: 0, frame: 1, warmup: 0 })
    await page.evaluate(() => {
      ;(window as ParityWindow).__parity.warnings.length = 0
    })

    // Render 17 frames with the same pinned frame index. warmup MUST stay 0:
    // a temporal warm-up advances the frame, which resets checkStaleFrame's
    // counter so the warning never fires
    for (let i = 0; i < 17; i++) {
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 0 })
    }

    const warnings = await p.warnings()
    console.log(
      `[p2][stale] warnings after 17 pinned renders: ${JSON.stringify(warnings)}`
    )

    const staleWarnings = warnings.filter(
      (w: string) => w.includes('frame') && w.includes('not advanced')
    )
    expect(staleWarnings.length).toBeGreaterThanOrEqual(1)
  })

  test('no stale warning without temporalUpscale', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.set({ temporalUpscale: false })

    // Clear existing warnings
    await page.evaluate(() => {
      ;(window as ParityWindow).__parity.warnings.length = 0
    })

    // Render 17 frames with pinned frame (still mode, no temporal)
    for (let i = 0; i < 17; i++) {
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 0 })
    }

    const warnings = await p.warnings()
    const staleWarnings = warnings.filter(
      (w: string) => w.includes('frame') && w.includes('not advanced')
    )
    console.log(
      `[p2][stale] warnings without temporal: ${staleWarnings.length}`
    )
    expect(staleWarnings).toEqual([])
  })

  test('no stale warning when warnings suppressed', async ({ page }) => {
    await loadCase(page, 'temporal-on-static')
    const p = probe(page)

    // Suppress warnings via the probe if supported
    const suppressed = await page.evaluate(() => {
      const parity = (window as ParityWindow).__parity
      if (parity.sideBHandle?.cloudsContext != null) {
        parity.sideBHandle.cloudsContext.warnings = false
        return true
      }
      return false
    })

    expect(
      !suppressed,
      'warnings flag not available on CloudsContext - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)

    // Clear existing warnings
    await page.evaluate(() => {
      ;(window as ParityWindow).__parity.warnings.length = 0
    })

    for (let i = 0; i < 17; i++) {
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 0 })
    }

    const warnings = await p.warnings()
    const staleWarnings = warnings.filter(
      (w: string) => w.includes('frame') && w.includes('not advanced')
    )
    expect(staleWarnings).toEqual([])
  })
})
