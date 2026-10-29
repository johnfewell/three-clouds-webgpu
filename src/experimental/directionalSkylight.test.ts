import { float, Fn, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import {
  directionalSkyFactor,
  directionalSkyFactorCPU
} from './directionalSkylight'

describe('experimental directional skylight', () => {
  it('preserves uniform and black skies in every direction', () => {
    for (const luminance of [0, 0.1, 100]) {
      for (const mu of [-1, -0.5, 0, 0.5, 1]) {
        expect(
          directionalSkyFactorCPU(luminance, luminance, mu, -mu)
        ).toBeCloseTo(1, 10)
      }
    }
    log('isotropic sky', {
      expected: 1,
      black: directionalSkyFactorCPU(0, 0, 1, -1)
    })
  })
  it('responds to the bright horizon and stays bounded', () => {
    const toward = directionalSkyFactorCPU(10, 1, 1, -1)
    const away = directionalSkyFactorCPU(10, 1, -1, 1)
    expect(toward).toBeGreaterThan(1)
    expect(away).toBeLessThan(1)
    expect(toward).toBeLessThanOrEqual(4)
    expect(away).toBeGreaterThanOrEqual(0.25)
    log('directional sky', { toward, away })
  })
  it('compiles the normalized angular kernel', () => {
    const shader = compileWGSL(
      Fn(() =>
        directionalSkyFactor(vec3(10), vec3(1), float(0.5), float(-0.5))
      )()
    ).fragment
    expect(shader).toContain('clamp')
    expect(shader).toContain('0.6')
    log('directional sky WGSL', { bytes: shader.length })
  })
})
