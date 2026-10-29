// the shaded-fraction receipt. SSIM at the ladder reference L cannot
// see whether a cloud shadow EXISTS (a 90 % shadow loss shipped green), so
// shadow cases render both sides with the casters genuinely off and count the
// pixels the shadow darkens. These tests pin the counting and the receipt's
// three refusals: flags not off, plate did not brighten, ratio below floor
import { describe, expect, it } from 'vitest'

import {
  buildShadedFractionReceipt,
  computeShadedFraction,
  evaluateShadedFraction,
  LUMINANCE_FLOOR,
  MIN_SIGNAL_FRACTION,
  SHADED_RATIO,
  SHADED_RATIO_FLOOR
} from './shadedFraction'

const W = 8
const H = 8

/** A flat RGBA field of one luminance */
function flat(value: number, w = W, h = H): Float32Array {
  const buf = new Float32Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = value
    buf[i * 4 + 1] = value
    buf[i * 4 + 2] = value
    buf[i * 4 + 3] = 1
  }
  return buf
}

/** `off` darkened by `factor` on the first `count` pixels (the shadow) */
function shadowed(
  off: Float32Array,
  count: number,
  factor: number
): Float32Array {
  const on = Float32Array.from(off)
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      on[i * 4 + c] = (off[i * 4 + c] ?? 0) * factor
    }
  }
  return on
}

const OFF = { A: [false, false], B: [false] }
const ON = { A: [true, true], B: [true] }

describe('computeShadedFraction', () => {
  it('counts the pixels the shadow darkens below SHADED_RATIO of the lit plate', () => {
    const off = flat(0.5)
    // 16 of 64 pixels at 40 %, shaded
    const on = shadowed(off, 16, 0.4)
    const side = computeShadedFraction(on, off, W, H)
    expect(side.classified).toBe(64)
    expect(side.fraction).toBeCloseTo(16 / 64, 6)
    expect(side.rise).toBeGreaterThan(0)
    expect(side.meanOff).toBeCloseTo(0.5, 6)
  })

  it('reads zero when on and off are identical (no shadow at all)', () => {
    const off = flat(0.5)
    const side = computeShadedFraction(Float32Array.from(off), off, W, H)
    expect(side.fraction).toBe(0)
    expect(side.rise).toBe(0)
  })

  it('does not count a pixel darkened by less than the SHADED_RATIO margin', () => {
    const off = flat(0.5)
    // 99 %, not a shadow
    const on = shadowed(off, 64, (SHADED_RATIO + 1) / 2)
    expect(computeShadedFraction(on, off, W, H).fraction).toBe(0)
  })

  it('ignores pixels whose lit plate is below LUMINANCE_FLOOR (black sky is not shadow)', () => {
    const off = flat(LUMINANCE_FLOOR / 2)
    const on = shadowed(off, 64, 0.1)
    const side = computeShadedFraction(on, off, W, H)
    expect(side.classified).toBe(0)
    expect(side.fraction).toBe(0)
  })

  it('honours a 3-channel stride', () => {
    const off = new Float32Array(W * H * 3).fill(0.5)
    const on = Float32Array.from(off)
    for (let i = 0; i < 32 * 3; i++) on[i] = 0.1
    expect(computeShadedFraction(on, off, W, H, 3).fraction).toBeCloseTo(0.5, 6)
  })
})

describe('evaluateShadedFraction', () => {
  const off = flat(0.5)
  const A = computeShadedFraction(shadowed(off, 32, 0.4), off, W, H)

  it('accepts a receipt whose flags read back off, plate brightened, ratio ≥ floor', () => {
    const B = computeShadedFraction(shadowed(off, 30, 0.4), off, W, H)
    const receipt = buildShadedFractionReceipt(A, B, OFF, ON)
    expect(receipt.ratio).toBeCloseTo(30 / 32, 6)
    expect(evaluateShadedFraction(receipt)).toEqual([])
  })

  it("refuses when a side's flags did not read back all-off (the set() no-op trap)", () => {
    const B = computeShadedFraction(shadowed(off, 30, 0.4), off, W, H)
    const receipt = buildShadedFractionReceipt(
      A,
      B,
      { A: [false, false], B: [true] },
      ON
    )
    const reasons = evaluateShadedFraction(receipt)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/side B flags did not read back all-off/)
  })

  it('refuses when a side has no flags at all', () => {
    const B = computeShadedFraction(shadowed(off, 30, 0.4), off, W, H)
    const receipt = buildShadedFractionReceipt(
      A,
      B,
      { A: [false, false], B: null },
      ON
    )
    expect(evaluateShadedFraction(receipt).join('\n')).toMatch(/side B flags/)
  })

  it('refuses when the plate did not brighten with casters off (the knob is inert)', () => {
    const B = computeShadedFraction(Float32Array.from(off), off, W, H)
    const receipt = buildShadedFractionReceipt(A, B, OFF, ON)
    const reasons = evaluateShadedFraction(receipt)
    expect(reasons.join('\n')).toMatch(/side B plate did not brighten/)
    // A refusal about the receipt itself never proceeds to the ratio
    expect(reasons.join('\n')).not.toMatch(/ratio/)
  })

  it('fails the ratio floor when B shades far fewer pixels than A', () => {
    const B = computeShadedFraction(shadowed(off, 4, 0.4), off, W, H)
    const receipt = buildShadedFractionReceipt(A, B, OFF, ON)
    const reasons = evaluateShadedFraction(receipt)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/ratio 0\.125 < 0\.85/)
  })

  it('passes exactly at the floor', () => {
    const B = computeShadedFraction(shadowed(off, 32, 0.4), off, W, H)
    const receipt = {
      ...buildShadedFractionReceipt(A, B, OFF, ON),
      ratio: SHADED_RATIO_FLOOR
    }
    expect(evaluateShadedFraction(receipt)).toEqual([])
  })

  it('ratio is 0, not NaN, when A shades nothing', () => {
    const none = computeShadedFraction(Float32Array.from(off), off, W, H)
    const receipt = buildShadedFractionReceipt(none, none, OFF, ON)
    expect(receipt.ratio).toBe(0)
  })
})

