// the atlas channel-agreement receipt. A packed debug plate's
// SSIM follows the largest channel, including one no consumer reads
// These pin the measurement, the no-signal refusal, and the gate on the
// channels that decide optical depth
import { describe, expect, it } from 'vitest'

import {
  ATLAS_CHANNELS,
  buildAtlasChannelReceipt,
  computeAtlasChannelMeans,
  evaluateAtlasChannelReceipt,
  formatAtlasChannelReceipt,
  type AtlasChannelGate
} from './atlasChannels'

const W = 4
const H = 4

/** A plate whose three channels are constant */
function plate(r: number, g: number, b: number): Float32Array {
  const buf = new Float32Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = 1
  }
  return buf
}

const GATE: AtlasChannelGate = {
  channels: ['g', 'b'],
  tolerance: 0.05,
  reason: 'the channels that decide optical depth'
}

describe('computeAtlasChannelMeans', () => {
  it('reads each channel separately, not the luminance', () => {
    const means = computeAtlasChannelMeans(plate(0.5, 0.25, 0.125), W, H)
    expect(means.r).toBeCloseTo(0.5, 7)
    expect(means.g).toBeCloseTo(0.25, 7)
    expect(means.b).toBeCloseTo(0.125, 7)
  })

  it('averages a varying channel rather than sampling one texel', () => {
    const buf = plate(0, 0, 0)
    for (let i = 0; i < W * H; i++) buf[i * 4 + 1] = i === 0 ? 1 : 0
    expect(computeAtlasChannelMeans(buf, W, H).g).toBeCloseTo(1 / 16, 7)
  })

  it('honours a 3-channel stride', () => {
    const buf = new Float32Array(W * H * 3)
    for (let i = 0; i < W * H; i++) {
      buf[i * 3] = 1
      buf[i * 3 + 1] = 2
      buf[i * 3 + 2] = 3
    }
    const means = computeAtlasChannelMeans(buf, W, H, 3)
    expect([means.r, means.g, means.b]).toEqual([1, 2, 3])
  })

  it('refuses a truncated plate rather than averaging a prefix', () => {
    // Two pixels of a four-by-four plate: the prefix mean is a real number,
    // and would be indistinguishable from a measurement
    expect(() => computeAtlasChannelMeans(new Float32Array(8), W, H)).toThrow(
      /truncated/
    )
  })

  it('refuses an empty plate', () => {
    expect(() => computeAtlasChannelMeans(new Float32Array(0), 0, 0)).toThrow(
      /non-empty/
    )
  })
})

