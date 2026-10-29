// Paired spec for fixtures/fn-coverage/shader.ts. NOT a ported file, and not a
// shader test: its job is to be the COVERING TEST the detector reads, so it
// names the four sites it compiles and leaves the fifth out
//
// The compiles are real and cheap (compileWGSL needs no GPU), which keeps the
// canary honest , `orphanFn` is absent from this file, and this file is the
// only thing that could have supplied evidence about it

import { float } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../../../test/helpers/compileWGSL'
import {
  alpha,
  alphaCPU,
  applyGamma,
  betaFunction,
  cpuBeta,
  cpuGamma,
  delta,
  deltaTSL,
  epsilonOuter
} from './shader'

describe('fn-coverage fixture', () => {
  it('alpha: twin called, and the Fn compiles', () => {
    expect(alphaCPU(2)).toBe(1)
    expect(
      compileWGSL(alpha(float(2), float(1))).fragment.length
    ).toBeGreaterThan(0)
  })

  it('betaFunction: cpuBeta is called, and the Fn compiles', () => {
    expect(cpuBeta(0.5)).toBe(0.5)
    expect(
      compileWGSL(betaFunction(float(0.5))).fragment.length
    ).toBeGreaterThan(0)
  })

  it('applyGamma: cpuGamma is called, and the Fn compiles', () => {
    expect(cpuGamma(2, 3)).toBe(6)
    expect(
      compileWGSL(applyGamma(float(2), float(3))).fragment.length
    ).toBeGreaterThan(0)
  })

  it('deltaTSL: the sibling JS export delta is called, and the Fn compiles', () => {
    expect(delta(-1)).toBe(0)
    expect(compileWGSL(deltaTSL(float(-1))).fragment.length).toBeGreaterThan(0)
  })

  it('epsilonOuter compiles, reaching the module-private epsilonInner', () => {
    expect(compileWGSL(epsilonOuter(float(1))).fragment.length).toBeGreaterThan(
      0
    )
  })
  // orphanFn is deliberately ABSENT: never imported, never compiled. The
  // detector must report it NEITHER, and this file is the only place in the
  // fixture that could have said otherwise
})
