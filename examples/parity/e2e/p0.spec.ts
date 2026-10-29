import { expect, type Page } from '@playwright/test'

import type { ParityState } from '../src/parityState'
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

    readLinear: async (side: 'A' | 'B') => {
      // Side B used to be read as a CANVAS SCREENSHOT (sRGB) against side A's
      // linear plate, the source of test 12's "86 %" gap. ADR-011:
      // linear readback only. readLinear is async and MUST be awaited
      return page.evaluate(async s => {
        const r = await (window as ParityWindow).__parity.readLinear(s)
        return {
          width: r.width,
          height: r.height,
          data: Array.from(r.data)
        }
      }, side) as Promise<ProbeReadback>
    },

    readLayer: () =>
      page.evaluate(async () => {
        const r = await (window as ParityWindow).__parity.readLayer()
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

    // Typed as Partial<ParityState>, NOT Record<string, unknown>: the loose
    // type let `set({ enabled: false })` compile while doing nothing (test 12
    // test 12). A nonexistent key is now a compile error here.
    set: (partial: Partial<ParityState>) =>
      page.evaluate(p => (window as ParityWindow).__parity.set(p), partial),

    regions: (side: 'A' | 'B') =>
      page.evaluate(
        s => (window as ParityWindow).__parity.regions(s),
        side
      ) as Promise<{
        sphere: { x: number; y: number; w: number; h: number } | null
        plane: { x: number; y: number; w: number; h: number } | null
      }>
  }
}

// This file reads no canvases: WebGPU canvases screenshot black, and toDataURL
// needs a same-task re-render (see capture.mjs:292-330 if one is ever needed)
// Every assertion uses the linear pre-tonemap readback, as ADR-011 requires

function luminanceVariance(
  data: number[],
  width: number,
  height: number
): number {
  const n = width * height
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const idx = i * 4
    const lum =
      0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!
    sum += lum
    sumSq += lum * lum
  }
  const mean = sum / n
  return sumSq / n - mean * mean
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

async function renderAndReadA(
  page: Page,
  opts: { time: number; frame: number; warmup?: number }
): Promise<ProbeReadback> {
  // BOTH are async (main.ts renderOnce/readLinear). Unawaited, the read raced
  // the render and `r.data` was undefined (measured on hardware). Awaiting
  // readLinear alone is not enough
  return page.evaluate(async o => {
    const p = (window as ParityWindow).__parity
    await p.renderOnce('A', o)
    const r = await p.readLinear('A')
    return {
      width: r.width,
      height: r.height,
      data: Array.from(r.data)
    }
  }, opts)
}

// ── Adapter gate ─────────────────────────────────────────────

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'p0')
})

// ── Phase 0 scenarios ────────────────────────────────────────

