// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { describe, expect, it } from 'vitest'

import { log } from '../../test/helpers/log'
import {
  bsmPcfRadiusCPU,
  createSampleCountDelta,
  frontDepthCPU,
  insideLayerIntervalsCPU,
  integrateStepCPU,
  remapClampedCPU,
  sampleCountDeltaCPU,
  type IntegrateStepState
} from './primaryMarch'

async function compileSampleCountDelta(shapeDetail: boolean): Promise<string> {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const { bool, float, Fn } = await import('three/tsl')
  const delta = createSampleCountDelta(shapeDetail)
  return compileWGSL(Fn(() => delta(bool(true), float(0.25), float(0.5)))())
    .fragment
}

// CPU twin: Phase 0 homogeneous fixed-step march
// Cite: clouds.frag:480–618

function remapClamped(value: number, inLow: number, inHigh: number): number {
  return Math.max(0, Math.min(1, (value - inLow) / (inHigh - inLow)))
}

interface MarchResult {
  layer: [number, number, number, number]
  depthVelocity: [number, number, number, number]
}

function cpuPrimaryMarch(
  near: number,
  far: number,
  stbn: number,
  maxIterationCount: number,
  scatteringCoefficient: number,
  absorptionCoefficient: number,
  minTransmittance: number,
  worldToUnit: number
): MarchResult {
  let radianceR = 0
  let radianceG = 0
  let radianceB = 0
  let transmittanceIntegral = 1.0
  let weightedDistanceSum = 0
  let transmittanceSum = 0

  const thickness = far - near
  const stepSize = thickness / maxIterationCount

  // clouds.frag:490
  let rayDistance = stepSize * stbn * 2.0

  // Phase 0 constants
  const extinction = scatteringCoefficient + absorptionCoefficient
  const radiance = scatteringCoefficient

  for (let i = 0; i < maxIterationCount; i++) {
    if (rayDistance > thickness) break

    // Frostbite integral (clouds.frag:593–597)
    const transmittance = Math.exp(-extinction * stepSize)
    const clampedExtinction = Math.max(extinction, 1e-7)
    const scatteringIntegral =
      (radiance - radiance * transmittance) / clampedExtinction

    radianceR += transmittanceIntegral * scatteringIntegral
    radianceG += transmittanceIntegral * scatteringIntegral
    radianceB += transmittanceIntegral * scatteringIntegral
    transmittanceIntegral *= transmittance

    // clouds.frag:601–602
    weightedDistanceSum += (near + rayDistance) * transmittanceIntegral
    transmittanceSum += transmittanceIntegral

    if (transmittanceIntegral <= minTransmittance) break

    rayDistance += stepSize
  }

  // writeLayer encoding
  const frontDepth =
    transmittanceSum > 0 ? weightedDistanceSum / transmittanceSum : -1
  const opacity = remapClamped(transmittanceIntegral, 1.0, minTransmittance)

  return {
    layer: [radianceR, radianceG, radianceB, opacity],
    depthVelocity: [frontDepth * worldToUnit, 0, 0, 0]
  }
}

