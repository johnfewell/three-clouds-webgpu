// CPU twin tests for haze march
// Cite: clouds.frag:654–697, clouds.frag:793–810, clouds.frag:987–995

import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  approximateHazeCPU,
  blendHazeCPU,
  getHazeRayNearFarCPU,
  remapClampedCPU
} from './hazeMarch'

describe('remapClampedCPU', () => {
  setCurrentSpec('hazeMarch')

  test('value below low → 0', () => {
    expect(remapClampedCPU(0.1, 0.2, 0.4)).toBe(0)
  })

  test('value above high → 1', () => {
    expect(remapClampedCPU(0.5, 0.2, 0.4)).toBe(1)
  })

  test('value at midpoint → 0.5', () => {
    expect(remapClampedCPU(0.3, 0.2, 0.4)).toBeCloseTo(0.5)
  })

  test('value at low → 0', () => {
    expect(remapClampedCPU(0.2, 0.2, 0.4)).toBe(0)
  })

  test('value at high → 1', () => {
    expect(remapClampedCPU(0.4, 0.2, 0.4)).toBe(1)
  })
})

describe('approximateHazeCPU', () => {
  setCurrentSpec('hazeMarch')

  const defaults = {
    hazeDensityScale: 3e-5,
    hazeExponent: 1e-3,
    hazeScatteringCoefficient: 0.9,
    hazeAbsorptionCoefficient: 0.5
  }

  test('zero coverage → zero transmittance (early out)', () => {
    // normalDotDir, maxRayDistance, cosTheta, shadowLength, coverage (0 makes
    // the modulation 0), cameraHeight
    const result = approximateHazeCPU(
      0.5,
      10000,
      0.5,
      5000,
      0.0,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(result.transmittance).toBe(0)
    expect(result.opticalDepth).toBe(0)

    log('zero-coverage', result)
  })

  test('coverage below 0.2 → zero (modulation clips to 0)', () => {
    // Coverage 0.15, below the 0.2 threshold
    const result = approximateHazeCPU(
      0.5,
      10000,
      0.5,
      5000,
      0.15,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(result.transmittance).toBe(0)
    log('coverage-below-threshold', result)
  })

  test('high coverage + long ray → nonzero transmittance', () => {
    // High coverage
    const result = approximateHazeCPU(
      0.5,
      50000,
      0.5,
      25000,
      0.8,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(result.transmittance).toBeGreaterThan(0)
    expect(result.transmittance).toBeLessThanOrEqual(1)
    expect(result.opticalDepth).toBeGreaterThan(0)

    log('high-coverage-long-ray', result)
  })

  test('transmittance increases with ray distance', () => {
    const short = approximateHazeCPU(
      0.5,
      5000,
      0.5,
      2500,
      0.6,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )
    const long = approximateHazeCPU(
      0.5,
      50000,
      0.5,
      25000,
      0.6,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(long.transmittance).toBeGreaterThan(short.transmittance)

    log('distance-monotonicity', {
      shortT: short.transmittance,
      longT: long.transmittance
    })
  })

  test('transmittance increases with coverage', () => {
    const low = approximateHazeCPU(
      0.5,
      20000,
      0.5,
      10000,
      0.25,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )
    const high = approximateHazeCPU(
      0.5,
      20000,
      0.5,
      10000,
      0.8,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(high.transmittance).toBeGreaterThan(low.transmittance)

    log('coverage-monotonicity', {
      lowT: low.transmittance,
      highT: high.transmittance
    })
  })

  test('shadow length < ray distance → shadowOpticalDepth > 0', () => {
    const result = approximateHazeCPU(
      0.5,
      30000,
      0.5,
      10000,
      0.6,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(result.shadowOpticalDepth).toBeGreaterThan(0)

    log('shadow-shorter-than-ray', result)
  })

  test('shadow length ≥ ray distance → shadowOpticalDepth = 0', () => {
    const result = approximateHazeCPU(
      0.5,
      10000,
      0.5,
      10000,
      0.6,
      1000,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(result.shadowOpticalDepth).toBe(0)

    log('shadow-equal-ray', result)
  })

  test('very high altitude → density vanishes (early out)', () => {
    // Camera height 1e6: exp(-1e6 * 1e-3) ≈ 0
    const result = approximateHazeCPU(
      0.5,
      20000,
      0.5,
      10000,
      0.8,
      1e6,
      defaults.hazeDensityScale,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(result.transmittance).toBe(0)
    expect(result.opticalDepth).toBe(0)

    log('high-altitude-early-out', result)
  })

  test('density scale → proportional optical depth', () => {
    const base = approximateHazeCPU(
      0.5,
      20000,
      0.5,
      10000,
      0.6,
      1000,
      3e-5,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )
    const doubled = approximateHazeCPU(
      0.5,
      20000,
      0.5,
      10000,
      0.6,
      1000,
      6e-5,
      defaults.hazeExponent,
      defaults.hazeScatteringCoefficient,
      defaults.hazeAbsorptionCoefficient
    )

    expect(doubled.opticalDepth).toBeCloseTo(base.opticalDepth * 2, 5)

    log('density-proportional', {
      baseOD: base.opticalDepth,
      doubledOD: doubled.opticalDepth,
      ratio: doubled.opticalDepth / base.opticalDepth
    })
  })
})

describe('blendHazeCPU', () => {
  setCurrentSpec('hazeMarch')

  test('haze alpha=0 → color unchanged', () => {
    const { rgb, a } = blendHazeCPU([0.5, 0.3, 0.1], 0.8, [1, 1, 1], 0)
    expect(rgb).toEqual([0.5, 0.3, 0.1])
    expect(a).toBe(0.8)

    log('blend-zero-haze', { rgb, a })
  })

  test('haze alpha=1 → haze replaces color', () => {
    const { rgb, a } = blendHazeCPU([0.5, 0.3, 0.1], 0.8, [0.9, 0.8, 0.7], 1)
    expect(rgb[0]).toBeCloseTo(0.9)
    expect(rgb[1]).toBeCloseTo(0.8)
    expect(rgb[2]).toBeCloseTo(0.7)
    expect(a).toBe(1)

    log('blend-full-haze', { rgb, a })
  })

  test('haze alpha=0.5 → midpoint blend', () => {
    const { rgb, a } = blendHazeCPU([0, 0, 0], 0.5, [1, 1, 1], 0.5)
    expect(rgb[0]).toBeCloseTo(0.5)
    expect(rgb[1]).toBeCloseTo(0.5)
    expect(rgb[2]).toBeCloseTo(0.5)
    // 0.5 * 0.5 + 0.5
    expect(a).toBeCloseTo(0.75)

    log('blend-half', { rgb, a })
  })

  test('zero color alpha + haze → haze alpha dominates', () => {
    const { a } = blendHazeCPU([0, 0, 0], 0, [0.5, 0.5, 0.5], 0.3)
    // 0 * 0.7 + 0.3
    expect(a).toBeCloseTo(0.3)

    log('blend-zero-color-alpha', { a })
  })
})

describe('getHazeRayNearFarCPU', () => {
  setCurrentSpec('hazeMarch')

  test('below maxHeight, ground → (cameraNear, first.x)', () => {
    const [near, far] = getHazeRayNearFarCPU(1000, 5000, true, 0.1, 3000, 8000)
    expect(near).toBe(0.1)
    expect(far).toBe(3000)

    log('haze-below-ground', { near, far })
  })

  test('below maxHeight, no ground → (cameraNear, second.z)', () => {
    const [near, far] = getHazeRayNearFarCPU(1000, 5000, false, 0.1, -1, 8000)
    expect(near).toBe(0.1)
    expect(far).toBe(8000)

    log('haze-below-no-ground', { near, far })
  })

  test('above maxHeight, no ground → (cameraNear, second.z)', () => {
    const [near, far] = getHazeRayNearFarCPU(10000, 5000, false, 0.1, -1, 8000)
    expect(near).toBe(0.1)
    expect(far).toBe(8000)

    log('haze-above-no-ground', { near, far })
  })

  test('above maxHeight, ground → (cameraNear, first.x)', () => {
    const [near, far] = getHazeRayNearFarCPU(10000, 5000, true, 0.1, 3000, 8000)
    expect(near).toBe(0.1)
    expect(far).toBe(3000)

    log('haze-above-ground', { near, far })
  })
})