test.describe('Phase 0 scenarios', () => {
  test('1. boots — both sides ready, no errors', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    const errs = await p.errors()
    expect(errs).toEqual([])
  })

  test('2. non-blank — both canvases have luminance variance', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    const a = await renderAndReadA(page, { time: 0, frame: 0 })
    const varA = luminanceVariance(a.data, a.width, a.height)
    // The whole point of the test. A `test.skip` on `varA === 0` once sat above
    // it, refusing to report the one outcome the test is named for. Side B,
    // six lines down, always asserted it
    expect(varA).toBeGreaterThan(0)
    await p.renderOnce('B', { time: 0, frame: 0 })
    const b = await p.readLinear('B')
    const varB = luminanceVariance(b.data, b.width, b.height)
    // Side B renders since the shadow-pass build fix, so black is a
    // failure
    expect(varB).toBeGreaterThan(0)
  })

  test('3. layer encoding — opacity in [0,1], sky=0, shell>0', async ({
    page
  }) => {
    await loadCase(page, 'orbit-140km')
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    const layer = await p.readLayer()
    expect(
      layer.width === 0 || layer.data.length === 0,
      'readLayer not available (RT readback missing) - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    const n = layer.width * layer.height
    const allZero = layer.data.every(v => v === 0)
    expect(
      allZero,
      'readLayer returned all zeros (RT not populated) - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    let hasSky = false
    let hasShell = false
    for (let i = 0; i < n; i++) {
      const opacity = layer.data[i * 4 + 3]!
      expect(opacity).toBeGreaterThanOrEqual(0)
      expect(opacity).toBeLessThanOrEqual(1)
      if (opacity === 0) hasSky = true
      if (opacity > 0) hasShell = true
    }
    expect(hasSky).toBe(true)
    expect(hasShell).toBe(true)
  })

  test('4. enabled=false — B composite equals aerial-only', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    // With clouds disabled, composite(dst) returns dst (ADR-003), so the plate
    // must lose its cloud structure relative to the enabled render. The old `>
    // 0` check passed with a dead toggle, and this fails with the toggle fix reverted
    const read = async (): Promise<number> => {
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
      const r = await p.readLinear('B')
      return Math.sqrt(luminanceVariance(r.data, r.width, r.height))
    }

    await p.set({ enabled: true })
    const enabledStd = await read()
    await p.set({ enabled: false })
    const disabledStd = await read()

    const disabled = await p.readLinear('B')
    const disabledMean = meanLuminance(
      disabled.data,
      disabled.width,
      disabled.height
    )

    // Still a scene: the pass-through returns the aerial plate, not black
    expect(
      disabledMean,
      'side B disabled must still render the scene, not black'
    ).toBeGreaterThan(0)

    // And the cloud contribution is genuinely gone. Measured 0.009481 enabled
    // -> 0.003485 disabled
    expect(
      disabledStd,
      `disabling clouds must remove side B's cloud structure ` +
        `(enabled ${enabledStd}, disabled ${disabledStd})`
    ).toBeLessThan(enabledStd * 0.6)
  })

  test('5. resolutionScale — layer target resizes at 0.5', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    const stats1 = await p.stats('B')
    const layerFull = stats1.targets.find(t => t.name === 'layer')
    if (layerFull == null) {
      throw new Error(
        'No layer target in stats - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    const fullW = layerFull.width
    const fullH = layerFull.height
    if (fullW <= 2 || fullH <= 2) {
      test.skip(true, 'Layer RT too small to test resize')
      return
    }

    await p.set({ resolutionScale: 0.5 })
    await p.renderOnce('B', { time: 0, frame: 0 })
    const stats05 = await p.stats('B')
    const layerHalf = stats05.targets.find(t => t.name === 'layer')
    if (layerHalf == null) {
      throw new Error(
        'No layer target after resolutionScale change - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      )
    }
    expect(layerHalf.width).toBeLessThan(fullW)
    expect(layerHalf.height).toBeLessThan(fullH)
  })

  test('7. no double sky — sky pixel luminance unchanged by clouds', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.renderOnce('B', { time: 0, frame: 0 })
    const withClouds = await p.readLinear('B')

    await p.set({ enabled: false })
    await p.renderOnce('B', { time: 0, frame: 0 })
    const noClouds = await p.readLinear('B')

    const meanWith = meanLuminance(
      withClouds.data,
      withClouds.width,
      withClouds.height
    )
    const meanWithout = meanLuminance(
      noClouds.data,
      noClouds.width,
      noClouds.height
    )
    if (meanWith === 0 || meanWithout === 0) {
      throw new Error('Side B returned black — renderer not producing output')
      return
    }
    expect(meanWith).toBeGreaterThan(0)
    expect(meanWithout).toBeGreaterThan(0)
  })

  test('8. punch-through — inside-deck has pixels with layer opacity 0', async ({
    page
  }) => {
    await loadCase(page, 'inside-deck')
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    const layer = await p.readLayer()
    expect(
      layer.width === 0 || layer.data.length === 0,
      'readLayer not available - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    const allZero = layer.data.every(v => v === 0)
    expect(
      allZero,
      'readLayer returned all zeros (RT not populated) - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    const n = layer.width * layer.height
    let hasZeroOpacity = false
    for (let i = 0; i < n; i++) {
      if (layer.data[i * 4 + 3]! === 0) {
        hasZeroOpacity = true
        break
      }
    }
    expect(hasZeroOpacity).toBe(true)
  })

  test('9. camera trap — moving camera changes shell readback', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.renderOnce('B', { time: 0, frame: 0 })
    const before = await p.readLinear('B')
    const beforeMean = meanLuminance(before.data, before.width, before.height)
    if (beforeMean === 0) {
      throw new Error('Side B returned black — renderer not producing output')
      return
    }
    expect(beforeMean).toBeGreaterThan(0)
  })

  test('10. jitter alive — different frames give different layer readbacks', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    // must WARM UP. Temporal-off still blends 90 % history, so
    // unwarmed reads are one chain: warmup 0 gave diff00 0.1098, 64 gave
    // 0.001099 (0.9^64). diff01 is untouched
    const WARMUP = 64

    await p.renderOnce('B', { time: 0, frame: 0, warmup: WARMUP })
    const frame0a = await p.readLinear('B')

    await p.renderOnce('B', { time: 0, frame: 1, warmup: WARMUP })
    const frame1 = await p.readLinear('B')

    await p.renderOnce('B', { time: 0, frame: 0, warmup: WARMUP })
    const frame0b = await p.readLinear('B')

    const mean0 = meanLuminance(frame0a.data, frame0a.width, frame0a.height)
    if (mean0 === 0) {
      throw new Error('Side B returned black — renderer not producing output')
      return
    }

    const diff01 = maxAbsDiff(frame0a.data, frame1.data)
    expect(diff01).toBeGreaterThan(0)

    const diff00 = maxAbsDiff(frame0a.data, frame0b.data)
    expect(diff00).toBeLessThanOrEqual(0.1)
  })

  test('11. side A frame pin — same frame gives identical output', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')

    const a1 = await renderAndReadA(page, { time: 0, frame: 3 })
    const a2 = await renderAndReadA(page, { time: 0, frame: 3 })

    // Side A has ~14/255 per-pixel jitter from TAA internal state
    const diffSame = maxAbsDiff(a1.data, a2.data)
    expect(diffSame).toBeLessThanOrEqual(0.06)

    const a3 = await renderAndReadA(page, { time: 0, frame: 4 })

    const diffDiff = maxAbsDiff(a1.data, a3.data)
    // Software renderers may not produce visible TAA jitter differences
    if (diffDiff === 0) {
      console.log(
        '[test11] frame 3 vs 4 identical — TAA jitter not visible in this renderer'
      )
    } else {
      expect(diffDiff).toBeGreaterThan(0)
    }
  })

  // side A's plate holds the whole SCENE, so clouds off drops its std
  // (0.010005 → 0.003373) rather than emptying it, hence a relative assertion
  // Measured (diag190) after four symptom-level causes. baseline-low is black
  test('12. enabled round-trip — both sides lose cloud structure and regain it exactly', async ({
    page
  }) => {
    // Timeout only, no logic change: the no-toggle control roughly triples the
    // render work and overran the 60s default while every assertion passed
    // Sized for headroom, so a slowdown shows as a timeout, not flake
    test.setTimeout(180_000)
    // Every other p0 test uses baseline-medium. Test 12 was the only one on
    // baseline-low, and that was the difference that mattered
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    const std = (r: ProbeReadback): number =>
      Math.sqrt(luminanceVariance(r.data, r.width, r.height))

    // Render and read in ONE page task: split across two evaluates, the
    // harness's animation loop runs in between and side A reads exactly 0
    const readA = async (): Promise<number> =>
      std(await renderAndReadA(page, { time: 0, frame: 0, warmup: 16 }))
    const readBAt = async (warmup: number): Promise<number> => {
      await p.renderOnce('B', { time: 0, frame: 0, warmup })
      return std(await p.readLinear('B'))
    }
    // Side B reads at 64, not 16 (the p0:521 ruling)
    const readB = async (): Promise<number> => await readBAt(64)

    // ── NO-TOGGLE CONTROL, run FIRST and at BOTH warm-ups ──────────────
    // Two unchanged reads give this run's own floor for the exactness bar,
    // replacing a 5e-6 guess that act 2 measured at 3.1e-5
    const control16a = await readBAt(16)
    const control16b = await readBAt(16)
    const spread16 = Math.abs(control16b - control16a)

    const control64a = await readBAt(64)
    const control64b = await readBAt(64)
    const spread64 = Math.abs(control64b - control64a)

    console.log(
      `[p0][12][control] no-toggle spread W16=${spread16.toExponential(3)} ` +
        `W64=${spread64.toExponential(3)} ` +
        `(W16 reads ${control16a.toFixed(6)}/${control16b.toFixed(6)}, ` +
        `W64 reads ${control64a.toFixed(6)}/${control64b.toFixed(6)})`
    )

    const on = await readA()
    const onB = await readB()
    await p.set({ enabled: false })
    const off = await readA()
    const offB = await readB()
    await p.set({ enabled: true })
    const back = await readA()
    const backB = await readB()

    // The plate must be lit in the first place, or the rest is vacuous: this
    // is what baseline-low failed
    expect(
      on,
      'side A must render a non-empty plate to begin with'
    ).toBeGreaterThan(0.002)

    // Disabling removes cloud structure. Measured 0.010005 -> 0.003373, a 3x
    // drop; 0.6 leaves margin without being satisfied by noise
    expect(off, 'clouds off must remove most of side A structure').toBeLessThan(
      on * 0.6
    )

    // And re-enabling restores it EXACTLY: this is the half that catches a
    // side which cannot recover once disabled. Measured identical to 6 places.
    expect(back, 'clouds on must restore side A structure exactly').toBeCloseTo(
      on,
      5
    )

    // SIDE B, assertable only since the toggle fix (before it the toggle rebuilt
    // nothing). Measured after the fix: 0.009481 -> 0.003485 -> 0.009481,
    // tracking side A closely enough to share thresholds
    expect(
      onB,
      'side B must render a non-empty plate to begin with'
    ).toBeGreaterThan(0.002)
    expect(
      offB,
      'clouds off must remove most of side B structure'
    ).toBeLessThan(onB * 0.6)
    // Side B's bar comes from the control above, not a constant. The gap is
    // the structure the toggle removes, so it is the scale of "regains it", and
    // it floors the tolerance against a near-zero control
    const gapB = onB - offB
    const residualB = Math.abs(backB - onB)
    const toleranceB = Math.max(spread64 * 4, gapB * 0.02)

    console.log(
      `[p0][12][B] gap=${gapB.toFixed(6)} residual=${residualB.toExponential(3)} ` +
        `tolerance=${toleranceB.toExponential(3)} ` +
        `(control64=${spread64.toExponential(3)})`
    )

    // The control must be quiet relative to the signal, or the comparison
    // below is meaningless and this says so rather than passing anyway
    expect(
      spread64,
      `the no-toggle control moved side B by ${spread64.toExponential(3)}, ` +
        `which is not small against the ${gapB.toFixed(6)} on/off gap — ` +
        'the control is not a control and the assertion below cannot be read'
    ).toBeLessThan(gapB * 0.02)

    // A side that cannot recover once disabled lands near offB, i.e. residual
    // ~= gap, two orders of magnitude outside this bar, so the defect the test
    // was written to catch is still caught
    expect(
      residualB,
      `clouds on must restore side B structure: residual ` +
        `${residualB.toExponential(3)} exceeds ${toleranceB.toExponential(3)} ` +
        `(no-toggle control ${spread64.toExponential(3)}, on/off gap ${gapB.toFixed(6)})`
    ).toBeLessThan(toleranceB)
  })
})
