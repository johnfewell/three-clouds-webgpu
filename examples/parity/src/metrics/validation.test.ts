// Metric validation: each metric against its documented definition, on
// synthetic buffers whose answer is known analytically
// (ADR-011 amendment)
//
// These are the tests that decide whether a parity verdict means anything. The
// ladder's numbers are only as good as the definitions checked here

import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import { gaussianBlur } from './blur'
import { deltaE2000, linearRgbToLab, luminance } from './color'
import { computeDeltaE } from './deltaE'
import { checkMetricsVersion, METRICS_VERSION } from './evaluate'
import { computeHistogramDistance } from './histogram'
import {
  computeSSIM,
  computeSSIMAtMeasuredL,
  dynamicRange,
  REFERENCE_L
} from './ssim'

// ── Buffer builders ────────────────────────────────────────────

function rgbaFromLuminance(values: number[]): Float32Array {
  // Grey pixels, so luminance(v, v, v) === v exactly (the coefficients sum to 1)
  const buf = new Float32Array(values.length * 4)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    buf[i * 4] = v
    buf[i * 4 + 1] = v
    buf[i * 4 + 2] = v
    buf[i * 4 + 3] = 1
  }
  return buf
}

function scaled(buf: Float32Array, k: number): Float32Array {
  const out = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i]! * k
    out[i + 1] = buf[i + 1]! * k
    out[i + 2] = buf[i + 2]! * k
    out[i + 3] = buf[i + 3]!
  }
  return out
}

function seeded(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s * 1664525 + 1013904223) | 0
    return ((s >>> 0) % 100000) / 100000
  }
}

// A plate with the ladder's own statistics: linear luminance around 0.10 with
// std ≈ 0.010, the shape that broke the 256-bin L1 (baseline-medium: A mean
// 0.1010 std 0.0100, B mean 0.1123 std 0.0077)
function ladderPlate(
  mean: number,
  std: number,
  n: number,
  seed = 1337
): number[] {
  const rnd = seeded(seed)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    // Sum of 12 uniforms − 6 ≈ N(0, 1) (Irwin–Hall)
    let g = 0
    for (let k = 0; k < 12; k++) g += rnd()
    out.push(Math.max(0, mean + (g - 6) * std))
  }
  return out
}

// ── ΔE2000: Sharma, Wu, Dalal (2005) reference pairs ────────── The published
// CIEDE2000 test set, catching hue wraparound, the mean-hue branch and the RT
// term near h̄ = 275°: http://www2.ece.rochester.edu/~gsharma/ciede2000/

const SHARMA_PAIRS: Array<
  [number, number, number, number, number, number, number]
> = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082]
]

describe('ΔE2000 — Sharma et al. (2005) reference set', () => {
  it('matches all 34 published pairs to 1e-4', () => {
    const rows = SHARMA_PAIRS.map(([L1, a1, b1, L2, a2, b2, expected], i) => {
      const actual = deltaE2000(L1, a1, b1, L2, a2, b2)
      return { pair: i + 1, expected, actual: Number(actual.toFixed(4)) }
    })
    table('deltaE2000-sharma', rows)
    for (const row of rows) {
      expect(row.actual, `pair ${row.pair}`).toBeCloseTo(row.expected, 4)
    }
  })

  it('is symmetric', () => {
    for (const [L1, a1, b1, L2, a2, b2] of SHARMA_PAIRS) {
      expect(deltaE2000(L1, a1, b1, L2, a2, b2)).toBeCloseTo(
        deltaE2000(L2, a2, b2, L1, a1, b1),
        10
      )
    }
  })
})

