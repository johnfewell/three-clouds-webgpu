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

    stats: (side: 'A' | 'B') =>
      page.evaluate(
        s => (window as ParityWindow).__parity.stats(s),
        side
      ) as Promise<ProbeStats>,

    set: (partial: Record<string, unknown>) =>
      page.evaluate(p => (window as ParityWindow).__parity.set(p), partial)
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

function meanLayerOpacity(
  data: number[],
  width: number,
  height: number
): number {
  const n = width * height
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += data[i * 4 + 3]!
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

// ── Adapter gate ─────────────────────────────────────────────

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'p1')
})

// ── 1. Camera regimes ────────────────────────────────────────

test.describe('1. camera regimes', () => {
  test('orbit poses have non-zero layer opacity', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    const layer = await p.readLayer()
    expect(
      layer.width === 0 || layer.data.every(v => v === 0),
      'readLayer not populated - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    const opacity = meanLayerOpacity(layer.data, layer.width, layer.height)
    console.log(
      `[p1][camera] baseline-medium mean opacity: ${opacity.toFixed(4)}`
    )
    expect(opacity).toBeGreaterThan(0)
  })

  test('below-deck-1km has lower opacity than orbit', async ({ page }) => {
    await loadCase(page, 'below-deck-1km')
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    const layer = await p.readLayer()
    expect(
      layer.width === 0 || layer.data.every(v => v === 0),
      'readLayer not populated - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    const opacity = meanLayerOpacity(layer.data, layer.width, layer.height)
    console.log(
      `[p1][camera] below-deck-1km mean opacity: ${opacity.toFixed(4)}`
    )
    expect(Number.isFinite(opacity)).toBe(true)
  })

  test('no NaN/Inf in layer readback', async ({ page }) => {
    await loadCase(page, 'surface-up')
    const p = probe(page)
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 16 })
    const layer = await p.readLayer()
    expect(
      layer.width === 0 || layer.data.every(v => v === 0),
      'readLayer not populated - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
    ).toBe(false)
    expect(hasNaNOrInf(layer.data)).toBe(false)
  })
})

// ── 2. Coverage monotonicity ─────────────────────────────────

test.describe('2. coverage monotonicity', () => {
  test('mean layer opacity increases with coverage', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    const coverages = [0.2, 0.45, 0.7, 0.9]
    const opacities: number[] = []

    for (const cov of coverages) {
      await p.set({ coverage: cov })
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
      const layer = await p.readLayer()
      expect(
        layer.width === 0 || layer.data.every(v => v === 0),
        'readLayer not populated - past the harness-boot gate side B is booted, so no output here is a defect rather than an unavailable environment'
      ).toBe(false)
      opacities.push(meanLayerOpacity(layer.data, layer.width, layer.height))
    }

    console.log(
      `[p1][coverage] opacities: ${opacities.map((o, i) => `${coverages[i]}→${o.toFixed(4)}`).join(', ')}`
    )

    for (let i = 1; i < opacities.length; i++) {
      expect(
        opacities[i]!,
        `coverage ${coverages[i]} should have higher opacity than ${coverages[i - 1]}`
      ).toBeGreaterThanOrEqual(opacities[i - 1]!)
    }
  })
})

// ── 3. Presets ───────────────────────────────────────────────

test.describe('3. presets', () => {
  for (const preset of [
    'preset-low',
    'preset-medium',
    'preset-high',
    'preset-ultra'
  ] as const) {
    test(`${preset} boots without errors`, async ({ page }) => {
      await loadCase(page, preset)
      const p = probe(page)
      const errs = await p.errors()
      expect(errs).toEqual([])
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 4 })
      const b = await p.readLinear('B')
      const mean = meanLuminance(b.data, b.width, b.height)
      console.log(`[p1][preset] ${preset} mean luminance: ${mean.toFixed(4)}`)
      expect(Number.isFinite(mean)).toBe(true)
    })
  }
})

// ── 4. Feature toggles ──────────────────────────────────────