describe('primaryMarch — CPU twin', () => {
  const NEAR = 7250
  const FAR = 7900
  const STBN = 0.5
  const MAX_ITER = 500
  const SCATTER = 0.9
  const ABSORB = 0.1
  const MIN_T = 0.01
  const W2U = 1.0

  it('produces non-zero radiance for homogeneous medium', () => {
    const result = cpuPrimaryMarch(
      NEAR,
      FAR,
      STBN,
      MAX_ITER,
      SCATTER,
      ABSORB,
      MIN_T,
      W2U
    )

    expect(result.layer[0]).toBeGreaterThan(0)
    expect(result.layer[1]).toBeGreaterThan(0)
    expect(result.layer[2]).toBeGreaterThan(0)
    // RGB channels should be equal (constant luminance)
    expect(result.layer[0]).toBeCloseTo(result.layer[1])
    expect(result.layer[1]).toBeCloseTo(result.layer[2])
  })

  it('reaches full opacity for thick enough medium', () => {
    const result = cpuPrimaryMarch(
      NEAR,
      FAR,
      STBN,
      MAX_ITER,
      SCATTER,
      ABSORB,
      MIN_T,
      W2U
    )

    // Extinction = 1.0, thickness = 650, stepSize ≈ 1.3
    // Per step transmittance ≈ exp(-1.0 * 1.3) ≈ 0.27
    // After many steps, transmittance → 0, opacity → 1
    expect(result.layer[3]).toBeCloseTo(1.0, 1)
  })

  it('returns valid front depth inside [near, far]', () => {
    const result = cpuPrimaryMarch(
      NEAR,
      FAR,
      STBN,
      MAX_ITER,
      SCATTER,
      ABSORB,
      MIN_T,
      W2U
    )

    // Front depth is absolute distance from camera (weighted average)
    expect(result.depthVelocity[0]).toBeGreaterThanOrEqual(NEAR)
    expect(result.depthVelocity[0]).toBeLessThanOrEqual(FAR)
  })

  it('thin medium → low opacity', () => {
    // Very low extinction: scattering=0.001, absorption=0
    const result = cpuPrimaryMarch(
      NEAR,
      FAR,
      STBN,
      MAX_ITER,
      0.001,
      0,
      MIN_T,
      W2U
    )

    expect(result.layer[3]).toBeLessThan(0.5)
    expect(result.layer[3]).toBeGreaterThan(0)
  })

  it('zero-thickness shell → no radiance', () => {
    const result = cpuPrimaryMarch(
      NEAR,
      NEAR,
      STBN,
      MAX_ITER,
      SCATTER,
      ABSORB,
      MIN_T,
      W2U
    )

    expect(result.layer[0]).toBe(0)
    expect(result.layer[3]).toBe(0)
  })

  it('jitter shifts the first sample position', () => {
    // With low extinction and few steps, jitter visibly shifts results
    const a = cpuPrimaryMarch(NEAR, FAR, 0, 10, 0.01, 0, MIN_T, W2U)
    const b = cpuPrimaryMarch(NEAR, FAR, 0.5, 10, 0.01, 0, MIN_T, W2U)

    // Different jitter → different frontDepth
    expect(a.depthVelocity[0]).not.toBeCloseTo(b.depthVelocity[0], 0)
  })

  it('worldToUnit scales depth (AUDIT-4)', () => {
    const w2u = 1e-4
    const result = cpuPrimaryMarch(
      NEAR,
      FAR,
      STBN,
      MAX_ITER,
      SCATTER,
      ABSORB,
      MIN_T,
      w2u
    )

    // Front depth should be near * worldToUnit < 1.0
    expect(result.depthVelocity[0]).toBeLessThan(1.0)
    expect(result.depthVelocity[0]).toBeGreaterThan(0)
  })

  it('energy conservation: radiance converges to scattering/extinction', () => {
    // For infinite thickness with constant density, the integral converges to
    // scattering / extinction (albedo) for each color channel
    const scatter = 0.8
    const absorb = 0.2
    const extinction = scatter + absorb
    const albedo = scatter / extinction

    const result = cpuPrimaryMarch(
      0,
      100000,
      0.5,
      10000,
      scatter,
      absorb,
      1e-6,
      1.0
    )

    expect(result.layer[0]).toBeCloseTo(albedo, 1)
  })
})