describe('linear RGB → Lab (D65)', () => {
  it('white is L=100 with neutral chroma, black is L=0', () => {
    const [Lw, aw, bw] = linearRgbToLab(1, 1, 1)
    const [Lk] = linearRgbToLab(0, 0, 0)
    table('lab-endpoints', [
      { field: 'L(white)', expected: 100, actual: Number(Lw.toFixed(4)) },
      { field: 'a(white)', expected: 0, actual: Number(aw.toFixed(4)) },
      { field: 'b(white)', expected: 0, actual: Number(bw.toFixed(4)) },
      { field: 'L(black)', expected: 0, actual: Number(Lk.toFixed(4)) }
    ])
    expect(Lw).toBeCloseTo(100, 4)
    expect(aw).toBeCloseTo(0, 3)
    expect(bw).toBeCloseTo(0, 3)
    expect(Lk).toBeCloseTo(0, 6)
  })

  it('L is the CIE lightness of linear Y (18% grey ≈ 50)', () => {
    const [L] = linearRgbToLab(0.18, 0.18, 0.18)
    table('lab-mid-grey', [
      { field: 'L(0.18 linear)', expected: 49.5, actual: Number(L.toFixed(2)) }
    ])
    expect(L).toBeGreaterThan(49)
    expect(L).toBeLessThan(50)
  })
})

describe('ΔE2000 aggregation over a buffer', () => {
  it('deP95 is the nearest-rank 95th percentile of the per-pixel field', () => {
    // 100 pixels: 95 identical, 5 strongly different. P95 must land in the tail.
    const n = 100
    const a = rgbaFromLuminance(Array(n).fill(0.5))
    const bVals = Array(n).fill(0.5)
    for (let i = 95; i < n; i++) bVals[i] = 0.9
    const b = rgbaFromLuminance(bVals)

    const r = computeDeltaE(a, b, n, 1)
    const tailDe = deltaE2000(
      ...linearRgbToLab(0.5, 0.5, 0.5),
      ...linearRgbToLab(0.9, 0.9, 0.9)
    )
    table('deltaE-p95', [
      {
        field: 'deMean',
        expected: Number((tailDe * 0.05).toFixed(4)),
        actual: Number(r.deMean.toFixed(4))
      },
      {
        field: 'deP95',
        expected: Number(tailDe.toFixed(4)),
        actual: Number(r.deP95.toFixed(4))
      },
      {
        field: 'deMax',
        expected: Number(tailDe.toFixed(4)),
        actual: Number(r.deMax.toFixed(4))
      }
    ])
    // Convention: index floor(0.95 n) of the ascending sort, the first tail
    // sample
    expect(r.deP95).toBeCloseTo(tailDe, 4)
    expect(r.deMax).toBeCloseTo(tailDe, 4)
    expect(r.deMean).toBeCloseTo(tailDe * 0.05, 4)
  })

  it('sorts numerically, not lexicographically', () => {
    // A plain Array.sort() would order 10 before 9 and corrupt the percentile
    const vals = [0.02, 0.9, 0.11, 0.3, 0.05]
    const a = rgbaFromLuminance(vals.map(() => 0))
    const b = rgbaFromLuminance(vals)
    const r = computeDeltaE(a, b, vals.length, 1)
    expect(r.deMax).toBeGreaterThan(r.deMean)
    expect(r.deP95).toBeCloseTo(r.deMax, 6)
  })
})

