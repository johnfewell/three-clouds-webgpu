// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Vector3 } from 'three'
import { uniform } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import {
  cloudsSolarLuminance,
  createCloudsSunSkyIrradiance,
  createCloudsSunSkyIrradianceInterpolated,
  createGroundIndirectIlluminance,
  createGroundSunSkyIrradiance,
  createGroundSunSkyIrradianceInterpolated,
  createIndirectLuminance,
  createIndirectLuminanceToPoint,
  createSunSkyIrradianceCache,
  RECIPROCAL_PI4,
  type SunSkyIrradianceCache
} from './sunSkyLight'

// The LUT length unit and altitude correction now come from the atmosphere
// context at build time (ADR-013); the factories only take the sun direction
function makeAtmosphereInputs() {
  return {
    sunDirectionECEF: uniform(new Vector3(0, 0.5, 0.866))
  }
}

describe('sunSkyLight accessor stubs', () => {
  it('cloudsSolarLuminance is a callable Fn', () => {
    expect(typeof cloudsSolarLuminance).toBe('function')
  })

  it('createCloudsSunSkyIrradiance returns a callable Fn', () => {
    const { sunDirectionECEF } = makeAtmosphereInputs()
    const fn = createCloudsSunSkyIrradiance(sunDirectionECEF)
    expect(typeof fn).toBe('function')
  })

  it('createGroundSunSkyIrradiance returns a callable Fn', () => {
    const { sunDirectionECEF } = makeAtmosphereInputs()
    const fn = createGroundSunSkyIrradiance(sunDirectionECEF)
    expect(typeof fn).toBe('function')
  })

  it('createGroundIndirectIlluminance returns a callable Fn', () => {
    const { sunDirectionECEF } = makeAtmosphereInputs()
    const fn = createGroundIndirectIlluminance(sunDirectionECEF)
    expect(typeof fn).toBe('function')
  })

  it('createIndirectLuminance returns a callable Fn', () => {
    const { sunDirectionECEF } = makeAtmosphereInputs()
    const fn = createIndirectLuminance(sunDirectionECEF)
    expect(typeof fn).toBe('function')
  })

  it('createIndirectLuminanceToPoint returns a callable Fn', () => {
    const { sunDirectionECEF } = makeAtmosphereInputs()
    const fn = createIndirectLuminanceToPoint(sunDirectionECEF)
    expect(typeof fn).toBe('function')
  })

  it('all six accessor stubs are exported', () => {
    expect(cloudsSolarLuminance).toBeDefined()
    expect(createCloudsSunSkyIrradiance).toBeDefined()
    expect(createGroundSunSkyIrradiance).toBeDefined()
    expect(createGroundIndirectIlluminance).toBeDefined()
    expect(createIndirectLuminance).toBeDefined()
    expect(createIndirectLuminanceToPoint).toBeDefined()
  })
})

describe('sunSkyLight interpolated path', () => {
  it('createSunSkyIrradianceCache returns cache with 6 varying nodes', () => {
    const { sunDirectionECEF } = makeAtmosphereInputs()
    const cameraPositionECEF = uniform(new Vector3(0, 0, 6371000))
    const bottomRadius = uniform(6371000)
    const minHeight = uniform(750)
    const maxHeight = uniform(8000)

    const cache = createSunSkyIrradianceCache(
      sunDirectionECEF,
      cameraPositionECEF,
      bottomRadius,
      minHeight,
      maxHeight
    )

    expect(cache.groundSun).toBeDefined()
    expect(cache.groundSky).toBeDefined()
    expect(cache.cloudsMinSun).toBeDefined()
    expect(cache.cloudsMinSky).toBeDefined()
    expect(cache.cloudsMaxSun).toBeDefined()
    expect(cache.cloudsMaxSky).toBeDefined()
  })

  it('createCloudsSunSkyIrradianceInterpolated returns a callable Fn', () => {
    const cache: SunSkyIrradianceCache = {
      groundSun: uniform(new Vector3(1, 1, 1)),
      groundSky: uniform(new Vector3(0.5, 0.5, 0.5)),
      cloudsMinSun: uniform(new Vector3(0.8, 0.8, 0.8)),
      cloudsMinSky: uniform(new Vector3(0.4, 0.4, 0.4)),
      cloudsMaxSun: uniform(new Vector3(0.6, 0.6, 0.6)),
      cloudsMaxSky: uniform(new Vector3(0.3, 0.3, 0.3))
    }
    const minHeight = uniform(750)
    const maxHeight = uniform(8000)
    const fn = createCloudsSunSkyIrradianceInterpolated(
      cache,
      minHeight,
      maxHeight
    )
    expect(typeof fn).toBe('function')
  })

  it('createGroundSunSkyIrradianceInterpolated returns a callable Fn', () => {
    const cache: SunSkyIrradianceCache = {
      groundSun: uniform(new Vector3(1, 1, 1)),
      groundSky: uniform(new Vector3(0.5, 0.5, 0.5)),
      cloudsMinSun: uniform(new Vector3(0.8, 0.8, 0.8)),
      cloudsMinSky: uniform(new Vector3(0.4, 0.4, 0.4)),
      cloudsMaxSun: uniform(new Vector3(0.6, 0.6, 0.6)),
      cloudsMaxSky: uniform(new Vector3(0.3, 0.3, 0.3))
    }
    const fn = createGroundSunSkyIrradianceInterpolated(cache)
    expect(typeof fn).toBe('function')
  })
})

describe('sunSkyLight constants', () => {
  it('RECIPROCAL_PI4 = 1/(4π)', () => {
    expect(RECIPROCAL_PI4).toBeCloseTo(1 / (4 * Math.PI), 10)
  })
})