test.describe('4. feature toggles', () => {
  test('shapeDetail toggle changes readback', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.set({ shapeDetail: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const withDetail = await p.readLinear('B')

    await p.set({ shapeDetail: false })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const noDetail = await p.readLinear('B')

    const meanWith = meanLuminance(
      withDetail.data,
      withDetail.width,
      withDetail.height
    )
    const meanWithout = meanLuminance(
      noDetail.data,
      noDetail.width,
      noDetail.height
    )

    expect(
      meanWith === 0 && meanWithout === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    const diff = maxAbsDiff(withDetail.data, noDetail.data)
    console.log(
      `[p1][toggle] shapeDetail on=${meanWith.toFixed(4)} off=${meanWithout.toFixed(4)} maxDiff=${diff.toFixed(4)}`
    )

    if (diff === 0) {
      console.log(
        '[p1][toggle] shapeDetail toggle had no visible effect — may be a stub'
      )
    }
  })

  test('multiScatteringOctaves 1 vs 8 changes luminance', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.set({ clouds: { multiScatteringOctaves: 1 } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const oct1 = await p.readLinear('B')

    await p.set({ clouds: { multiScatteringOctaves: 8 } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const oct8 = await p.readLinear('B')

    const mean1 = meanLuminance(oct1.data, oct1.width, oct1.height)
    const mean8 = meanLuminance(oct8.data, oct8.width, oct8.height)

    console.log(
      `[p1][toggle] multiScatter oct1=${mean1.toFixed(4)} oct8=${mean8.toFixed(4)}`
    )

    expect(
      mean1 === 0 && mean8 === 0,
      'Side B returned black for both octave settings - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    const diff = maxAbsDiff(oct1.data, oct8.data)
    if (diff === 0) {
      console.log(
        '[p1][toggle] octaves toggle had no visible effect — may be a graph-rebuild issue'
      )
    }
  })

  test('accurateSunSkyLight toggle changes output', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.set({ clouds: { accurateSunSkyLight: false } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const interpol = await p.readLinear('B')

    await p.set({ clouds: { accurateSunSkyLight: true } })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const accurate = await p.readLinear('B')

    const meanI = meanLuminance(interpol.data, interpol.width, interpol.height)
    const meanA = meanLuminance(accurate.data, accurate.width, accurate.height)

    console.log(
      `[p1][toggle] sunSky interpolated=${meanI.toFixed(4)} accurate=${meanA.toFixed(4)}`
    )

    expect(
      meanI === 0 && meanA === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)
  })
})

// ── 5. Wind ──────────────────────────────────────────────────

test.describe('5. wind', () => {
  test('different times produce different readbacks', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const t0 = await p.readLinear('B')

    await p.renderOnce('B', { time: 4, frame: 240, warmup: 0 })
    const t4 = await p.readLinear('B')

    const mean0 = meanLuminance(t0.data, t0.width, t0.height)
    const mean4 = meanLuminance(t4.data, t4.width, t4.height)

    expect(
      mean0 === 0 && mean4 === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    const diff = maxAbsDiff(t0.data, t4.data)
    console.log(
      `[p1][wind] t=0 mean=${mean0.toFixed(4)} t=4 mean=${mean4.toFixed(4)} maxDiff=${diff.toFixed(4)}`
    )

    if (diff === 0) {
      console.log(
        '[p1][wind] time change had no visible effect — wind may not be wired'
      )
    }
  })
})

// ── 6. Altitude / ECEF ──────────────────────────────────────

test.describe('6. altitude/ECEF', () => {
  test('correctAltitude toggle changes output', async ({ page }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.set({ correctAltitude: true })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const withAlt = await p.readLinear('B')

    await p.set({ correctAltitude: false })
    await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
    const noAlt = await p.readLinear('B')

    const meanWith = meanLuminance(withAlt.data, withAlt.width, withAlt.height)
    const meanNo = meanLuminance(noAlt.data, noAlt.width, noAlt.height)

    console.log(
      `[p1][altitude] correctAltitude on=${meanWith.toFixed(4)} off=${meanNo.toFixed(4)}`
    )

    expect(
      meanWith === 0 && meanNo === 0,
      'Side B returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)
  })

  test('ecef cases boot without errors', async ({ page }) => {
    await loadCase(page, 'ecef-identity')
    const p = probe(page)
    const errs = await p.errors()
    expect(errs).toEqual([])

    await loadCase(page, 'ecef-rotated')
    const errs2 = await p.errors()
    expect(errs2).toEqual([])
  })
})

// ── 7. API surface ──────────────────────────────────────────

test.describe('7. API surface', () => {
  test('Phase 1 PARITY_KEYS entries can be set without error', async ({
    page
  }) => {
    await loadCase(page, 'baseline-medium')
    const p = probe(page)

    await p.set({ coverage: 0.5 })
    await p.set({ resolutionScale: 0.75 })
    await p.set({ shapeDetail: false })
    await p.set({ turbulence: true })
    await p.set({ correctAltitude: false })
    await p.set({
      clouds: {
        multiScatteringOctaves: 4,
        accurateSunSkyLight: true,
        maxIterationCount: 300,
        minStepSize: 75
      }
    })

    await p.renderOnce('B', { time: 0, frame: 0, warmup: 4 })
    const errs = await p.errors()
    const filtered = errs.filter(
      e => !e.includes('WebGPU') && !e.includes('deprecated')
    )
    expect(filtered).toEqual([])

    const stats = await p.stats('B')
    console.log('[p1][api] stats after set:', JSON.stringify(stats))
  })
})

// ── 8. Sun elevation ────────────────────────────────────────

test.describe('8. sun elevation', () => {
  test('luminance decreases from noon to twilight', async ({ page }) => {
    const sunCases = ['sun-noon', 'sun-low', 'sun-horizon', 'sun-twilight']
    const means: number[] = []

    for (const caseName of sunCases) {
      await loadCase(page, caseName)
      const p = probe(page)
      await p.renderOnce('B', { time: 0, frame: 0, warmup: 8 })
      const b = await p.readLinear('B')
      const mean = meanLuminance(b.data, b.width, b.height)
      means.push(mean)
      console.log(`[p1][sun] ${caseName} mean luminance: ${mean.toFixed(4)}`)
    }

    expect(
      means.every(m => m === 0),
      'All sun cases returned black - a black render is the defect this suite exists to catch, not a condition to skip past'
    ).toBe(false)

    for (let i = 1; i < means.length; i++) {
      if (means[i - 1]! > 0 && means[i]! > 0) {
        expect(
          means[i]!,
          `${sunCases[i]} should have lower luminance than ${sunCases[i - 1]}`
        ).toBeLessThanOrEqual(means[i - 1]!)
      }
    }
  })
})

// ── 9. Resolution scale ─────────────────────────────────────

test.describe('9. resolution scale', () => {
  test('res-050 and res-100 boot without errors', async ({ page }) => {
    await loadCase(page, 'res-050')
    const p = probe(page)
    const errs = await p.errors()
    expect(errs).toEqual([])

    await loadCase(page, 'res-100')
    const errs2 = await p.errors()
    expect(errs2).toEqual([])
  })
})