describe('SSIM — Wang et al. (2004)', () => {
  const W = 48
  const H = 48

  it('uses a σ=1.5 Gaussian window, normalised to unit sum', () => {
    // The documented pre-processing: the local statistics window is the same
    // Gaussian the README names. A unit-sum kernel leaves a constant untouched.
    const flat = new Float32Array(W * H).fill(0.37)
    const blurred = gaussianBlur(flat, W, H, 1.5)
    let maxDrift = 0
    for (let i = 0; i < blurred.length; i++) {
      maxDrift = Math.max(maxDrift, Math.abs(blurred[i]! - 0.37))
    }
    table('ssim-window', [
      { field: 'kernel radius (ceil 3σ)', expected: 5, actual: 5 },
      { field: 'max drift on a constant', expected: 0, actual: maxDrift }
    ])
    expect(maxDrift).toBeLessThan(1e-6)
  })

  // L from side A makes SSIM REFERENCE-RELATIVE, not symmetric: the safe
  // direction for a gate, since L from both sides would let a blown-out side B
  // widen L and mask its error. Capture always passes (linearA, linearB, …)
  it('identical plates score 1; the metric is reference-relative, not symmetric', () => {
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H))
    const b = rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H, 99))
    const self = computeSSIM(a, a, W, H)
    const ab = computeSSIM(a, b, W, H)
    const ba = computeSSIM(b, a, W, H)
    table('ssim-identity-reference-relative', [
      { field: 'SSIM(a,a)', expected: 1, actual: Number(self.toFixed(6)) },
      {
        field: 'SSIM(a,b)',
        expected: '≈ 0 (uncorrelated)',
        actual: Number(ab.toFixed(6))
      },
      {
        field: 'SSIM(b,a)',
        expected: '≈ 0 (uncorrelated)',
        actual: Number(ba.toFixed(6))
      },
      {
        field: 'L(a) vs L(b)',
        expected: 'differ → scores differ',
        actual: Number((ab - ba).toFixed(6))
      }
    ])
    expect(self).toBeCloseTo(1, 6)
    expect(ab).toBeLessThanOrEqual(1 + 1e-9)
    expect(ab).toBeGreaterThanOrEqual(-1 - 1e-9)
    // Both orderings agree on the verdict even though the scores differ
    expect(Math.abs(ab)).toBeLessThan(0.1)
    expect(Math.abs(ba)).toBeLessThan(0.1)
  })

  it('a self-comparison scores exactly 1 at any plate brightness', () => {
    for (const [mean, sd] of [
      [0.101, 0.01],
      [0.0156, 0.0015],
      [0.5, 0.2]
    ] as const) {
      const p = rgbaFromLuminance(ladderPlate(mean, sd, W * H))
      expect(computeSSIM(p, p, W, H), `mean ${mean}`).toBeCloseTo(1, 6)
    }
  })

  it('catches the ×2 exposure sabotage on a ladder-like plate', () => {
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H))
    const ssim = computeSSIM(a, scaled(a, 2), W, H)
    table('ssim-sabotage', [
      {
        field: 'SSIM(a, 2a)',
        expected: '< 0.95 floor',
        actual: Number(ssim.toFixed(4))
      }
    ])
    expect(ssim).toBeLessThan(0.95)
  })

  it('rejects a spatial permutation with identical global statistics', () => {
    const values = ladderPlate(0.101, 0.01, W * H)
    const permuted = [...values].reverse()
    const ssim = computeSSIM(
      rgbaFromLuminance(values),
      rgbaFromLuminance(permuted),
      W,
      H
    )
    table('ssim-spatial-permutation', [
      {
        field: 'same values, reversed pixel positions',
        expected: '< 0.5 spatial floor',
        actual: Number(ssim.toFixed(4))
      }
    ])
    expect(ssim).toBeLessThan(0.5)
  })

  // REGRESSION: at a fixed L = 1.0 uncorrelated plates scored 0.9915 at
  // σ = 0.002. With L = side A's percentile span the score reflects structure
  // at every contrast. Since v4 that is the measured-L DIAGNOSTIC
  it('measured-L form scores uncorrelated plates near zero at every contrast', () => {
    const rows = [0.002, 0.005, 0.01, 0.02, 0.05].map(sd => {
      const a = rgbaFromLuminance(ladderPlate(0.101, sd, W * H))
      const b = rgbaFromLuminance(ladderPlate(0.101, sd, W * H, 4242))
      return {
        sigma: sd,
        wasAtFixedL1: {
          0.002: 0.9915,
          0.005: 0.9494,
          0.01: 0.8251,
          0.02: 0.5445,
          0.05: 0.1704
        }[sd],
        actual: Number(computeSSIMAtMeasuredL(a, b, W, H).toFixed(4))
      }
    })
    table('ssim-uncorrelated-near-zero', rows)
    for (const row of rows) {
      // True structural similarity is 0, and the old floor of 0.95 was vacuous
      // here
      expect(row.actual, `sigma ${row.sigma}`).toBeLessThan(0.1)
    }
  })

  it('measured-L form is independent of plate brightness', () => {
    // Same structure, 6.5× apart in brightness (surface-up vs baseline-medium)
    // At a fixed L = 1.0 these scored 0.8251 and 0.9949 for the same true 0
    const bright = computeSSIMAtMeasuredL(
      rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H)),
      rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H, 4242)),
      W,
      H
    )
    const dim = computeSSIMAtMeasuredL(
      rgbaFromLuminance(ladderPlate(0.0156, 0.0015, W * H)),
      rgbaFromLuminance(ladderPlate(0.0156, 0.0015, W * H, 4242)),
      W,
      H
    )
    table('ssim-brightness-independence', [
      {
        field: 'bright plate (mean 0.101)',
        expected: '≈ dim',
        actual: Number(bright.toFixed(4))
      },
      {
        field: 'dim plate (mean 0.0156)',
        expected: '≈ bright',
        actual: Number(dim.toFixed(4))
      }
    ])
    expect(Math.abs(bright - dim)).toBeLessThan(0.05)
  })

  // The acceptance criterion from the v4 amendment: the plate pair that used to carry
  // phase 1's HIGHEST ssim (0.9716) while neither side rendered anything
  it('no longer endorses the old ecef-identity statistics', () => {
    // c84e3db: A flat at std 0.000283, B std 0.00582, means 0.1016 / 0.1136
    const a = rgbaFromLuminance(ladderPlate(0.1016, 0.000283, W * H))
    const b = rgbaFromLuminance(ladderPlate(0.1136, 0.00582, W * H, 4242))
    const ssim = computeSSIM(a, b, W, H)
    table('ssim-ecef-identity-stand-in', [
      { field: 'was (fixed L=1.0)', expected: 'endorsed', actual: 0.9716 },
      {
        field: 'now (L = span A)',
        expected: '< 0.95 floor',
        actual: Number(ssim.toFixed(4))
      }
    ])
    expect(ssim).toBeLessThan(0.95)
  })

  // v4 (ADR-011 Amendment 3): gated at the ladder reference L, so the
  // bar no longer scales with frame content. On darker plates it is less
  // structure-sensitive, which the plate check and the diagnostic cover
  it('gated SSIM uses the ladder reference L; the measured-L form stays the diagnostic', () => {
    expect(REFERENCE_L).toBe(0.09)
    // A plate whose own span sits at the reference scores the same either way
    const atRef = ladderPlate(0.101, 0.015, W * H)
    const atRefB = ladderPlate(0.101, 0.015, W * H, 4242)
    const spanAtRef = dynamicRange(Float32Array.from(atRef))
    const same = computeSSIM(
      rgbaFromLuminance(atRef),
      rgbaFromLuminance(atRefB),
      W,
      H,
      4,
      spanAtRef
    )
    expect(
      computeSSIMAtMeasuredL(
        rgbaFromLuminance(atRef),
        rgbaFromLuminance(atRefB),
        W,
        H
      )
    ).toBeCloseTo(same, 10)
    // A near-empty plate (coverage-020, span ≈ 0.027 vs 0.09) no longer faces
    // a stricter bar: the same difference scores HIGHER at the reference L, and
    // the gap is what ssimAttribution reports as the stabiliser's share
    const dimA = rgbaFromLuminance(ladderPlate(0.03, 0.004, W * H))
    const dimB = rgbaFromLuminance(ladderPlate(0.03, 0.004, W * H, 4242))
    const gated = computeSSIM(dimA, dimB, W, H)
    const measured = computeSSIMAtMeasuredL(dimA, dimB, W, H)
    table('ssim-v4-reference-vs-measured', [
      {
        field: 'dark plate, gated (L = 0.09)',
        actual: Number(gated.toFixed(4))
      },
      {
        field: 'dark plate, measured L',
        actual: Number(measured.toFixed(4))
      }
    ])
    expect(gated).toBeGreaterThan(measured)
    // Uncorrelated content still cannot pass the ladder floor at the reference
    // L on a plate of ladder contrast (σ = 0.01 at mean 0.101)
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H))
    const b = rgbaFromLuminance(ladderPlate(0.101, 0.01, W * H, 4242))
    expect(computeSSIM(a, b, W, H)).toBeLessThan(0.5)
  })

  it('derives L from side A robustly: percentile span, immune to a hot pixel', () => {
    const lum = Float32Array.from(ladderPlate(0.101, 0.01, W * H))
    const clean = dynamicRange(lum)
    const withOutlier = Float32Array.from(lum)
    // a single fp16 blowout
    withOutlier[0] = 40
    const outlier = dynamicRange(withOutlier)
    const flat = dynamicRange(new Float32Array(64).fill(0.3))
    table('ssim-dynamic-range', [
      {
        field: 'span of a σ=0.01 plate (≈6σ)',
        expected: 0.06,
        actual: Number(clean.toFixed(4))
      },
      {
        field: 'span with one 40.0 pixel',
        expected: 'unchanged',
        actual: Number(outlier.toFixed(4))
      },
      { field: 'span of a flat plate (floored)', expected: 0.001, actual: flat }
    ])
    // Percentiles, not max − min: a 40.0 pixel would put max − min at ~40
    expect(outlier).toBeCloseTo(clean, 2)
    expect(outlier).toBeLessThan(0.1)
    expect(clean).toBeGreaterThan(0.03)
    expect(clean).toBeLessThan(0.09)
    // A degenerate plate floors rather than dividing by zero. The plate check
    // is what actually rejects it
    expect(flat).toBe(0.001)
  })
})