// mail #673: ground-bounce-on passed at ratio 10.7 on A 0.00 % / B 0.02 %
describe('evaluateShadedFraction — minimum signal', () => {
  it('refuses a receipt whose side A shades less than MIN_SIGNAL_FRACTION, before any ratio', () => {
    const side = (fraction: number) => ({
      fraction,
      meanOn: 0.5,
      meanOff: 0.5001,
      rise: 1.3e-4,
      classified: 64
    })
    const receipt = {
      ...buildShadedFractionReceipt(side(0.00002), side(0.0002), OFF, ON),
      ratio: 10.737
    }
    const reasons = evaluateShadedFraction(receipt)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/no shadow in frame — side A shades 0\.00 %/)
    expect(reasons[0]).not.toMatch(/ratio 10/)
  })

  it('passes exactly at the minimum-signal fraction', () => {
    const A = {
      fraction: MIN_SIGNAL_FRACTION,
      meanOn: 0.4,
      meanOff: 0.5,
      rise: 0.2,
      classified: 64
    }
    expect(
      evaluateShadedFraction(buildShadedFractionReceipt(A, { ...A }, OFF, ON))
    ).toEqual([])
  })
})

// shadow-sphere is the one lighting:'lights' case. Side A has no
// shadow consumer there, so the receipt gates side B. ADR-011 Amendment 13
describe("evaluateShadedFraction — compare 'b-only'", () => {
  const side = (fraction: number, rise: number) => ({
    fraction,
    meanOn: 0.25,
    meanOff: 0.25 + rise,
    rise,
    classified: 921600
  })

  it('passes with side A unable to brighten at all — A has no consumer', () => {
    const receipt = buildShadedFractionReceipt(
      // side A: rise exactly 0, which ratio mode refuses
      side(0.0963, 0),
      side(0.0428, 0.0034),
      OFF,
      ON,
      'b-only'
    )
    expect(evaluateShadedFraction(receipt)).toEqual([])
  })

  it('still refuses when side B does not brighten with casters off', () => {
    const receipt = buildShadedFractionReceipt(
      side(0.0963, 0.01),
      side(0.0428, 0),
      OFF,
      ON,
      'b-only'
    )
    const reasons = evaluateShadedFraction(receipt)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/side B plate did not brighten/)
  })

  it('still refuses when the flags did not read back all-off', () => {
    const receipt = buildShadedFractionReceipt(
      side(0.0963, 0),
      side(0.0428, 0.0034),
      { A: [true, false], B: [false] },
      ON,
      'b-only'
    )
    expect(evaluateShadedFraction(receipt)).toHaveLength(1)
    expect(evaluateShadedFraction(receipt)[0]).toMatch(/side A flags/)
  })

  it('reads the minimum-signal floor off side B, not side A', () => {
    // A is over the floor and B is not: under b-only that is a fail, and the
    // reason must name B so it cannot be mistaken for the old A-shaped one
    const receipt = buildShadedFractionReceipt(
      side(0.5, 0.01),
      side(0.0002, 0.001),
      OFF,
      ON,
      'b-only'
    )
    const reasons = evaluateShadedFraction(receipt)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/no shadow in frame — side B shades 0\.02 %/)
  })

  it('the same numbers FAIL under ratio mode, which is the defect it exists for', () => {
    // The committed case 35 evidence: A 9.63 % / B 4.28 %, ratio 0.445
    // below 0.85. b-only passes it. Ratio mode must still reject it
    const A = side(0.096265, 0.010407)
    const B = side(0.042842, 0.003405)
    expect(
      evaluateShadedFraction(buildShadedFractionReceipt(A, B, OFF, ON))
    ).toHaveLength(1)
    expect(
      evaluateShadedFraction(
        buildShadedFractionReceipt(A, B, OFF, ON, 'b-only')
      )
    ).toEqual([])
  })

  it('omits the compare field from nothing: the policy travels with the receipt', () => {
    const receipt = buildShadedFractionReceipt(
      side(0.5, 0.01),
      side(0.5, 0.01),
      OFF,
      ON
    )
    expect(receipt.compare).toBe('ratio')
  })
})
