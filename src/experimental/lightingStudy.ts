// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Controlled lighting fixtures replace only density and incident light
// Cite: clouds.frag:417-447, :480-618

import { Data3DTexture, Vector3 } from 'three'
import {
  clamp,
  exp,
  float,
  Fn,
  Loop,
  max,
  min,
  texture3D,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import { splitIlluminance } from '../lighting/sunSkyLight'
import { createDiffusionSource } from './lightingStudyDiffusion'
import { createStudySky } from './lightingStudySky'

export interface LightingStudy {
  readonly skyCache?: readonly Data3DTexture[]
  readonly phaseWeights?: readonly [Data3DTexture, Data3DTexture]
  readonly cachePhase?: readonly [number, number, number]
  readonly sunModel?: 'octaves' | 'diffusion'
  readonly density: Data3DTexture
  readonly minimum: readonly [number, number, number]
  readonly maximum: readonly [number, number, number]
  readonly sunIrradiance: readonly [number, number, number]
  readonly upperSky: readonly [number, number, number]
  readonly lowerSky: readonly [number, number, number]
  readonly shadowSteps: number
}

export function validateLightingStudy(study: LightingStudy): void {
  if (
    study.sunModel != null &&
    !['octaves', 'diffusion'].includes(study.sunModel)
  )
    throw new TypeError('Invalid study sun model')
  validateSkyCache(study)
  if (!(study.density instanceof Data3DTexture))
    throw new TypeError('Lighting study requires a density volume')
  for (const vector of [
    study.minimum,
    study.maximum,
    study.sunIrradiance,
    study.upperSky,
    study.lowerSky
  ]) {
    if (vector.length !== 3 || !vector.every(Number.isFinite))
      throw new TypeError(
        'Lighting study vectors must have three finite components'
      )
  }
  if (study.maximum.some((value, axis) => value <= study.minimum[axis]!))
    throw new RangeError('Lighting study bounds must have positive extent')
  for (const light of [study.sunIrradiance, study.upperSky, study.lowerSky]) {
    if (light.some(value => value < 0))
      throw new RangeError('Lighting study radiance must be nonnegative')
  }
  if (
    !Number.isInteger(study.shadowSteps) ||
    study.shadowSteps < 1 ||
    study.shadowSteps > 1024
  )
    throw new RangeError('Lighting study shadowSteps must be 1..1024')
}

function validateSkyCache(study: LightingStudy): void {
  if (study.skyCache == null && study.phaseWeights == null) return
  if (
    study.skyCache?.length !== 8 ||
    study.phaseWeights?.length !== 2 ||
    study.cachePhase?.length !== 3
  )
    throw new TypeError(
      'Sky study requires eight volumes, two phase tables and their phase parameters'
    )
  if (study.skyCache.some(texture => !(texture instanceof Data3DTexture)))
    throw new TypeError('Invalid sky cache volume')
}

export function createLightingStudyNodes(
  study: LightingStudy | null,
  scatteringCoefficient: Node<'float'>,
  absorptionCoefficient: Node<'float'>,
  phase: readonly [number, number, number],
  accuratePhase = false
) {
  if (study == null) return null
  if (accuratePhase)
    throw new Error('Lighting study requires the dual HG phase')
  if (
    study.cachePhase != null &&
    phase.some((value, index) => value !== study.cachePhase![index])
  )
    throw new Error('Sky phase tables are stale')
  const extinctionCoefficient = scatteringCoefficient.add(absorptionCoefficient)
  const lo = vec3(new Vector3(...study.minimum))
  const hi = vec3(new Vector3(...study.maximum))
  const size = hi.sub(lo)
  const volume = texture3D(study.density)
  volume.updateMatrix = false
  const density = Fn(([position]: [Node<'vec3'>]) => {
    const uv = position.sub(lo).div(size)
    const inside = uv.x
      .greaterThanEqual(0)
      .and(uv.y.greaterThanEqual(0))
      .and(uv.z.greaterThanEqual(0))
      .and(uv.x.lessThanEqual(1))
      .and(uv.y.lessThanEqual(1))
      .and(uv.z.lessThanEqual(1))
    return inside.select(
      volume.sample(clamp(uv, vec3(0), vec3(1))).level(float(0)).r,
      float(0)
    )
  })
  const opticalDepth = Fn(
    ([position, direction]: [Node<'vec3'>, Node<'vec3'>]) => {
      const safeDirection = vec3(
        direction.x
          .greaterThanEqual(0)
          .select(max(direction.x, 1e-8), min(direction.x, -1e-8)),
        direction.y
          .greaterThanEqual(0)
          .select(max(direction.y, 1e-8), min(direction.y, -1e-8)),
        direction.z
          .greaterThanEqual(0)
          .select(max(direction.z, 1e-8), min(direction.z, -1e-8))
      )
      const exits = max(
        lo.sub(position).div(safeDirection),
        hi.sub(position).div(safeDirection)
      )
      const distance = max(
        float(0),
        min(exits.x, min(exits.y, exits.z))
      ).toVar()
      const step = distance.div(study.shadowSteps).toVar()
      const sum = float(0).toVar()
      Loop(study.shadowSteps, ({ i }) => {
        sum.addAssign(
          density(position.add(direction.mul(float(i).add(0.5).mul(step)))).mul(
            step
          )
        )
      })
      return vec2(sum.mul(extinctionCoefficient), distance)
    }
  )
  const skyRadiance = Fn(([direction]: [Node<'vec3'>]) =>
    direction.y
      .greaterThanEqual(0)
      .select(vec3(...study.upperSky), vec3(...study.lowerSky))
  )
  return {
    density,
    skyLighting: createStudySky(study),
    diffusion:
      study.sunModel === 'diffusion'
        ? createDiffusionSource(
            scatteringCoefficient,
            absorptionCoefficient,
            phase
          )
        : undefined,
    applyAerialPerspective: Fn(
      ([_camera, _front, _shadow, color]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'float'>,
        Node<'vec4'>
      ]) => color
    ),
    sampleWeather: Fn(() => vec4(1, 0, 0, 0)),
    sampleMedia: Fn(
      ([_weather, _height, position]: [
        Node<'vec4'>,
        Node<'vec4'>,
        Node<'vec3'>
      ]) => vec4(density(position), 0, 0, 0)
    ),
    opticalDepth,
    skyRadiance,
    irradiance: Fn(() =>
      splitIlluminance(
        vec3(...study.sunIrradiance),
        vec3(...study.upperSky)
          .add(vec3(...study.lowerSky))
          .mul(2 * Math.PI)
      )
    ),
    transmittance: Fn(([position, direction]: [Node<'vec3'>, Node<'vec3'>]) =>
      exp(opticalDepth(position, direction).x.negate())
    )
  }
}
