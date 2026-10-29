import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deltaE2000, linearRgbToLab, luminance } from './color'
import { computeDeltaE } from './deltaE'
import { evaluate, type Metrics } from './evaluate'
import { computeHistogramDistance } from './histogram'
import { computeSSIM } from './ssim'

const FIXTURES = resolve(__dirname, '../../test/fixtures')

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8')) as T
}

function logTable(label: string, rows: Record<string, number | string>[]) {
  console.log(`\n[metrics] ${label}`)
  if (rows.length === 0) return
  const keys = Object.keys(rows[0]!)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k]).length))
  )
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join(' | ')
  console.log(header)
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  for (const row of rows) {
    console.log(
      keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' | ')
    )
  }
}

function makeSolidRgba(
  r: number,
  g: number,
  b: number,
  w: number,
  h: number
): Float32Array {
  const buf = new Float32Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = 1
  }
  return buf
}

function makeGradient(w: number, h: number): Float32Array {
  const buf = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = x / (w - 1)
      buf[i] = v
      buf[i + 1] = v
      buf[i + 2] = v
      buf[i + 3] = 1
    }
  }
  return buf
}

function makeInverted(buf: Float32Array): Float32Array {
  const inv = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i += 4) {
    inv[i] = 1 - buf[i]!
    inv[i + 1] = 1 - buf[i + 1]!
    inv[i + 2] = 1 - buf[i + 2]!
    inv[i + 3] = 1
  }
  return inv
}

describe('color', () => {
  it('luminance of white is 1', () => {
    expect(luminance(1, 1, 1)).toBeCloseTo(1, 4)
  })

  it('luminance of black is 0', () => {
    expect(luminance(0, 0, 0)).toBe(0)
  })

  it('linearRgbToLab of white is L=100', () => {
    const [L] = linearRgbToLab(1, 1, 1)
    expect(L).toBeCloseTo(100, 0)
  })

  it('linearRgbToLab of black is L=0', () => {
    const [L] = linearRgbToLab(0, 0, 0)
    expect(L).toBeCloseTo(0, 0)
  })

  it('deltaE2000 of identical colors is 0', () => {
    const [L, a, b] = linearRgbToLab(0.5, 0.3, 0.2)
    expect(deltaE2000(L, a, b, L, a, b)).toBeCloseTo(0, 6)
  })

  it('deltaE2000 of very different colors is large', () => {
    const [L1, a1, b1] = linearRgbToLab(1, 0, 0)
    const [L2, a2, b2] = linearRgbToLab(0, 0, 1)
    const de = deltaE2000(L1, a1, b1, L2, a2, b2)
    expect(de).toBeGreaterThan(30)
  })
})

describe('SSIM', () => {
  const W = 32
  const H = 32

  it('identical images → SSIM ≈ 1', () => {
    const buf = makeSolidRgba(0.5, 0.5, 0.5, W, H)
    const ssim = computeSSIM(buf, buf, W, H)
    logTable('SSIM identical', [{ metric: 'ssim', value: ssim.toFixed(6) }])
    expect(ssim).toBeCloseTo(1, 3)
  })

  it('image vs slightly different → SSIM > 0.9', () => {
    const a = makeGradient(W, H)
    const b = new Float32Array(a)
    for (let i = 0; i < b.length; i += 4) {
      b[i] = Math.min(1, b[i]! + 0.02)
    }
    const ssim = computeSSIM(a, b, W, H)
    logTable('SSIM slight diff', [{ metric: 'ssim', value: ssim.toFixed(6) }])
    expect(ssim).toBeGreaterThan(0.9)
  })

  it('image vs inverted → SSIM low', () => {
    const a = makeGradient(W, H)
    const b = makeInverted(a)
    const ssim = computeSSIM(a, b, W, H)
    logTable('SSIM inverted', [{ metric: 'ssim', value: ssim.toFixed(6) }])
    expect(ssim).toBeLessThan(0.5)
  })
})

