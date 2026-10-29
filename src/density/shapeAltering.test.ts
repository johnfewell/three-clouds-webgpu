// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { vec4 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import { cpuShapeAltering, shapeAlteringFunction } from './shapeAltering'

describe('shapeAlteringFunction', () => {
  it('compiles to WGSL with pow and clamp', () => {
    const node = shapeAlteringFunction(vec4(0.5), vec4(0.35))
    const { fragment } = compileWGSL(node)
    expectWGSL(fragment).toContain('pow')
    expectWGSL(fragment).toContain('clamp')
  })

  it('CPU-twin: h=0 → 0 (bottom of layer)', () => {
    const result = cpuShapeAltering(0, 0.35)
    expectClose(result, 0, { abs: 1e-6, label: 'h=0' })
  })

  it('CPU-twin: h=1 → 0 (top of layer)', () => {
    const result = cpuShapeAltering(1, 0.35)
    expectClose(result, 0, { abs: 1e-6, label: 'h=1' })
  })

  it('CPU-twin: mid-height has peak density', () => {
    const cases = [
      { h: 0.3, bias: 0.35 },
      { h: 0.5, bias: 0.35 },
      { h: 0.7, bias: 0.35 },
      { h: 0.5, bias: 1.0 }
    ]

    const rows = cases.map(c => {
      const result = cpuShapeAltering(c.h, c.bias)
      return {
        h: c.h,
        bias: c.bias,
        expected: 0,
        actual: result
      }
    })
    table('shapeAltering-midHeight', rows)

    for (const c of cases) {
      const result = cpuShapeAltering(c.h, c.bias)
      expect(result, `h=${c.h}, bias=${c.bias}`).toBeGreaterThan(0)
      expect(result, `h=${c.h}, bias=${c.bias}`).toBeLessThanOrEqual(1)
    }
  })

  it('CPU-twin: bias=1 gives symmetric semi-circle', () => {
    const v03 = cpuShapeAltering(0.3, 1.0)
    const v07 = cpuShapeAltering(0.7, 1.0)
    expectClose(v03, v07, { abs: 1e-6, label: 'symmetric about 0.5' })
  })

  it('CPU-twin: bias<1 shifts peak toward bottom of layer', () => {
    const v02 = cpuShapeAltering(0.2, 0.5)
    const v05 = cpuShapeAltering(0.5, 0.5)
    const v08 = cpuShapeAltering(0.8, 0.5)
    expect(v02, 'bias<1 boosts lower heights').toBeGreaterThan(v05)
    expect(v05, 'mid > top').toBeGreaterThan(v08)
  })
})
