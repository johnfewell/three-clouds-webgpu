import { Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { float, Fn, uniform, vec3, vec4 } from 'three/tsl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { CascadedShadowMaps } from './CascadedShadowMaps'
import {
  buildCascadeSetup,
  cpuOpticalDepthMarch,
  createOpticalDepthMarch,
  MIP_LEVELS,
  type OpticalDepthMarchCPUParams
} from './opticalDepthMarch'

const WORLD_TO_UNIT = 1 / 6360000

describe('shadow ray projection precision', () => {
  it('emits fused plane offsets before the translation and perspective divide', () => {
    const matrix = uniform(new Matrix4()).setName('shadowProjection')
    const clip = uniform(new Vector2()).setName('shadowClip')
    const node = Fn(() => {
      const ray = buildCascadeSetup(
        clip,
        matrix,
        uniform(new Matrix4()),
        vec3(0),
        vec3(0, 1, 0),
        float(6360000),
        float(10000),
        float(1000)
      )
      return vec4(ray.rayOrigin, ray.maxRayDistance)
    })()
    const { fragment } = compileWGSL(node)
    const fusedCount = fragment.match(/\bfma\(/g)?.length ?? 0
    log('shadow-ray-fused-projection', {
      fusedCount,
      expected: 2,
      compiled: fragment.length > 0
    })
    expect(fusedCount).toBe(2)
    expect(fragment).not.toMatch(/shadowProjection\s*\*\s*vec4/)
    expect(fragment).toMatch(/fma\(.*shadowProjection\[\s*1u?\s*\]/)
    expect(fragment).toMatch(/fma\(.*shadowProjection\[\s*0u?\s*\]/)
    expect(fragment).toMatch(/\+\s*object\.shadowProjection\[\s*3u?\s*\]/)
    expect(fragment).toMatch(/\/ vec4<f32>\( \w+\.w \)/)
  })
})

const defaultParams: OpticalDepthMarchCPUParams = {
  maxIterationCount: 50,
  minStepSize: 100,
  maxStepSize: 1000,
  minDensity: 1e-5,
  minExtinction: 1e-5,
  minTransmittance: 1e-4,
  opticalDepthTailScale: 2,
  worldToUnit: WORLD_TO_UNIT
}

describe('cpuOpticalDepthMarch', () => {
  beforeEach(() => {
    setCurrentSpec('opticalDepthMarch')
  })

  it('constant extinction field: maxOpticalDepth = σ·L', () => {
    const sigma = 0.0001
    const maxRayDistance = 5000
    const stepSize = 200
    const steps = Math.floor(maxRayDistance / stepSize) + 1
    const expectedOD = sigma * stepSize * steps

    const result = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      () => sigma,
      defaultParams
    )

    table('constant-field', [
      {
        metric: 'maxOpticalDepth',
        expected: expectedOD,
        actual: result.maxOpticalDepth
      },
      {
        metric: 'meanExtinction',
        expected: sigma,
        actual: result.meanExtinction
      },
      {
        metric: 'steps',
        value: steps
      }
    ])

    expectClose(result.maxOpticalDepth, expectedOD, {
      label: 'maxOD=σ·stepSize·steps',
      abs: 1e-4
    })
    expectClose(result.meanExtinction, sigma, {
      label: 'meanExtinction=σ',
      abs: 1e-6
    })
    expect(result.maxOpticalDepthTail).toBe(0)
  })

  it('no-sample texel returns (maxRayDistance × worldToUnit, 0, 0, 0)', () => {
    const maxRayDistance = 1e6
    const stepSize = 500

    const result = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      () => 0,
      defaultParams
    )

    const expectedFrontDepth = maxRayDistance * WORLD_TO_UNIT

    log('no-sample', {
      frontDepth: result.frontDepth,
      expected: expectedFrontDepth
    })

    expectClose(result.frontDepth, expectedFrontDepth, {
      label: 'frontDepth=maxRayDistance×worldToUnit',
      abs: 1e-4
    })
    expect(result.meanExtinction).toBe(0)
    expect(result.maxOpticalDepth).toBe(0)
    expect(result.maxOpticalDepthTail).toBe(0)
  })

  it('preserves front depth when the first dense sample transmits less than 1e-7', () => {
    const distance = 15000
    const result = cpuOpticalDepthMarch(
      20000,
      400,
      d => (d >= distance ? 0.05 : 0),
      defaultParams
    )
    const firstSample = 15200
    log('dense front depth', {
      transmittance: Math.exp(-20),
      expected: firstSample,
      actual: result.frontDepth / WORLD_TO_UNIT
    })
    expectClose(result.frontDepth / WORLD_TO_UNIT, firstSample, {
      label: 'dense-front-depth',
      abs: 1e-6
    })
  })

  it('keeps the zero-weight fallback finite after complete extinction', () => {
    const result = cpuOpticalDepthMarch(
      20000,
      400,
      d => (d >= 15000 ? 10 : 0),
      defaultParams
    )
    log('zero transmittance weight', { frontDepth: result.frontDepth })
    expect(result.frontDepth).toBe(0)
  })

  it('forced termination with no samples clears both optical-depth channels', () => {
    const result = cpuOpticalDepthMarch(1000, 100, () => 0, {
      ...defaultParams,
      minTransmittance: 1
    })

    table('forced no-sample termination', [
      { channel: 'maxOpticalDepth', value: result.maxOpticalDepth },
      { channel: 'maxOpticalDepthTail', value: result.maxOpticalDepthTail }
    ])

    expect(result.maxOpticalDepth).toBe(0)
    expect(result.maxOpticalDepthTail).toBe(0)
  })

  it('frontDepth is finite for 1e6m miss (AUDIT-4 HalfFloat safety)', () => {
    const maxRayDistance = 1e6

    const result = cpuOpticalDepthMarch(
      maxRayDistance,
      1000,
      () => 0,
      defaultParams
    )

    expect(Number.isFinite(result.frontDepth)).toBe(true)
    const halfFloatMax = 65504
    expect(result.frontDepth).toBeLessThan(halfFloatMax)

    log('halfFloat-safety', {
      frontDepth: result.frontDepth,
      halfFloatMax,
      safe: result.frontDepth < halfFloatMax
    })
  })

  it('tail formula fires at early termination', () => {
    const sigma = 0.1
    const stepSize = 200
    const maxRayDistance = 50000

    const result = cpuOpticalDepthMarch(maxRayDistance, stepSize, () => sigma, {
      ...defaultParams,
      minTransmittance: 1e-2
    })

    expect(result.maxOpticalDepthTail).toBeGreaterThan(0)
    expect(result.maxOpticalDepthTail).toBeLessThanOrEqual(stepSize * 0.5)

    table('tail-formula', [
      { metric: 'maxOpticalDepthTail', value: result.maxOpticalDepthTail },
      { metric: 'maxOpticalDepth', value: result.maxOpticalDepth },
      { metric: 'tailCap', value: stepSize * 0.5 },
      { metric: 'meanExtinction', value: result.meanExtinction }
    ])
  })

  it('tail formula: min(scale·stepSize·exp(1−N), stepSize·0.5)', () => {
    const sigma = 0.05
    const stepSize = 300
    const maxRayDistance = 100000

    const result = cpuOpticalDepthMarch(maxRayDistance, stepSize, () => sigma, {
      ...defaultParams,
      minTransmittance: 1e-2,
      opticalDepthTailScale: 2
    })

    if (result.maxOpticalDepthTail > 0) {
      let transmittance = 1
      let sampleCount = 0
      for (let d = 0; d < maxRayDistance; d += stepSize) {
        if (sigma > defaultParams.minExtinction) {
          transmittance *= Math.exp(-sigma * stepSize)
          sampleCount++
        }
        if (transmittance <= 1e-2) break
      }

      const expectedTail = Math.min(
        2 * stepSize * Math.exp(1 - sampleCount),
        stepSize * 0.5
      )

      expectClose(result.maxOpticalDepthTail, expectedTail, {
        label: 'tail-exact',
        abs: 1e-6
      })
    }
  })

  it('frontDepth stored in UNIT space (worldToUnit multiplied)', () => {
    const sigma = 0.02
    const stepSize = 100
    const maxRayDistance = 10000

    const resultUnit = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      () => sigma,
      defaultParams
    )

    const resultMetric = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      () => sigma,
      { ...defaultParams, worldToUnit: 1 }
    )

    expectClose(
      resultUnit.frontDepth,
      resultMetric.frontDepth * WORLD_TO_UNIT,
      {
        label: 'frontDepth-unit-space',
        rel: 1e-6
      }
    )
  })

  it('step-function field: extinction only in slab', () => {
    const sigma = 0.0005
    const slabStart = 2000
    const slabEnd = 4000
    const stepSize = 200
    const maxRayDistance = 10000

    const field = (d: number) => (d >= slabStart && d < slabEnd ? sigma : 0)

    const result = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      field,
      defaultParams
    )

    const slabSteps = Math.floor((slabEnd - slabStart) / stepSize)
    const expectedOD = sigma * stepSize * slabSteps

    table('slab-field', [
      {
        metric: 'maxOpticalDepth',
        expected: expectedOD,
        actual: result.maxOpticalDepth
      },
      {
        metric: 'meanExtinction',
        expected: sigma,
        actual: result.meanExtinction
      },
      { metric: 'slabSteps', value: slabSteps }
    ])

    expectClose(result.maxOpticalDepth, expectedOD, {
      label: 'slab-OD',
      abs: sigma * stepSize
    })
    expectClose(result.meanExtinction, sigma, {
      label: 'slab-meanExtinction',
      abs: 1e-4
    })
  })

  it('layer-gap skip preserves output while avoiding empty field samples', () => {
    const sigma = 0.0005
    const maxRayDistance = 1000
    const stepSize = 100
    let allSamples = 0
    let skippedSamples = 0

    const withoutSkip = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      distance => {
        allSamples++
        return distance > 200 && distance < 800 ? 0 : sigma
      },
      defaultParams
    )
    const withSkip = cpuOpticalDepthMarch(
      maxRayDistance,
      stepSize,
      distance => {
        skippedSamples++
        return distance > 200 && distance < 800 ? 0 : sigma
      },
      {
        ...defaultParams,
        minIntervalHeights: [200, 0, 0],
        maxIntervalHeights: [800, 0, 0]
      }
    )

    table('layer-gap skip', [
      {
        variant: 'all samples',
        fieldCalls: allSamples,
        maxOpticalDepth: withoutSkip.maxOpticalDepth
      },
      {
        variant: 'skip gap',
        fieldCalls: skippedSamples,
        maxOpticalDepth: withSkip.maxOpticalDepth
      }
    ])

    expect(withSkip).toEqual(withoutSkip)
    expect(skippedSamples).toBeLessThan(allSamples)
    expect(allSamples - skippedSamples).toBe(5)
  })
})

