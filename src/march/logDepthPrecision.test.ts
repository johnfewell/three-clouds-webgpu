// log depth is a round trip, so a render test cannot fail with it off
// (p4.spec.ts clause 5 is smoke only). The encodings differ in precision, which
// is flat in log(z) and collapses at the far end of a perspective buffer

// The same assertions run against the perspective encoding and must fail. The
// hardware on/off e2e on both sides is still owed

import { describe, expect, it } from 'vitest'

import {
  logarithmicToPerspectiveDepthCPU,
  perspectiveDepthToViewZCPU
} from './sceneDepth'

// A geospatial extreme: 10 cm near plane, 10 000 km far plane
const NEAR = 0.1
const FAR = 1e7
const BITS = 24
const LEVELS = (1 << BITS) - 1

/** One depth-buffer quantisation step */
const quantise = (d: number): number =>
  Math.round(Math.min(1, Math.max(0, d)) * LEVELS) / LEVELS

// Forward encoders, the inverses of the decoders under test (src ships only
// decode). The first test proves they are inverses, so a precision result
// cannot come from a bad encoder
const logDepthOf = (viewZ: number): number =>
  Math.log(-viewZ / NEAR) / Math.log(FAR / NEAR)
const perspDepthOf = (viewZ: number): number =>
  ((NEAR + viewZ) * FAR) / ((FAR - NEAR) * viewZ)

/** Decode as the runtime does: log depth -> perspective depth -> viewZ */
const viewZFromLog = (d: number): number =>
  perspectiveDepthToViewZCPU(
    logarithmicToPerspectiveDepthCPU(d, NEAR, FAR),
    NEAR,
    FAR
  )
/** THE LINEAR STAND-IN: the same decode with the logarithmic stage removed */
const viewZFromPersp = (d: number): number =>
  perspectiveDepthToViewZCPU(d, NEAR, FAR)

const relErr = (got: number, want: number): number =>
  Math.abs(got - want) / Math.abs(want)

describe('log-depth precision at an extreme near/far ratio', () => {
  it('the encoders are exact inverses of the shipped decoders', () => {
    // Without this the precision numbers below could come from a wrong encoder
    // rather than from the encoding
    for (const frac of [0.1, 0.5, 0.9, 0.99]) {
      const viewZ = -FAR * frac
      expect(viewZFromLog(logDepthOf(viewZ))).toBeCloseTo(viewZ, 0)
      expect(viewZFromPersp(perspDepthOf(viewZ))).toBeCloseTo(viewZ, 0)
    }
  })

  it('survives quantisation where the linear stand-in does not', () => {
    for (const frac of [0.5, 0.9, 0.99]) {
      const viewZ = -FAR * frac

      const logErr = relErr(viewZFromLog(quantise(logDepthOf(viewZ))), viewZ)
      const perspErr = relErr(
        viewZFromPersp(quantise(perspDepthOf(viewZ))),
        viewZ
      )

      // Logarithmic: flat relative error, far below a part per million
      expect(logErr).toBeLessThan(1e-5)
      // The stand-in: three or more orders worse at every one of these depths
      expect(perspErr).toBeGreaterThan(1e-3)
      expect(perspErr / logErr).toBeGreaterThan(1e3)
    }
  })

  it('keeps nearby depths RESOLVABLE where the linear stand-in collapses them', () => {
    // The property a renderer actually depends on: two surfaces 1 % apart in
    // viewZ near the far plane must land in different depth-buffer slots
    const viewZ = -FAR * 0.9
    const nearby = viewZ * 1.01

    expect(quantise(logDepthOf(viewZ))).not.toBe(quantise(logDepthOf(nearby)))
    expect(quantise(perspDepthOf(viewZ))).toBe(quantise(perspDepthOf(nearby)))
  })
})