describe('ΔE2000', () => {
  const W = 16
  const H = 16

  it('identical images → ΔE = 0', () => {
    const buf = makeSolidRgba(0.5, 0.3, 0.2, W, H)
    const result = computeDeltaE(buf, buf, W, H)
    logTable('ΔE identical', [
      { metric: 'deMean', value: result.deMean.toFixed(4) },
      { metric: 'deP95', value: result.deP95.toFixed(4) },
      { metric: 'deMax', value: result.deMax.toFixed(4) }
    ])
    expect(result.deMean).toBeCloseTo(0, 4)
    expect(result.deP95).toBeCloseTo(0, 4)
  })

  it('inverted images → ΔE high', () => {
    const a = makeSolidRgba(0.8, 0.2, 0.1, W, H)
    const b = makeInverted(a)
    const result = computeDeltaE(a, b, W, H)
    logTable('ΔE inverted', [
      { metric: 'deMean', value: result.deMean.toFixed(2) },
      { metric: 'deP95', value: result.deP95.toFixed(2) },
      { metric: 'deMax', value: result.deMax.toFixed(2) }
    ])
    expect(result.deMean).toBeGreaterThan(10)
  })
})

describe('histogram distance', () => {
  const W = 32
  const H = 32

  it('identical images → distance 0', () => {
    const buf = makeGradient(W, H)
    const dist = computeHistogramDistance(buf, buf, W, H)
    logTable('histogram identical', [
      { metric: 'histDist', value: dist.toFixed(6) }
    ])
    expect(dist).toBeCloseTo(0, 6)
  })

  it('different images → distance > 0', () => {
    const a = makeSolidRgba(0.2, 0.2, 0.2, W, H)
    const b = makeSolidRgba(0.8, 0.8, 0.8, W, H)
    const dist = computeHistogramDistance(a, b, W, H)
    logTable('histogram different', [
      { metric: 'histDist', value: dist.toFixed(4) }
    ])
    expect(dist).toBeGreaterThan(0)
  })
})

describe('evaluate', () => {
  it('passing metrics return pass', () => {
    const result = evaluate(
      { ssim: 0.98, deMean: 1.0, deP95: 2.0, histDist: 0.01 },
      { ssim: 0.95, deP95: 5.0, histDist: 0.1 }
    )
    expect(result.result).toBe('pass')
    expect(result.reasons).toHaveLength(0)
  })

  it('failing metrics return fail with reasons', () => {
    const result = evaluate(
      { ssim: 0.8, deMean: 5.0, deP95: 10.0, histDist: 0.5 },
      { ssim: 0.95, deP95: 5.0, histDist: 0.1 }
    )
    expect(result.result).toBe('fail')
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.reasons.some(r => r.includes('ssim'))).toBe(true)
  })

  it('accepted pattern returns expected-difference', () => {
    const result = evaluate(
      { ssim: 0.8, deMean: 5.0, deP95: 10.0, histDist: 0.5 },
      { ssim: 0.95, deP95: 5.0, histDist: 0.1 },
      'test-case-1',
      [{ pattern: 'test-*', reason: 'known float precision' }]
    )
    expect(result.result).toBe('expected-difference')
    expect(result.reasons.some(r => r.includes('accepted'))).toBe(true)
  })

  it('no thresholds means pass', () => {
    const result = evaluate(
      { ssim: 0.5, deMean: 50, deP95: 100, histDist: 2 },
      {}
    )
    expect(result.result).toBe('pass')
  })
})

