// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: shadow.frag:37–126 (marchClouds)
// OD tail formula: https://x.com/shotamatsuda/status/1886259549931520437

import {
  Break,
  clamp,
  exp,
  float,
  Fn,
  If,
  length,
  Loop,
  max,
  min,
  nodeObject,
  normalize,
  remapClamp,
  struct,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import { MathNode, type Node } from 'three/webgpu'

import { raySpheresIntersections } from '@takram/three-geospatial/webgpu'

import { getGlobeUv } from '../density/globeUv'
import { computeMediaOutputs } from '../density/sampleShape'
import {
  insideLayerIntervals,
  insideLayerIntervalsCPU
} from '../march/primaryMarch'
import {
  getStructureNormal,
  intersectStructuredPlanes
} from '../march/structuredSampling'

// shadow.frag:183
export const MIP_LEVELS = [0, 0.5, 1, 2] as const

const opticalDepthSampleStruct = /*#__PURE__*/ struct({
  extinctionSum: 'float',
  maxOpticalDepth: 'float',
  transmittanceIntegral: 'float',
  weightedDistanceSum: 'float',
  transmittanceSum: 'float',
  sampleCount: 'float'
})

// shadow.frag:128–145
export const getShadowRayNearFar = /*#__PURE__*/ Fn(
  ([
    sunPosition,
    rayDirection,
    bottomRadius,
    shadowTopHeight,
    shadowBottomHeight
  ]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const radii = bottomRadius.add(
      vec4(shadowTopHeight, shadowBottomHeight, 0, 0)
    )
    const result = raySpheresIntersections(
      sunPosition,
      rayDirection,
      vec3(0),
      radii
    )
    // struct .get() is not generic over the member table (cloudsFragment.ts)
    const first = result.get('near') as Node<'vec4'>
    const rayNear = max(float(0), first.x).toVar()
    const rayFar = first.y.toVar()
    If(rayFar.lessThan(0), () => {
      rayFar.assign(1e6)
    })
    // A TSL Fn must return a node, so (near, far) is packed as vec2
    return vec2(rayNear, rayFar)
  }
)

// shadow.frag:147–180
// Plain node-emitting helper (not a Fn): it returns three separate nodes, and
// a Fn can only return one. Call it from inside a Fn body.
export interface CascadeSetup {
  rayOrigin: Node<'vec3'>
  rayDirection: Node<'vec3'>
  maxRayDistance: Node<'float'>
}

// three r185's MathNode emits built-ins that its method union does not list
// https://www.w3.org/TR/WGSL/#fma-builtin
function fusedMultiplyAdd(a: Node<'vec4'>, b: Node<'vec4'>, c: Node<'vec4'>) {
  return nodeObject(
    new MathNode('fma' as ConstructorParameters<typeof MathNode>[0], a, b, c)
  ) as unknown as Node<'vec4'>
}

export function buildCascadeSetup(
  clipXY: Node<'vec2'>,
  inverseShadowMatrix: Node<'mat4'>,
  worldToECEFMatrix: Node<'mat4'>,
  altitudeCorrection: Node<'vec3'>,
  sunDirection: Node<'vec3'>,
  bottomRadius: Node<'float'>,
  shadowTopHeight: Node<'float'>,
  shadowBottomHeight: Node<'float'>
): CascadeSetup {
  const columns = inverseShadowMatrix as unknown as {
    element(index: number): Node<'vec4'>
  }
  // Accumulate the near-plane offsets before the world translation
  // Fused products avoid metre-scale rounding that changes cloud-edge samples
  const planeX = fusedMultiplyAdd(
    columns.element(0),
    vec4(clipXY.x),
    columns.element(2).negate()
  )
  const point = fusedMultiplyAdd(columns.element(1), vec4(clipXY.y), planeX)
    .add(columns.element(3))
    .toVar()
  point.assign(point.div(point.w))
  const sunPosition = worldToECEFMatrix
    .mul(vec4(point.x, point.y, point.z, 1))
    .xyz.add(altitudeCorrection)

  const rayDirection = normalize(sunDirection.negate())
  const nearFar = getShadowRayNearFar(
    sunPosition,
    rayDirection,
    bottomRadius,
    shadowTopHeight,
    shadowBottomHeight
  ).toVar()
  const rayOrigin = rayDirection.mul(nearFar.x).add(sunPosition)
  // TODO(port): Calculate from the main camera frustum perhaps? (shadow.frag:147–180)
  const maxRayDistance = nearFar.y.sub(nearFar.x)

  return { rayOrigin, rayDirection, maxRayDistance }
}

export interface OpticalDepthMarchDeps {
  sampleWeather: (
    uv: Node<'vec2'>,
    height: Node<'float'>,
    mipLevel: Node<'float'>,
    heightFraction?: Node<'vec4'>
  ) => Node<'vec4'>
  sampleMedia: (
    weatherDensity: Node<'vec4'>,
    weatherHeightFraction: Node<'vec4'>,
    position: Node<'vec3'>,
    uv: Node<'vec2'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec4'>
  bottomRadius: Node<'float'>
  minIntervalHeights: Node<'vec3'>
  maxIntervalHeights: Node<'vec3'>
  minLayerHeights: Node<'vec4'>
  maxLayerHeights: Node<'vec4'>
  maxIterationCount: Node<'float'>
  minStepSize: Node<'float'>
  maxStepSize: Node<'float'>
  minDensity: Node<'float'>
  minExtinction: Node<'float'>
  minTransmittance: Node<'float'>
  opticalDepthTailScale: Node<'float'>
  scatteringCoefficient: Node<'float'>
  absorptionCoefficient: Node<'float'>
  worldToUnit: Node<'float'>
  temporalJitter: boolean
}

export function createOpticalDepthMarch(deps: OpticalDepthMarchDeps) {
  const {
    sampleWeather,
    sampleMedia,
    bottomRadius,
    minIntervalHeights,
    maxIntervalHeights,
    minLayerHeights,
    maxLayerHeights,
    maxIterationCount,
    minStepSize,
    maxStepSize,
    minDensity,
    minExtinction,
    minTransmittance,
    opticalDepthTailScale,
    scatteringCoefficient,
    absorptionCoefficient,
    worldToUnit,
    temporalJitter
  } = deps

  // shadow.frag:86-107, separated so the interval guard below does not push
  // the march Fn over ADR-010's decision budget
  const sampleStep = Fn(
    ([
      position,
      height,
      mipLevel,
      jitter,
      stepSize,
      rayDistance,
      currentTransmittance
    ]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const extinctionSum = float(0).toVar()
      const maxOpticalDepth = float(0).toVar()
      const transmittanceIntegral = currentTransmittance.toVar()
      const weightedDistanceSum = float(0).toVar()
      const transmittanceSum = float(0).toVar()
      const sampleCount = float(0).toVar()

      const uv = getGlobeUv(position)
      // One height fraction for weather and media, as sampleWeather does
      // computed its own before, so this is reuse, not extra work
      const heightFraction = remapClamp(
        vec4(height, height, height, height),
        minLayerHeights,
        maxLayerHeights
      ).toVar()
      const weather = sampleWeather(uv, height, mipLevel, heightFraction)
      const anyDensity = weather.x
        .greaterThan(minDensity)
        .or(weather.y.greaterThan(minDensity))
        .or(weather.z.greaterThan(minDensity))
        .or(weather.w.greaterThan(minDensity))

      If(anyDensity, () => {
        const mediaDensity = sampleMedia(
          weather,
          heightFraction,
          position,
          uv,
          mipLevel,
          jitter
        )
        const media = computeMediaOutputs(
          mediaDensity,
          scatteringCoefficient,
          absorptionCoefficient
        )

        If(media.extinction.greaterThan(minExtinction), () => {
          extinctionSum.assign(media.extinction)
          maxOpticalDepth.assign(media.extinction.mul(stepSize))
          transmittanceIntegral.mulAssign(
            exp(media.extinction.negate().mul(stepSize))
          )
          weightedDistanceSum.assign(rayDistance.mul(transmittanceIntegral))
          transmittanceSum.assign(transmittanceIntegral)
          sampleCount.assign(1)
        })
      })

      return opticalDepthSampleStruct(
        extinctionSum,
        maxOpticalDepth,
        transmittanceIntegral,
        weightedDistanceSum,
        transmittanceSum,
        sampleCount
      )
    }
  )

  return Fn(
    ([rayOrigin, rayDirection, maxRayDistance, jitter, mipLevel]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const normal = getStructureNormal(rayDirection, jitter)
      const samplePeriod = clamp(
        maxRayDistance.div(maxIterationCount),
        minStepSize,
        maxStepSize
      )
      // vec2(stepOffset, stepSize)
      const svs = intersectStructuredPlanes(
        normal,
        rayOrigin,
        rayDirection,
        samplePeriod
      ).toVar()
      const rayDistance = svs.x.toVar()
      const stepSize = svs.y

      if (temporalJitter) {
        rayDistance.subAssign(stepSize.mul(jitter))
      }

      const extinctionSum = float(0).toVar()
      const maxOpticalDepth = float(0).toVar()
      const maxOpticalDepthTail = float(0).toVar()
      const transmittanceIntegral = float(1).toVar()
      const weightedDistanceSum = float(0).toVar()
      const transmittanceSum = float(0).toVar()
      const sampleCount = float(0).toVar()

      Loop({ start: 0, end: maxIterationCount }, () => {
        If(rayDistance.greaterThan(maxRayDistance), () => {
          Break()
        })

        const position = rayDirection.mul(rayDistance).add(rayOrigin)
        const height = length(position).sub(bottomRadius)

        // shadow.frag:80-84: skip the empty gaps between cloud layers before
        // weather and media sampling (DEBUG_MARCH_INTERVALS is not ported)
        If(
          insideLayerIntervals(
            height,
            minIntervalHeights,
            maxIntervalHeights
          ).not(),
          () => {
            const step = sampleStep(
              position,
              height,
              mipLevel,
              jitter,
              stepSize,
              rayDistance,
              transmittanceIntegral
            )
            extinctionSum.addAssign(step.get('extinctionSum') as Node<'float'>)
            maxOpticalDepth.addAssign(
              step.get('maxOpticalDepth') as Node<'float'>
            )
            transmittanceIntegral.assign(step.get('transmittanceIntegral'))
            weightedDistanceSum.addAssign(
              step.get('weightedDistanceSum') as Node<'float'>
            )
            transmittanceSum.addAssign(
              step.get('transmittanceSum') as Node<'float'>
            )
            sampleCount.addAssign(step.get('sampleCount') as Node<'float'>)
          }
        )

        // A skipped gap cannot lower transmittance, so this check remains
        // equivalent to the reference's continue while avoiding deeper flow
        If(transmittanceIntegral.lessThanEqual(minTransmittance), () => {
          maxOpticalDepthTail.assign(
            min(
              float(opticalDepthTailScale)
                .mul(stepSize)
                .mul(exp(float(1).sub(sampleCount))),
              stepSize.mul(0.5)
            )
          )
          Break()
        })

        rayDistance.addAssign(stepSize)
      })

      const noSamples = sampleCount.equal(0)
      // shadow.frag:123 divides by the actual weight. A positive epsilon floor
      // pulls dense, early-terminating samples toward the ray origin
      const weight = transmittanceSum.equal(0).select(1, transmittanceSum)
      const frontDepth = noSamples.select(
        maxRayDistance,
        min(weightedDistanceSum.div(weight), maxRayDistance)
      )
      const meanExtinction = noSamples.select(
        0,
        extinctionSum.div(max(sampleCount, 1))
      )
      const outputMaxOpticalDepth = noSamples.select(0, maxOpticalDepth)
      const outputMaxOpticalDepthTail = noSamples.select(0, maxOpticalDepthTail)

      return vec4(
        frontDepth.mul(worldToUnit),
        meanExtinction,
        outputMaxOpticalDepth,
        outputMaxOpticalDepthTail
      )
    }
  )
}

// CPU twin for testing
export interface OpticalDepthMarchCPUParams {
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  opticalDepthTailScale: number
  worldToUnit: number
  minIntervalHeights?: [number, number, number]
  maxIntervalHeights?: [number, number, number]
  heightAtDistance?: (distance: number) => number
}

export interface OpticalDepthMarchCPUResult {
  frontDepth: number
  meanExtinction: number
  maxOpticalDepth: number
  maxOpticalDepthTail: number
}

export function cpuOpticalDepthMarch(
  maxRayDistance: number,
  stepSize: number,
  extinctionField: (distance: number) => number,
  params: OpticalDepthMarchCPUParams
): OpticalDepthMarchCPUResult {
  const {
    maxIterationCount,
    minExtinction,
    minTransmittance,
    opticalDepthTailScale,
    worldToUnit,
    minIntervalHeights,
    maxIntervalHeights,
    heightAtDistance = distance => distance
  } = params

  let extinctionSum = 0
  let maxOpticalDepth = 0
  let maxOpticalDepthTail = 0
  let transmittanceIntegral = 1
  let weightedDistanceSum = 0
  let transmittanceSum = 0
  let sampleCount = 0
  let rayDistance = 0

  for (let i = 0; i < maxIterationCount; i++) {
    if (rayDistance > maxRayDistance) break

    if (
      minIntervalHeights != null &&
      maxIntervalHeights != null &&
      insideLayerIntervalsCPU(
        heightAtDistance(rayDistance),
        minIntervalHeights,
        maxIntervalHeights
      )
    ) {
      rayDistance += stepSize
      continue
    }

    const extinction = extinctionField(rayDistance)

    if (extinction > minExtinction) {
      extinctionSum += extinction
      maxOpticalDepth += extinction * stepSize
      transmittanceIntegral *= Math.exp(-extinction * stepSize)
      weightedDistanceSum += rayDistance * transmittanceIntegral
      transmittanceSum += transmittanceIntegral
      sampleCount++
    }

    if (transmittanceIntegral <= minTransmittance) {
      maxOpticalDepthTail = Math.min(
        opticalDepthTailScale * stepSize * Math.exp(1 - sampleCount),
        stepSize * 0.5
      )
      break
    }

    rayDistance += stepSize
  }

  if (sampleCount === 0) {
    return {
      frontDepth: maxRayDistance * worldToUnit,
      meanExtinction: 0,
      maxOpticalDepth: 0,
      maxOpticalDepthTail: 0
    }
  }

  const frontDepth =
    Math.min(
      weightedDistanceSum / (transmittanceSum === 0 ? 1 : transmittanceSum),
      maxRayDistance
    ) * worldToUnit
  const meanExtinction = extinctionSum / sampleCount

  return { frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail }
}