describe('source verification', () => {
  it('imports SVS functions (getStructureNormal, intersectStructuredPlanes)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./opticalDepthMarch.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('getStructureNormal')
    expect(source).toContain('intersectStructuredPlanes')
  })

  it('uses shadowLayerMask via createSampleWeather shadow variant', async () => {
    const weatherSource = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('../density/sampleWeather.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(weatherSource).toContain('shadowLayerMask')
    expect(weatherSource).toContain('shadow')
  })

  it('guards shadow weather/media sampling with the shared layer-gap predicate', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./opticalDepthMarch.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('insideLayerIntervals(')
    expect(source).toContain('minIntervalHeights')
    expect(source).toContain('maxIntervalHeights')
  })

  it('zeros both optical-depth outputs when no samples were accumulated', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./opticalDepthMarch.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toMatch(
      /const outputMaxOpticalDepth = noSamples\.select\(\s*0,\s*maxOpticalDepth\s*\)/
    )
    expect(source).toMatch(
      /const outputMaxOpticalDepthTail = noSamples\.select\(\s*0,\s*maxOpticalDepthTail\s*\)/
    )
  })

  it('compiles the guarded shadow march to WGSL', () => {
    const march = createOpticalDepthMarch({
      sampleWeather: () => vec4(1, 0, 0, 0),
      sampleMedia: () => vec4(0.001, 0, 0, 0),
      bottomRadius: float(6360000),
      minIntervalHeights: vec3(1000, 3000, 5000),
      maxIntervalHeights: vec3(2000, 4000, 6000),
      minLayerHeights: vec4(0, 2500, 4500, 0),
      maxLayerHeights: vec4(1000, 3000, 5000, 0),
      maxIterationCount: float(8),
      minStepSize: float(100),
      maxStepSize: float(1000),
      minDensity: float(1e-5),
      minExtinction: float(1e-5),
      minTransmittance: float(1e-4),
      opticalDepthTailScale: float(2),
      scatteringCoefficient: float(0.9),
      absorptionCoefficient: float(0.5),
      worldToUnit: float(WORLD_TO_UNIT),
      temporalJitter: false
    })
    const { fragment } = compileWGSL(
      march(
        vec3(0, 6360500, 0),
        vec3(1, 0, 0),
        float(1000),
        float(0.5),
        float(0)
      )
    )

    expect(fragment).toContain('for (')
    expect(fragment).toContain('if')
    expect(fragment).toContain('StructType')
    expect(fragment).not.toMatch(/\/ max\( [^,]+, (?:0\.0000001|1e-7) \)/)
    log('guarded WGSL', { length: fragment.length, compiled: true })
  })
})

