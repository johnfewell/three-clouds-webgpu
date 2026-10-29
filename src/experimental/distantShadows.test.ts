import { float, Fn, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import {
  combineDistantShadow,
  combineDistantShadowCPU,
  sunMarchIterationCount
} from './distantShadows'

describe('experimental distant shadows', () => {
  it('replaces the whole segment once and preserves uncovered fallback', () => {
    for (const [replacement, expected] of [
      [0, 0],
      [2, 2],
      [-1, 2.5]
    ]) {
      const result = combineDistantShadowCPU(0.5, 2, replacement!)
      expect(result).toBe(expected)
      log('distant shadow', { replacement, expected, result })
    }
  })
  it('compiles the coverage selection and actual sun-iteration condition', () => {
    const shader = compileWGSL(
      Fn(() =>
        vec3(
          combineDistantShadow(float(0.5), float(2), float(-1)),
          sunMarchIterationCount(float(2), float(2), float(0.5)).toFloat(),
          float(0)
        )
      )()
    ).fragment
    expect(shader).toContain('>= 0.0')
    expect(shader).toContain('else')
    expect(shader).toContain('i32')
    log('distant shadow WGSL', { bytes: shader.length })
  })
})
