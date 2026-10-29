// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// CPU-twin test for getLayerDensity (clouds.glsl:105–110)

import { Vector4 } from 'three'
import { uniform } from 'three/tsl'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { getLayerDensity, getLayerDensityCPU } from './layerDensity'

describe('layerDensity', () => {
  beforeEach(() => {
    setCurrentSpec('layerDensity')
  })

  test('default profile (0, 0, 0.75, 0.25) at h = 0, 0.5, 1', () => {
    const expTerm = 0
    const exponent = 0
    const linearTerm = 0.75
    const constantTerm = 0.25

    const cases = [
      { h: 0, expected: 0.25 },
      { h: 0.5, expected: 0.625 },
      { h: 1.0, expected: 1.0 }
    ]

    const rows = cases.map(({ h, expected }) => ({
      h,
      expected,
      actual: getLayerDensityCPU(h, expTerm, exponent, linearTerm, constantTerm)
    }))
    table('layerDensity:default-profile', rows)

    for (const { h, expected } of cases) {
      expectClose(
        getLayerDensityCPU(h, expTerm, exponent, linearTerm, constantTerm),
        expected,
        { label: `h=${h}` }
      )
    }
  })

  test('exponential profile produces exp decay', () => {
    const expTerm = 1.0
    const exponent = -2.0
    const linearTerm = 0
    const constantTerm = 0

    const cases = [
      { h: 0, expected: 1.0 },
      { h: 0.5, expected: Math.exp(-1.0) },
      { h: 1.0, expected: Math.exp(-2.0) }
    ]

    const rows = cases.map(({ h, expected }) => ({
      h,
      expected,
      actual: getLayerDensityCPU(h, expTerm, exponent, linearTerm, constantTerm)
    }))
    table('layerDensity:exp-profile', rows)

    for (const { h, expected } of cases) {
      expectClose(
        getLayerDensityCPU(h, expTerm, exponent, linearTerm, constantTerm),
        expected,
        { label: `h=${h}` }
      )
    }
  })

  test('mixed profile (all terms active)', () => {
    const expTerm = 0.5
    const exponent = -1.0
    const linearTerm = 0.3
    const constantTerm = 0.2

    const cases = [
      { h: 0, expected: 0.5 * Math.exp(0) + 0.3 * 0 + 0.2 },
      { h: 0.5, expected: 0.5 * Math.exp(-0.5) + 0.3 * 0.5 + 0.2 },
      { h: 1.0, expected: 0.5 * Math.exp(-1.0) + 0.3 * 1.0 + 0.2 }
    ]

    const rows = cases.map(({ h, expected }) => ({
      h,
      expected,
      actual: getLayerDensityCPU(h, expTerm, exponent, linearTerm, constantTerm)
    }))
    table('layerDensity:mixed-profile', rows)

    for (const { h, expected } of cases) {
      expectClose(
        getLayerDensityCPU(h, expTerm, exponent, linearTerm, constantTerm),
        expected,
        { label: `h=${h}` }
      )
    }
  })

  test('zero profile returns zero everywhere', () => {
    expectClose(getLayerDensityCPU(0, 0, 0, 0, 0), 0, { label: 'h=0' })
    expectClose(getLayerDensityCPU(0.5, 0, 0, 0, 0), 0, { label: 'h=0.5' })
    expectClose(getLayerDensityCPU(1.0, 0, 0, 0, 0), 0, { label: 'h=1' })
  })

  test('WGSL snapshot contains vec4 exp() form', () => {
    const hf = uniform(new Vector4(0.5, 0.5, 0.5, 0.5))
    const expTerms = uniform(new Vector4(0, 0, 0, 0))
    const exponents = uniform(new Vector4(0, 0, 0, 0))
    const linearTerms = uniform(new Vector4(0.75, 0.75, 0.75, 0.75))
    const constantTerms = uniform(new Vector4(0.25, 0.25, 0.25, 0.25))

    const graph = getLayerDensity(
      hf,
      expTerms,
      exponents,
      linearTerms,
      constantTerms
    )
    const result = compileWGSL(graph)

    log('layerDensity:wgsl', { fragment: result.fragment.slice(0, 800) })
    expectWGSL(result.fragment).toContain('exp(')
  })
})