describe('MIP_LEVELS', () => {
  it('has 4 levels matching shadow.frag:183', () => {
    expect(MIP_LEVELS).toEqual([0, 0.5, 1, 2])
    expect(MIP_LEVELS).toHaveLength(4)
  })
})

describe('CascadedShadowMaps construction', () => {
  beforeEach(() => {
    setCurrentSpec('opticalDepthMarch')
  })

  it('constructs with splitLambda 0.6 (AUDIT-5)', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 3,
      mapSize: new Vector2(512, 512),
      splitLambda: 0.6
    })
    expect(csm.splitLambda).toBe(0.6)
    expect(csm.cascadeCount).toBe(3)

    log('csm-construction', {
      splitLambda: csm.splitLambda,
      cascadeCount: csm.cascadeCount
    })
  })

  it('layer count equals cascadeCount', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 3,
      mapSize: new Vector2(512, 512)
    })
    expect(csm.cascades).toHaveLength(3)

    csm.cascadeCount = 4
    expect(csm.cascades).toHaveLength(4)

    table('cascade-layers', [
      { cascadeCount: 3, expected: 3, actual: 3 },
      { cascadeCount: 4, expected: 4, actual: csm.cascades.length }
    ])
  })
})

describe('updateShadowMaps', () => {
  beforeEach(() => {
    setCurrentSpec('opticalDepthMarch')
  })

  it('calls CascadedShadowMaps.update with fudge distance', () => {
    const ctx = new CloudsContext()
    ctx.sunDirection.set(0, 1, 0)
    ctx.shadowMaps = new CascadedShadowMaps({
      cascadeCount: 3,
      mapSize: new Vector2(512, 512),
      splitLambda: 0.6
    })

    const updateSpy = vi.spyOn(ctx.shadowMaps, 'update')

    const camera = new PerspectiveCamera(75, 1, 0.1, 1000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)

    ctx.updateCamera(camera)
    ctx.updateShadowMaps(camera)

    expect(updateSpy).toHaveBeenCalledOnce()

    const [passedCamera, passedSunDir, passedDistance] =
      updateSpy.mock.calls[0]!
    expect(passedCamera).toBe(camera)
    expect(passedSunDir).toBeInstanceOf(Vector3)
    expect(typeof passedDistance).toBe('number')
    expect(passedDistance).toBeGreaterThan(0)

    table('updateShadowMaps', [
      { param: 'sunDir.length', value: passedSunDir.length() },
      { param: 'distance', value: passedDistance }
    ])
  })

  it('does nothing when shadowMaps is null', () => {
    const ctx = new CloudsContext()
    const camera = new PerspectiveCamera(75, 1, 0.1, 1000)
    camera.updateMatrixWorld(true)
    ctx.updateCamera(camera)
    expect(() => ctx.updateShadowMaps(camera)).not.toThrow()
  })
})