describe('insideLayerIntervals — WGSL', () => {
  it('emits three strict interval tests OR-ed together', async () => {
    // insideLayerIntervalsCPU has always been tested, the Fn it twins has not
    // clouds.glsl:57-61 uses STRICT `>`, and `>=` puts a height on a boundary
    // inside two layers
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { float, vec3 } = await import('three/tsl')
    const { insideLayerIntervals } = await import('./primaryMarch')
    const { fragment } = compileWGSL(
      insideLayerIntervals(
        float(1500),
        vec3(1000, 3000, 5000),
        vec3(2000, 4000, 6000)
      )
    )
    // Count in the FUNCTION BODY only, and blank the `vecN<f32>` generics: the
    // three.js banner and struct preamble carry their own angle brackets, each
    // type constructor is one more of each, and `fn main` has its own arrow
    const body = fragment
      .slice(fragment.indexOf('fn main'))
      .replace(/\w+<f32>/g, 'T')
      .replace(/->/g, 'RET')
    log('insideLayerIntervals-wgsl', {
      length: fragment.length,
      greaterThan: (body.match(/>/g) ?? []).length,
      lessThan: (body.match(/</g) ?? []).length,
      ors: (body.match(/\|\|/g) ?? []).length
    })
    expect(fragment.length).toBeGreaterThan(0)
    expect((body.match(/>/g) ?? []).length).toBe(3)
    expect((body.match(/</g) ?? []).length).toBe(3)
    expect((body.match(/\|\|/g) ?? []).length).toBe(2)
    expect(body).not.toMatch(/>=/)
    expect(body).not.toMatch(/<=/)
  })
})

describe('insideLayerIntervalsCPU', () => {
  const minH: [number, number, number] = [1000, 3000, 5000]
  const maxH: [number, number, number] = [2000, 4000, 6000]

  it('returns true for height inside first interval', () => {
    expect(insideLayerIntervalsCPU(1500, minH, maxH)).toBe(true)
  })

  it('returns true for height inside second interval', () => {
    expect(insideLayerIntervalsCPU(3500, minH, maxH)).toBe(true)
  })

  it('returns true for height inside third interval', () => {
    expect(insideLayerIntervalsCPU(5500, minH, maxH)).toBe(true)
  })

  it('returns false for height below all intervals', () => {
    expect(insideLayerIntervalsCPU(500, minH, maxH)).toBe(false)
  })

  it('returns false for height between intervals', () => {
    expect(insideLayerIntervalsCPU(2500, minH, maxH)).toBe(false)
  })

  it('returns false at exact boundaries (strict inequalities)', () => {
    expect(insideLayerIntervalsCPU(1000, minH, maxH)).toBe(false)
    expect(insideLayerIntervalsCPU(2000, minH, maxH)).toBe(false)
  })
})

describe('sample-count debug channels', () => {
  it('tracks weather, shape, and detail as separate counters', () => {
    expect(sampleCountDeltaCPU(false, 0.25, 0.5, true)).toEqual([1, 0, 0])
    expect(sampleCountDeltaCPU(true, 0.25, 0.5, false)).toEqual([1, 1, 0])
    expect(sampleCountDeltaCPU(true, 0.25, 0.5, true)).toEqual([1, 1, 1])
    expect(sampleCountDeltaCPU(true, 2, 0.5, true)).toEqual([1, 1, 0])
  })

  it('WGSL keeps the detail condition only in the shape-detail variant', async () => {
    const [withDetail, withoutDetail] = await Promise.all([
      compileSampleCountDelta(true),
      compileSampleCountDelta(false)
    ])
    expect(withDetail).toContain('vec3')
    expect(withDetail.length).toBeGreaterThan(withoutDetail.length)
  })
})