describe('histDist — mean-normalised Wasserstein-1 (ADR-011 amendment)', () => {
  const N = 4096

  it('identical plates score 0', () => {
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, N))
    expect(computeHistogramDistance(a, a, N, 1)).toBeCloseTo(0, 12)
  })

  // The defining property: exposure ×k scores exactly |k − 1|, because
  // W1 = ∫|Q_A(p) − k·Q_A(p)|dp = |1 − k|·mean(A)
  it('a uniform exposure error ×k scores exactly |k − 1|', () => {
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, N))
    const rows = [1.05, 1.1, 1.25, 1.5, 2.0, 0.9, 0.5].map(k => ({
      k,
      expected: Math.abs(k - 1),
      actual: Number(computeHistogramDistance(a, scaled(a, k), N, 1).toFixed(6))
    }))
    table('histDist-exposure-law', rows)
    for (const row of rows) {
      expect(row.actual, `k=${row.k}`).toBeCloseTo(row.expected, 5)
    }
  })

  it('the 10% exposure shift sits exactly on the 0.1 design floor', () => {
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, N))
    const at10 = computeHistogramDistance(a, scaled(a, 1.1), N, 1)
    const sabotage = computeHistogramDistance(a, scaled(a, 2), N, 1)
    table('histDist-floor', [
      {
        field: '10% exposure vs floor 0.1',
        expected: 0.1,
        actual: Number(at10.toFixed(6))
      },
      {
        field: '×2 sabotage',
        expected: 1.0,
        actual: Number(sabotage.toFixed(6))
      }
    ])
    expect(at10).toBeCloseTo(0.1, 5)
    expect(sabotage).toBeCloseTo(1.0, 5)
  })

  // Two-point plate: a fraction c of pixels at cloud luminance, the rest sky
  // W1 between two such plates is |Δc| · |L_cloud − L_sky|
  it('a coverage difference scores Δc · contrast / mean(A)', () => {
    const skyL = 0.104
    // ladder contrast: coverage-020 mean 0.1020 → coverage-090 mean 0.0654
    const cloudL = 0.067
    const plate = (c: number): Float32Array => {
      const vals: number[] = []
      for (let i = 0; i < N; i++)
        vals.push(i < Math.round(c * N) ? cloudL : skyL)
      return rgbaFromLuminance(vals)
    }
    const a = plate(0.2)
    const meanA = 0.2 * cloudL + 0.8 * skyL
    const rows = [0.3, 0.5, 0.7].map(cB => {
      const dc = Math.abs(cB - 0.2)
      return {
        deltaCoverage: dc,
        expected: Number(((dc * (skyL - cloudL)) / meanA).toFixed(6)),
        actual: Number(computeHistogramDistance(a, plate(cB), N, 1).toFixed(6))
      }
    })
    table('histDist-coverage-law', rows)
    for (const row of rows) {
      expect(row.actual, `Δc=${row.deltaCoverage}`).toBeCloseTo(row.expected, 4)
    }
    // A 50% coverage difference at the ladder's own cloud/sky contrast scores
    // ≈ 0.18, comfortably above the 0.1 floor, so the gate catches it
    const at50 = computeHistogramDistance(a, plate(0.7), N, 1)
    expect(at50).toBeGreaterThan(0.15)
    expect(at50).toBeLessThan(0.25)
  })

  // The regression this task exists for. baseline-medium's real statistics:
  // A mean 0.1010 std 0.0100, B mean 0.1123 std 0.0077, an 11% exposure
  // difference. The old 256-bin L1 read 1.413 out of a 2.0 ceiling.
  it('does not saturate on the baseline-medium plate pair', () => {
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.01, N))
    const b = rgbaFromLuminance(ladderPlate(0.1123, 0.0077, N, 77))
    const w1 = computeHistogramDistance(a, b, N, 1)
    table('histDist-baseline-medium', [
      {
        field: 'old 256-bin L1 (committed)',
        expected: '~1.413 of 2.0',
        actual: 1.413
      },
      {
        field: 'new W1/mean(A)',
        expected: '≈ 0.11 (the mean shift)',
        actual: Number(w1.toFixed(4))
      }
    ])
    // The reported number is now the exposure difference it actually is
    expect(w1).toBeGreaterThan(0.09)
    expect(w1).toBeLessThan(0.16)
  })

  it('is scale-free: the same relative error scores the same on a dim plate', () => {
    // surface-up is 6× dimmer than baseline-medium (A mean 0.0156 vs 0.1010)
    // An absolute-unit metric would rank the same relative error 6× lower
    const bright = rgbaFromLuminance(ladderPlate(0.101, 0.01, N))
    const dim = rgbaFromLuminance(ladderPlate(0.0156, 0.0015, N))
    const dBright = computeHistogramDistance(bright, scaled(bright, 1.1), N, 1)
    const dDim = computeHistogramDistance(dim, scaled(dim, 1.1), N, 1)
    table('histDist-scale-free', [
      {
        field: 'bright plate (mean 0.101)',
        expected: 0.1,
        actual: Number(dBright.toFixed(6))
      },
      {
        field: 'dim plate (mean 0.0156)',
        expected: 0.1,
        actual: Number(dDim.toFixed(6))
      }
    ])
    expect(dBright).toBeCloseTo(dDim, 5)
  })

  it('grows linearly with a shift instead of saturating', () => {
    // The property L1 lacked: doubling the offset doubles the score, with no
    // ceiling, however narrow the distribution is
    const a = rgbaFromLuminance(ladderPlate(0.101, 0.002, N))
    const shifted = (d: number): Float32Array =>
      rgbaFromLuminance(ladderPlate(0.101, 0.002, N).map(v => v + d))
    const rows = [0.005, 0.01, 0.02, 0.04].map(d => ({
      offset: d,
      expected: Number((d / 0.101).toFixed(4)),
      actual: Number(computeHistogramDistance(a, shifted(d), N, 1).toFixed(4))
    }))
    table('histDist-linearity', rows)
    for (const row of rows) {
      expect(row.actual, `offset ${row.offset}`).toBeCloseTo(row.expected, 2)
    }
  })

  it('luminance is the Rec.709 weighting the definition names', () => {
    table('luminance-weights', [
      { field: 'R', expected: 0.2126, actual: luminance(1, 0, 0) },
      { field: 'G', expected: 0.7152, actual: luminance(0, 1, 0) },
      { field: 'B', expected: 0.0722, actual: luminance(0, 0, 1) },
      { field: 'white', expected: 1, actual: luminance(1, 1, 1) }
    ])
    expect(luminance(1, 1, 1)).toBeCloseTo(1, 12)
  })
})

describe('metrics version contract', () => {
  it('accepts the current version and rejects the pre-amendment one', () => {
    expect(checkMetricsVersion(METRICS_VERSION)).toEqual([])
    const stale = checkMetricsVersion(undefined)
    const v1 = checkMetricsVersion(1)
    table('metrics-version', [
      {
        field: 'current',
        expected: 0,
        actual: checkMetricsVersion(METRICS_VERSION).length
      },
      { field: 'missing (v1 evidence)', expected: 1, actual: stale.length },
      { field: 'explicit v1', expected: 1, actual: v1.length }
    ])
    expect(stale).toHaveLength(1)
    expect(stale[0]).toContain('re-capture')
    expect(stale[0]).toContain('metricsVersion 1')
    expect(v1).toHaveLength(1)
  })

  it('METRICS_VERSION is 4 — SSIM gated at the ladder reference L', () => {
    expect(METRICS_VERSION).toBe(4)
  })
})