describe('evaluate with fixtures', () => {
  interface ThresholdsFile {
    phases: Record<string, { ssim?: number; deP95?: number; histDist?: number }>
    accepted: Array<{ pattern: string; reason: string }>
  }
  const thresholds = loadFixture<ThresholdsFile>('thresholds.json')
  const phase1 = thresholds.phases['1']!

  it('fixture metrics-pass → pass', () => {
    const m = loadFixture<Metrics>('metrics-pass.json')
    const result = evaluate(m, phase1)
    logTable('fixture pass', [
      {
        metric: 'ssim',
        value: m.ssim.toFixed(4),
        threshold: String(phase1.ssim)
      },
      {
        metric: 'deP95',
        value: m.deP95.toFixed(2),
        threshold: String(phase1.deP95)
      },
      {
        metric: 'histDist',
        value: m.histDist.toFixed(4),
        threshold: String(phase1.histDist)
      },
      { metric: 'result', value: result.result, threshold: '-' }
    ])
    expect(result.result).toBe('pass')
  })

  it('fixture metrics-fail → fail', () => {
    const m = loadFixture<Metrics>('metrics-fail.json')
    const result = evaluate(m, phase1)
    logTable('fixture fail', [
      {
        metric: 'ssim',
        value: m.ssim.toFixed(4),
        threshold: String(phase1.ssim)
      },
      {
        metric: 'deP95',
        value: m.deP95.toFixed(2),
        threshold: String(phase1.deP95)
      },
      {
        metric: 'histDist',
        value: m.histDist.toFixed(4),
        threshold: String(phase1.histDist)
      },
      { metric: 'result', value: result.result, threshold: '-' },
      { metric: 'reasons', value: result.reasons.join('; '), threshold: '-' }
    ])
    expect(result.result).toBe('fail')
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('fixture metrics-expected-diff with accepted pattern → expected-difference', () => {
    const m = loadFixture<Metrics>('metrics-expected-diff.json')
    const result = evaluate(
      m,
      phase1,
      'float-precision-baseline',
      thresholds.accepted
    )
    logTable('fixture expected-diff', [
      {
        metric: 'ssim',
        value: m.ssim.toFixed(4),
        threshold: String(phase1.ssim)
      },
      {
        metric: 'deP95',
        value: m.deP95.toFixed(2),
        threshold: String(phase1.deP95)
      },
      {
        metric: 'histDist',
        value: m.histDist.toFixed(4),
        threshold: String(phase1.histDist)
      },
      { metric: 'result', value: result.result, threshold: '-' },
      { metric: 'reasons', value: result.reasons.join('; '), threshold: '-' }
    ])
    expect(result.result).toBe('expected-difference')
  })

  it('fixture metrics-expected-diff without accepted match → fail', () => {
    const m = loadFixture<Metrics>('metrics-expected-diff.json')
    const result = evaluate(m, phase1, 'no-match-case', thresholds.accepted)
    expect(result.result).toBe('fail')
  })
})

describe('plate check', () => {
  it('computePlateStats: flat buffer has std 0, varied buffer has std > 0', async () => {
    const { computePlateStats } = await import('./evaluate')
    const flat = new Float32Array(16 * 4).fill(0.5)
    const varied = new Float32Array(16 * 4)
    for (let i = 0; i < 16; i++)
      varied[i * 4] = varied[i * 4 + 1] = varied[i * 4 + 2] = i / 15
    const f = computePlateStats(flat, 4)
    const v = computePlateStats(varied, 4)
    expect(f.std).toBe(0)
    expect(f.mean).toBeCloseTo(0.5, 5)
    expect(v.std).toBeGreaterThan(0.2)
  })

  it('evaluate: a flat side B fails even when metrics pass and the case is accepted', async () => {
    const { evaluate } = await import('./evaluate')
    const metrics = { ssim: 0.99, deMean: 0.1, deP95: 0.5, histDist: 0.001 }
    const thresholds = { ssim: 0.95, deP95: 5, histDist: 0.1 }
    const accepted = [{ pattern: 'flat-*', reason: 'would be accepted' }]
    const good = { A: { mean: 0.1, std: 0.05 }, B: { mean: 0.1, std: 0.05 } }
    const flat = { A: { mean: 0.1, std: 0.05 }, B: { mean: 0.1, std: 0.0 } }
    expect(
      evaluate(metrics, thresholds, 'flat-b', accepted, {
        minStd: 0.02,
        plate: good
      }).result
    ).toBe('pass')
    const r = evaluate(metrics, thresholds, 'flat-b', accepted, {
      minStd: 0.02,
      plate: flat
    })
    expect(r.result).toBe('fail')
    expect(r.reasons[0]).toContain('black/flat plate')
    expect(
      evaluate(metrics, thresholds, 'flat-b', accepted, {
        minStd: 0.02,
        plate: null
      }).result
    ).toBe('fail')
    const noClouds = {
      A: { mean: 0.1, std: 0.05 },
      B: { mean: 0.1, std: 0.05, cloudFraction: 0 }
    }
    const nc = evaluate(metrics, thresholds, 'flat-b', accepted, {
      minStd: 0.02,
      minCloudFraction: 0.0005,
      plate: noClouds
    })
    expect(nc.result).toBe('fail')
    expect(nc.reasons[0]).toContain('marched no clouds')
  })
})
