import { Data3DTexture, HalfFloatType, LinearFilter, RedFormat } from 'three'
import { float, Fn, vec3, vec4 } from 'three/tsl'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { phaseFunction } from '../lighting/phaseFunction'
import { applyReferenceMode } from '../referenceMode'
import { createLightingStudyNodes, type LightingStudy } from './lightingStudy'
import {
  createDiffusionSource,
  diffusionSource
} from './lightingStudyDiffusion'

const phase = [0.7, -0.2, 0.5] as const
function fixture(): LightingStudy {
  const density = new Data3DTexture(new Uint16Array(8).fill(0x3800), 2, 2, 2)
  density.type = HalfFloatType
  density.format = RedFormat
  density.minFilter = density.magFilter = LinearFilter
  return {
    density,
    minimum: [0, 0, 0],
    maximum: [100, 100, 100],
    sunIrradiance: [1, 1, 1],
    upperSky: [1, 0.5, 0.25],
    lowerSky: [0, 0, 0],
    shadowSteps: 16
  }
}

test('study assignment rebuilds once, reference mode disables it, and textures remain borrowed', () => {
  const ctx = new CloudsContext()
  const study = fixture()
  let disposed = 0
  study.density.addEventListener('dispose', () => disposed++)
  const before = ctx.graphVersion
  ctx.lightingStudy = study
  expect(ctx.graphVersion).toBe(before + 1)
  ctx.lightingStudy = study
  expect(ctx.graphVersion).toBe(before + 1)
  applyReferenceMode(ctx)
  expect(ctx.lightingStudy).toBeNull()
  expect(disposed).toBe(0)
  ctx.dispose()
  expect(disposed).toBe(0)
  study.density.dispose()
  expect(disposed).toBe(1)
  log('study-ownership', { disposed, expected: 1 })
})

test('density and full sun path compile with explicit filtered LOD', () => {
  const study = fixture()
  expect(() =>
    createLightingStudyNodes(study, float(1), float(0), phase, true)
  ).toThrow('dual HG')
  const nodes = createLightingStudyNodes(study, float(1), float(0), phase)!
  const shader = compileWGSL(
    vec4(nodes.opticalDepth(vec3(50), vec3(0, 1, 0)), 0, 1)
  ).fragment
  expect(shader).toContain('textureSampleLevel')
  expect(shader).not.toMatch(/textureSample\(/)
  expect(shader).toContain('16')
  study.density.dispose()
})

test('diffusion keeps the direct source and its vacuum and absorption limits', () => {
  for (const cosine of [-1, 0, 1]) {
    expect(diffusionSource(0, cosine, 1, 0, phase)).toBeCloseTo(
      phaseFunction(cosine, 1, ...phase),
      12
    )
    for (const depth of [0.001, 1, 10, 100]) {
      const direct = Math.exp(-depth) * phaseFunction(cosine, 1, ...phase)
      expect(
        diffusionSource(depth, cosine, 1, 0, phase)
      ).toBeGreaterThanOrEqual(direct)
      expect(diffusionSource(depth, cosine, 0, 1, phase)).toBeCloseTo(
        direct,
        12
      )
    }
  }
  expect(() => diffusionSource(-1, 0, 1, 0, phase)).toThrow()
  expect(() => diffusionSource(1, 0, NaN, 0, phase)).toThrow()
  const shader = compileWGSL(
    vec4(
      vec3(
        createDiffusionSource(float(1), float(0), phase)(float(2), float(0.5))
      ),
      1
    )
  ).fragment
  expect(shader).toContain('exp(')
  expect(shader).toContain('0.75')
  log('diffusion-vacuum', {
    actual: diffusionSource(0, 0, 1, 0, phase),
    expected: phaseFunction(0, 1, ...phase)
  })
})

test('sky study rejects incomplete or stale angular tables', () => {
  const ctx = new CloudsContext()
  const study = fixture()
  expect(() => {
    ctx.lightingStudy = { ...study, skyCache: [] }
  }).toThrow('eight volumes')
  const valid = {
    ...study,
    skyCache: Array(8).fill(study.density) as Data3DTexture[],
    phaseWeights: [study.density, study.density] as const,
    cachePhase: phase
  }
  ctx.lightingStudy = valid
  expect(() =>
    createLightingStudyNodes(valid, float(1), float(0), [0.6, -0.2, 0.5])
  ).toThrow('stale')
  const nodes = createLightingStudyNodes(valid, float(1), float(0), phase)!
  const fragment = Fn(() => {
    nodes.skyLighting.prepareSkylight!(vec3(0, 0, -1))
    return vec4(nodes.skyLighting.skySource!(vec3(50), vec3(0)), 1)
  })()
  const shader = compileWGSL(fragment).fragment
  expect(shader).toContain('textureSampleLevel')
  expect(shader).not.toMatch(/textureSample\(/)
  study.density.dispose()
  ctx.dispose()
})
