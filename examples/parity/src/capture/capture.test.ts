import { describe, expect, test } from 'vitest'

import { computeDeltaE } from '../metrics/deltaE'
import { evaluate, type PhaseThresholds } from '../metrics/evaluate'
import { computeHistogramDistance } from '../metrics/histogram'
import { computeSSIM } from '../metrics/ssim'
import { computeDiffImage } from './diff'

const W = 32
const H = 32
const CH = 4

function makeGradientBuffer(scale = 1): Float32Array {
  const buf = new Float32Array(W * H * CH)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH
      buf[i] = (x / W) * scale
      buf[i + 1] = (y / H) * scale
      buf[i + 2] = ((x + y) / (W + H)) * scale
      buf[i + 3] = 1
    }
  }
  return buf
}

const PHASE1_THRESHOLDS: PhaseThresholds = {
  ssim: 0.92,
  deP95: 8,
  histDist: 0.05
}

describe('linear readback → metrics pipeline', () => {
  const bufA = makeGradientBuffer()
  const bufB = makeGradientBuffer()

  test('identical buffers produce SSIM ≈ 1', () => {
    const ssim = computeSSIM(bufA, bufB, W, H, CH)
    expect(ssim).toBeGreaterThan(0.999)
  })

  test('identical buffers produce ΔE2000 mean ≈ 0', () => {
    const de = computeDeltaE(bufA, bufB, W, H, CH)
    expect(de.deMean).toBeLessThan(0.01)
    expect(de.deP95).toBeLessThan(0.01)
  })

  test('identical buffers produce histogram distance ≈ 0', () => {
    const hd = computeHistogramDistance(bufA, bufB, W, H, CH)
    expect(hd).toBeLessThan(0.001)
  })

  test('identical buffers produce diff maxDelta = 0', () => {
    const diff = computeDiffImage(bufA, bufB, W, H, CH, 8)
    expect(diff.maxDelta).toBe(0)
  })

  test('identical buffers evaluate as pass', () => {
    const ssim = computeSSIM(bufA, bufB, W, H, CH)
    const de = computeDeltaE(bufA, bufB, W, H, CH)
    const hd = computeHistogramDistance(bufA, bufB, W, H, CH)
    const result = evaluate(
      { ssim, deMean: de.deMean, deP95: de.deP95, histDist: hd },
      PHASE1_THRESHOLDS
    )
    expect(result.result).toBe('pass')
  })
})

describe('sabotage ×2 exposure', () => {
  const bufA = makeGradientBuffer(1)
  const bufSabotaged = makeGradientBuffer(2)

  test('×2 scale drops SSIM below Phase-1 threshold', () => {
    const ssim = computeSSIM(bufA, bufSabotaged, W, H, CH)
    expect(ssim).toBeLessThan(PHASE1_THRESHOLDS.ssim!)
  })

  test('×2 scale raises ΔE2000', () => {
    const de = computeDeltaE(bufA, bufSabotaged, W, H, CH)
    expect(de.deMean).toBeGreaterThan(1)
  })

  test('×2 scale raises histogram distance', () => {
    const hd = computeHistogramDistance(bufA, bufSabotaged, W, H, CH)
    expect(hd).toBeGreaterThan(0.01)
  })

  test('×2 scale produces visible diff', () => {
    const diff = computeDiffImage(bufA, bufSabotaged, W, H, CH, 8)
    expect(diff.maxDelta).toBeGreaterThan(0.1)
  })

  test('×2 scale evaluates as fail', () => {
    const ssim = computeSSIM(bufA, bufSabotaged, W, H, CH)
    const de = computeDeltaE(bufA, bufSabotaged, W, H, CH)
    const hd = computeHistogramDistance(bufA, bufSabotaged, W, H, CH)
    const result = evaluate(
      { ssim, deMean: de.deMean, deP95: de.deP95, histDist: hd },
      PHASE1_THRESHOLDS
    )
    expect(result.result).toBe('fail')
    expect(result.reasons.length).toBeGreaterThan(0)
  })
})

describe('sabotage buffer scaling', () => {
  test('in-place ×2 scaling matches makeGradientBuffer(2)', () => {
    const original = makeGradientBuffer(1)
    const expected = makeGradientBuffer(2)
    for (let i = 0; i < original.length; i++) {
      if (i % CH !== 3) original[i] = original[i]! * 2
    }
    for (let i = 0; i < original.length; i++) {
      expect(original[i]).toBeCloseTo(expected[i]!, 10)
    }
  })
})