describe('buildAtlasChannelReceipt', () => {
  const A = computeAtlasChannelMeans(plate(0.45, 0.0012, 0.0045), W, H)

  it('passes when every GATED channel holds the tolerance', () => {
    // kryf's measurement on the committed debug-shadow-map plate: g and b
    // agree to 0.4 % and 1.6 % while r is 15.25x apart
    const B = computeAtlasChannelMeans(plate(6.88, 0.00122, 0.00449), W, H)
    const receipt = buildAtlasChannelReceipt(A, B, GATE)
    expect(receipt.reasons).toEqual([])
    expect(receipt.ratio.g).toBeCloseTo(1.0167, 3)
    expect(receipt.ratio.b).toBeCloseTo(0.9978, 3)
    // The ungated channel is MEASURED even though it is not scored, so the
    // 15.25x stays visible in metrics.json instead of being hidden
    expect(receipt.ratio.r).toBeCloseTo(15.29, 1)
  })

  it('fails when a gated channel moves past the tolerance', () => {
    // The defect the gate exists to catch: green, which IS meanExtinction,
    // off by 20 % between the sides
    const B = computeAtlasChannelMeans(plate(0.45, 0.00144, 0.0045), W, H)
    const reasons = buildAtlasChannelReceipt(A, B, GATE).reasons
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/atlas channel g: B\/A 1\.2000/)
    expect(reasons[0]).toMatch(/20\.00 % > 5\.00 %/)
  })

  it('the committed debug-shadow-map plate fails at tolerance 0.0001', () => {
    // The bite: these are the committed channel means (r 15.2561, g 1.0046,
    // b 0.9842). 5 % passes. 0.0001 is under both gated deviations, so the
    // gate goes red on g and b and still ignores the ungated red channel
    const committedA = computeAtlasChannelMeans(
      plate(0.4507947, 0.0012179, 0.00451),
      W,
      H
    )
    const committedB = computeAtlasChannelMeans(
      plate(6.8773752, 0.0012234, 0.0044389),
      W,
      H
    )
    expect(
      buildAtlasChannelReceipt(committedA, committedB, GATE).reasons
    ).toEqual([])
    const reasons = buildAtlasChannelReceipt(committedA, committedB, {
      ...GATE,
      tolerance: 0.0001
    }).reasons
    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toMatch(/atlas channel g/)
    expect(reasons[1]).toMatch(/atlas channel b/)
  })

  it('does not fail on an UNGATED channel moving 15x', () => {
    const B = computeAtlasChannelMeans(plate(6.88, 0.0012, 0.0045), W, H)
    expect(buildAtlasChannelReceipt(A, B, GATE).reasons).toEqual([])
  })

  it('passes exactly at the tolerance and fails one ulp past it', () => {
    const at = (k: number) =>
      computeAtlasChannelMeans(plate(0.45, 0.0012 * k, 0.0045), W, H)
    // 1e-9 either side of 1.05, which is well above float32 noise at 1.2e-3
    expect(buildAtlasChannelReceipt(A, at(1.05), GATE).reasons).toEqual([])
    expect(buildAtlasChannelReceipt(A, at(1.0501), GATE).reasons).toHaveLength(
      1
    )
  })

  it('refuses a gated channel that is identically zero, naming both sides', () => {
    const zero = computeAtlasChannelMeans(plate(0.45, 0, 0.0045), W, H)
    const reasons = buildAtlasChannelReceipt(zero, zero, GATE).reasons
    // Both, because both are load-bearing: the channel is absent, so 0/0
    // would otherwise read as perfect agreement
    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toMatch(/gated channel g has mean 0 on side A/)
    expect(reasons[1]).toMatch(/gated channel g has mean 0 on side B/)
    // Not a silent NaN
    expect(buildAtlasChannelReceipt(zero, zero, GATE).ratio.g).toBe(0)
  })

  it('refuses a gated channel that is zero on side B but not side A', () => {
    const B = computeAtlasChannelMeans(plate(0.45, 0.0012, 0), W, H)
    const reasons = buildAtlasChannelReceipt(A, B, GATE).reasons
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/gated channel b has mean 0 on side B/)
  })

  it('refuses when the case gated no channel at all', () => {
    const reasons = buildAtlasChannelReceipt(A, A, {
      channels: [],
      tolerance: 0.05,
      reason: 'nothing'
    }).reasons
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/gated no channel/)
  })
})

describe('evaluateAtlasChannelReceipt', () => {
  it('re-derives the verdict from the receipt, so a loaded one is re-checked', () => {
    const A = computeAtlasChannelMeans(plate(0.45, 0.0012, 0.0045), W, H)
    const B = computeAtlasChannelMeans(plate(0.45, 0.00144, 0.0045), W, H)
    const receipt = buildAtlasChannelReceipt(A, B, GATE)
    expect(evaluateAtlasChannelReceipt(receipt)).toEqual(receipt.reasons)
    expect(receipt.reasons).toHaveLength(1)
  })
})

describe('formatAtlasChannelReceipt', () => {
  it('marks the gated channels and lists all three', () => {
    const A = computeAtlasChannelMeans(plate(0.45, 0.0012, 0.0045), W, H)
    const B = computeAtlasChannelMeans(plate(6.88, 0.0012, 0.0045), W, H)
    const line = formatAtlasChannelReceipt(buildAtlasChannelReceipt(A, B, GATE))
    expect(line).toBe('r 15.2889 g 1.0000* b 1.0000*')
    expect(ATLAS_CHANNELS).toHaveLength(3)
  })
})