describe('integrateStepCPU', () => {
  it('accumulates radiance and decays transmittance', () => {
    const state: IntegrateStepState = {
      radianceR: 0,
      radianceG: 0,
      radianceB: 0,
      transmittanceIntegral: 1,
      weightedDistanceSum: 0,
      transmittanceSum: 0
    }

    integrateStepCPU([1, 0.5, 0.25], 2.0, 10, 100, state)

    expect(state.radianceR).toBeGreaterThan(0)
    expect(state.radianceG).toBeGreaterThan(0)
    expect(state.radianceB).toBeGreaterThan(0)
    expect(state.transmittanceIntegral).toBeLessThan(1)
    expect(state.transmittanceIntegral).toBeGreaterThan(0)
    expect(state.weightedDistanceSum).toBeGreaterThan(0)
    expect(state.transmittanceSum).toBeGreaterThan(0)
  })

  it('channels scale proportionally', () => {
    const state: IntegrateStepState = {
      radianceR: 0,
      radianceG: 0,
      radianceB: 0,
      transmittanceIntegral: 1,
      weightedDistanceSum: 0,
      transmittanceSum: 0
    }

    integrateStepCPU([2, 1, 0.5], 1.0, 5, 50, state)

    expect(state.radianceR).toBeCloseTo(state.radianceG * 2)
    expect(state.radianceG).toBeCloseTo(state.radianceB * 2)
  })

  it('zero extinction → no change in transmittance', () => {
    const state: IntegrateStepState = {
      radianceR: 0,
      radianceG: 0,
      radianceB: 0,
      transmittanceIntegral: 1,
      weightedDistanceSum: 0,
      transmittanceSum: 0
    }

    integrateStepCPU([1, 1, 1], 0, 10, 100, state)

    expect(state.transmittanceIntegral).toBeCloseTo(1)
  })
})

describe('frontDepthCPU', () => {
  it('returns weighted average distance', () => {
    const state: IntegrateStepState = {
      radianceR: 0,
      radianceG: 0,
      radianceB: 0,
      transmittanceIntegral: 0.5,
      weightedDistanceSum: 500,
      transmittanceSum: 10
    }

    expect(frontDepthCPU(state)).toBeCloseTo(50)
  })

  it('returns -1 when transmittanceSum is zero', () => {
    const state: IntegrateStepState = {
      radianceR: 0,
      radianceG: 0,
      radianceB: 0,
      transmittanceIntegral: 1,
      weightedDistanceSum: 0,
      transmittanceSum: 0
    }

    expect(frontDepthCPU(state)).toBe(-1)
  })
})

describe('remapClampedCPU', () => {
  it('maps value at low boundary to 0', () => {
    expect(remapClampedCPU(0, 0, 1)).toBe(0)
  })

  it('maps value at high boundary to 1', () => {
    expect(remapClampedCPU(1, 0, 1)).toBe(1)
  })

  it('maps midpoint to 0.5', () => {
    expect(remapClampedCPU(0.5, 0, 1)).toBeCloseTo(0.5)
  })

  it('clamps below range', () => {
    expect(remapClampedCPU(-1, 0, 1)).toBe(0)
  })

  it('clamps above range', () => {
    expect(remapClampedCPU(2, 0, 1)).toBe(1)
  })
})

describe('bsmPcfRadiusCPU (horizon-only PCF)', () => {
  it('returns 0 when sun is above horizon (dot > 0.1)', () => {
    expect(bsmPcfRadiusCPU(0.5, 6)).toBe(0)
    expect(bsmPcfRadiusCPU(1.0, 6)).toBe(0)
  })

  it('returns maxShadowFilterRadius when sun is at horizon (dot = 0)', () => {
    expect(bsmPcfRadiusCPU(0, 6)).toBe(6)
  })

  it('returns maxShadowFilterRadius when sun is below horizon (dot < 0)', () => {
    expect(bsmPcfRadiusCPU(-0.5, 6)).toBe(6)
  })

  it('linearly interpolates between 0.1 and 0', () => {
    expect(bsmPcfRadiusCPU(0.05, 6)).toBeCloseTo(3, 1)
  })
})

describe('BSM hook source verification', () => {
  it('shadows flag gates BSM code (graph-time)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./primaryMarch.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('shadows && sampleShadowOpticalDepth')
    expect(source).toContain('height.lessThan(shadowTopHeight)')
  })

  it('uses sunRayDistance (odResult.rayDistance) as distanceOffset', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./primaryMarch.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('odResult.y')
  })

  it('applies horizon-only PCF via remapClamp(dot, 0.1, 0)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./primaryMarch.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('remapClamp(dot(sunDirection, surfaceNormal)')
    expect(source).toContain('normalize(position)')
  })
})
