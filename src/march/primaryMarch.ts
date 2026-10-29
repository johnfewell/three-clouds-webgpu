// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:480–618 (marchClouds)

import {
  bool,
  Break,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  log2,
  Loop,
  max,
  min,
  mix,
  normalize,
  remapClamp,
  struct,
  vec3,
  vec4
} from 'three/tsl'
import type { Node, StructNode } from 'three/webgpu'

import { getGlobeUv } from '../density/globeUv'
import { computeMediaOutputs } from '../density/sampleShape'
import type { CloudShapeDeps } from '../experimental/cloudShape'
import { createDistantShadowAdjustment } from '../experimental/distantShadows'
import { powderTerm } from '../lighting/powder'
import { RECIPROCAL_PI4 } from '../lighting/sunSkyLight'
import { createFrontTracker, createRefineCloudFront } from './frontRefinement'
import { writeLayer } from './writeLayer'

export interface MarchCloudsDeps {
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
  getCloudsSunSkyIrradiance: (
    position: Node<'vec3'>,
    height: Node<'float'>
  ) => StructNode
  marchOpticalDepth: (
    rayOrigin: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    maxIterationCount: Node<'float'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec2'>
  approxMultiScatter: (
    opticalDepth: Node<'float'>,
    cosTheta: Node<'float'>
  ) => Node<'float'>
  // Hoists the multi-scatter phase terms out of the march loop: called once
  // per fragment with the ray's cosTheta before the loop (see multiScatter.ts)
  prepareMultiScatter?: (cosTheta: Node<'float'>) => void
  bottomRadius: Node<'float'>
  sunDirection: Node<'vec3'>
  minHeight: Node<'float'>
  maxHeight: Node<'float'>
  minIntervalHeights: Node<'vec3'>
  maxIntervalHeights: Node<'vec3'>
  minLayerHeights: Node<'vec4'>
  maxLayerHeights: Node<'vec4'>
  maxIterationCount: Node<'float'>
  maxIterationCountToSun: Node<'float'>
  minStepSize: Node<'float'>
  maxStepSize: Node<'float'>
  perspectiveStepScale: Node<'float'>
  minDensity: Node<'float'>
  minExtinction: Node<'float'>
  minTransmittance: Node<'float'>
  skyLightScale: Node<'float'>
  scatteringCoefficient: Node<'float'>
  absorptionCoefficient: Node<'float'>
  powderScale: Node<'float'>
  powderExponent: Node<'float'>
  worldToUnit: Node<'float'>

  shadows?: boolean
  sampleShadowOpticalDepth?: (
    position: Node<'vec3'>,
    sunRayDistance: Node<'float'>,
    filterRadius: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'float'>
  shadowTopHeight: Node<'float'>
  maxShadowFilterRadius: Node<'float'>
  groundBounce?: boolean
  approximateRadianceFromGround?: (
    position: Node<'vec3'>,
    surfaceNormal: Node<'vec3'>,
    height: Node<'float'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec3'>
  groundBounceScale?: Node<'float'>
  disableIntervalSkip?: boolean
  trackSampleCount?: boolean
  shapeDetail?: boolean
  cloudFrontRefinement?: boolean
  sampleDistantShadow?: MarchCloudsDeps['sampleShadowOpticalDepth']
  prepareSkylight?: (direction: Node<'vec3'>) => void
  skyLightModulation?: () => Node<'vec3'>
  // The four opt-in shape controls. Null seams throughout, so an untouched
  // context emits none of the maths (docs/EXPERIMENTAL.md, cloud shape)
  cloudShape?: CloudShapeDeps
  // Absent unless experimental.lightning is on, so the term below costs no node
  lightningInScatter?: (
    position: Node<'vec3'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec3'>
  // Phase 4: DEBUG_SHOW_CASCADES. Present only when
  // the debug view is on, so the branch below costs nothing otherwise
  getDebugCascadeColor?: (
    position: Node<'vec3'>,
    jitter: Node<'float'>
  ) => Node<'vec3'>
}

// clouds.glsl:57–61
export const insideLayerIntervals = /*#__PURE__*/ Fn(
  ([height, minIntervalH, maxIntervalH]: [
    Node<'float'>,
    Node<'vec3'>,
    Node<'vec3'>
  ]) => {
    const inGap0 = height
      .greaterThan(minIntervalH.x)
      .and(height.lessThan(maxIntervalH.x))
    const inGap1 = height
      .greaterThan(minIntervalH.y)
      .and(height.lessThan(maxIntervalH.y))
    const inGap2 = height
      .greaterThan(minIntervalH.z)
      .and(height.lessThan(maxIntervalH.z))
    return inGap0.or(inGap1).or(inGap2)
  }
)

// Energy-conserving analytical integration of scattered light
// See 5.6.3 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf

// A plain helper, not a Fn: it only mutates the accumulators, and TSL drops an
// unused Fn call
function integrateStep(
  radiance: Node<'vec3'>,
  extinction: Node<'float'>,
  stepSize: Node<'float'>,
  rayDistance: Node<'float'>,
  radianceIntegral: Node<'vec3'>,
  transmittanceIntegral: Node<'float'>,
  weightedDistanceSum: Node<'float'>,
  transmittanceSum: Node<'float'>
): void {
  const transmittance = exp(extinction.negate().mul(stepSize))
  const clampedExtinction = max(extinction, 1e-7)
  const scatteringIntegral = radiance
    .sub(radiance.mul(transmittance))
    .div(clampedExtinction)
  radianceIntegral.addAssign(transmittanceIntegral.mul(scatteringIntegral))
  transmittanceIntegral.mulAssign(transmittance)

  // Aerial perspective affecting clouds
  // See 5.9.1 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
  weightedDistanceSum.addAssign(rayDistance.mul(transmittanceIntegral))
  transmittanceSum.addAssign(transmittanceIntegral)
}

// A plain function, not a Fn, and it picks no-op over multiply out here. TSL
// does not fold a multiply by one away, so an identity seam would add a
// `* 1.0` to the default graph and move the digest main pinned
function createBaseShadowApplier(
  cloudShape: MarchCloudsDeps['cloudShape']
): (
  radiance: Node<'vec3'>,
  weatherHeightFraction: Node<'vec4'>,
  mediaWeight: Node<'vec4'>
) => void {
  if (cloudShape?.baseShadow == null) return () => {}
  const baseShadow = cloudShape.baseShadow
  return (radiance, weatherHeightFraction, mediaWeight) => {
    radiance.mulAssign(baseShadow(dot(weatherHeightFraction, mediaWeight)))
  }
}

function createShadeSample(deps: MarchCloudsDeps) {
  const adjustDistantShadow = createDistantShadowAdjustment(
    deps.sampleDistantShadow
  )
  const skyLightModulation = deps.skyLightModulation ?? (() => float(1))
  // Same seam shape as above: a graph-time literal folded away when the option
  // is off, so the default graph emits no multiply at all
  const baseShadowApplier = createBaseShadowApplier(deps.cloudShape)
  const {
    getCloudsSunSkyIrradiance,
    marchOpticalDepth,
    approxMultiScatter,
    sunDirection,
    maxIterationCountToSun,
    skyLightScale,
    powderScale,
    powderExponent,
    shadows,
    sampleShadowOpticalDepth,
    shadowTopHeight,
    maxShadowFilterRadius,
    getDebugCascadeColor
  } = deps

  // clouds.frag:530–583
  return Fn(
    ([
      position,
      height,
      cosTheta,
      mipLevel,
      jitter,
      weatherHeightFraction,
      mediaWeight,
      mediaScattering,
      mediaExtinction
    ]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'vec4'>,
      Node<'vec4'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const irradiance = getCloudsSunSkyIrradiance(position, height)
      const sunIrradiance = irradiance.get('direct') as Node<'vec3'>
      const skyIrradiance = irradiance.get('indirect') as Node<'vec3'>

      // March optical depth to the sun for finer details, which BSM lacks
      // TODO(port): Remove it. Fudge factor 0.5 when iterationCount==0 (clouds.frag:359)
      const odResult = marchOpticalDepth(
        position,
        sunDirection,
        maxIterationCountToSun,
        mipLevel,
        jitter
      )
      // marchOpticalDepth returns vec2(opticalDepth, rayDistance)
      const opticalDepth = odResult.x.toVar()

      // clouds.frag:545–556, BSM coarse shadow from higher layers
      if (shadows && sampleShadowOpticalDepth) {
        If(height.lessThan(shadowTopHeight), () => {
          const surfaceNormal = normalize(position)
          const radius = float(maxShadowFilterRadius).mul(
            remapClamp(dot(sunDirection, surfaceNormal), float(0.1), float(0))
          )
          opticalDepth.addAssign(
            sampleShadowOpticalDepth(position, odResult.y, radius, jitter)
          )
        })
      }

      opticalDepth.assign(
        adjustDistantShadow(
          opticalDepth,
          position,
          maxIterationCountToSun,
          mipLevel,
          jitter
        )
      )

      const radiance = sunIrradiance
        .mul(approxMultiScatter(opticalDepth, cosTheta))
        .toVar()

      // Beer extinction by the cloud overhead, so a base reads darker than its
      // top. The sun march above reaches the same attenuation but with a
      // truncated step budget, which is what leaves a thick base flat
      baseShadowApplier(radiance, weatherHeightFraction, mediaWeight)

      // Cite: clouds.frag:560–571, GROUND_BOUNCE
      if (deps.groundBounce && deps.approximateRadianceFromGround != null) {
        // Hoisted: narrowing on a mutable property is lost inside the If()
        // callback, and CloudsPassNode sets both together with groundBounce
        const approximateRadianceFromGround = deps.approximateRadianceFromGround
        // Non-null exactly when deps.groundBounce is true, which this branch
        // tests (CloudsPassNode sets both from ctx.groundBounce)
        const groundBounceScale = deps.groundBounceScale!
        const surfaceNormal = normalize(position)
        If(height.lessThan(shadowTopHeight).and(mipLevel.lessThan(0.5)), () => {
          const groundRadiance = approximateRadianceFromGround(
            position,
            surfaceNormal,
            height,
            mipLevel,
            jitter
          )
          radiance.addAssign(
            groundRadiance.mul(RECIPROCAL_PI4).mul(groundBounceScale)
          )
        })
      }

      // Crude approximation of sky gradient. Better than none in the shadows.
      const skyGradient = dot(
        weatherHeightFraction.mul(0.5).add(0.5),
        mediaWeight
      )
      radiance.addAssign(
        skyIrradiance
          .mul(skyLightModulation())
          .mul(RECIPROCAL_PI4)
          .mul(skyGradient)
          .mul(skyLightScale)
      )

      // A flash inside the volume, scattered by the same medium as the sun and
      // sky terms above. Guarded on a uniform, so an idle storm skips the march
      // toward the flash rather than paying for a term that evaluates to zero
      const lightningInScatter = deps.lightningInScatter
      if (lightningInScatter != null) {
        radiance.addAssign(lightningInScatter(position, mipLevel, jitter))
      }

      radiance.mulAssign(mediaScattering)

      // clouds.frag:581–583
      radiance.mulAssign(
        powderTerm(mediaExtinction, powderScale, powderExponent)
      )

      // clouds.frag:585–589: DEBUG_SHOW_CASCADES replaces the radiance below the
      // shadow top. The 1e-3 keeps the flat colour at in-cloud magnitude so the
      // tonemapped view is readable
      if (getDebugCascadeColor != null) {
        If(height.lessThan(shadowTopHeight), () => {
          radiance.assign(getDebugCascadeColor(position, jitter).mul(1e-3))
        })
      }

      return radiance
    }
  )
}

// The march's outputs as a struct: consumers read .get('layer'),
// .get('depthVelocity'), .get('sampleCount')
export const marchOutputStruct = /*#__PURE__*/ struct(
  { layer: 'vec4', depthVelocity: 'vec4', sampleCount: 'vec3' },
  'CloudMarchOutput'
)

const sampleStepStruct = /*#__PURE__*/ struct(
  {
    radianceDelta: 'vec3',
    transmittance: 'float',
    weightedDistanceDelta: 'float',
    transmittanceSumDelta: 'float',
    hasDensity: 'bool',
    occupied: 'bool'
  },
  'CloudSampleStep'
)

const intervalStepStruct = /*#__PURE__*/ struct(
  { stepSize: 'float', rayDistance: 'float' },
  'CloudIntervalStep'
)

// clouds.frag:513–527, clouds.glsl:142–168: three costs, for weather, shape
// and detail samples. One scalar for all three saturated the /5 channels into
// a flat plate
export function createSampleCountDelta(shapeDetail: boolean) {
  return Fn(
    ([hasWeatherDensity, mipLevel, jitter]: [
      Node<'bool'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const shapeCount = hasWeatherDensity.select(float(1), float(0))
      let detailCount: Node<'float'> = float(0)
      if (shapeDetail) {
        const usesDetail = mipLevel
          .mul(0.5)
          .add(jitter.sub(0.5).mul(0.5))
          .lessThan(0.5)
        detailCount = hasWeatherDensity
          .and(usesDetail)
          .select(float(1), float(0))
      }
      return vec3(1, shapeCount, detailCount)
    }
  )
}

function createSampleStep(
  deps: MarchCloudsDeps,
  // The shade Fn built just above by createShadeSample, structural rather than
  // ReturnType so the WGSL tests can pass a double (see batch 4)
  shadeSample: (
    position: Node<'vec3'>,
    height: Node<'float'>,
    cosTheta: Node<'float'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>,
    weatherHeightFraction: Node<'vec4'>,
    mediaWeight: Node<'vec4'>,
    mediaScattering: Node<'float'>,
    mediaExtinction: Node<'float'>
  ) => Node<'vec3'>
) {
  const {
    sampleWeather,
    sampleMedia,
    minLayerHeights,
    maxLayerHeights,
    minDensity,
    minExtinction,
    scatteringCoefficient,
    absorptionCoefficient
  } = deps

  return Fn(
    ([
      position,
      height,
      cosTheta,
      mipLevel,
      jitter,
      stepSize,
      rayDistance,
      transmittanceIntegral
    ]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const globeUv = getGlobeUv(position)
      // One value per step: weather, media and the sky gradient all read it,
      // and a plain node is re-emitted at every use
      const heightFraction = remapClamp(
        vec4(height),
        minLayerHeights,
        maxLayerHeights
      ).toVar()
      let density = sampleWeather(globeUv, height, mipLevel, heightFraction)

      // Coverage bank toward the horizon. Only the primary march carries a view
      // distance, so the sun march and the shadow map keep the plain sample
      if (deps.cloudShape?.horizonCoverage != null) {
        const horizonCoverage = deps.cloudShape.horizonCoverage
        density = density.add(horizonCoverage(rayDistance))
      }

      const radianceDelta = vec3(0).toVar()
      const nextTransmittance = float(transmittanceIntegral).toVar()
      const weightedDistanceDelta = float(0).toVar()
      const transmittanceSumDelta = float(0).toVar()
      const occupied = bool(false).toVar()

      const hasDensity = density.x
        .greaterThan(minDensity)
        .or(density.y.greaterThan(minDensity))
        .or(density.z.greaterThan(minDensity))
        .or(density.w.greaterThan(minDensity))
      If(hasDensity, () => {
        const mediaDensity = sampleMedia(
          density,
          heightFraction,
          position,
          globeUv,
          mipLevel,
          jitter
        )
        const { weight, scattering, extinction } = computeMediaOutputs(
          mediaDensity,
          scatteringCoefficient,
          absorptionCoefficient
        )

        If(extinction.greaterThan(minExtinction), () => {
          occupied.assign(bool(true))
          const radiance = shadeSample(
            position,
            height,
            cosTheta,
            mipLevel,
            jitter,
            heightFraction,
            weight,
            scattering,
            extinction
          )
          integrateStep(
            radiance,
            extinction,
            stepSize,
            rayDistance,
            radianceDelta,
            nextTransmittance,
            weightedDistanceDelta,
            transmittanceSumDelta
          )
        })
      })

      return sampleStepStruct(
        radianceDelta,
        nextTransmittance,
        weightedDistanceDelta,
        transmittanceSumDelta,
        hasDensity,
        occupied
      )
    }
  )
}

// Empty layer intervals and zero-density samples take the same longer step
// TODO(port): This produces banding artifacts. Possible improvement: Binary search refinement
function createIntervalSkipStep(deps: MarchCloudsDeps) {
  return Fn(
    ([stepSize, rayDistance, mipLevel]: [
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const nextStepSize = stepSize.mul(deps.perspectiveStepScale)
      const nextRayDistance = rayDistance.add(
        mix(nextStepSize, float(deps.maxStepSize), min(float(1), mipLevel))
      )
      return intervalStepStruct(nextStepSize, nextRayDistance)
    }
  )
}

function prepareRayLighting(
  deps: MarchCloudsDeps,
  cosine: Node<'float'>,
  direction: Node<'vec3'>
): void {
  deps.prepareMultiScatter?.(cosine)
  deps.prepareSkylight?.(direction)
}

export function createMarchClouds(deps: MarchCloudsDeps) {
  const {
    bottomRadius,
    minIntervalHeights,
    maxIntervalHeights,
    maxIterationCount,
    minStepSize,
    perspectiveStepScale,
    minTransmittance,
    worldToUnit
  } = deps

  const shadeSample = createShadeSample(deps)
  const sampleStep = createSampleStep(deps, shadeSample)
  const intervalSkipStep = createIntervalSkipStep(deps)
  const sampleCountDelta = createSampleCountDelta(deps.shapeDetail ?? false)
  let refinementCounter: Node<'vec3'> = vec3(0)
  const refineFront = deps.cloudFrontRefinement
    ? createRefineCloudFront(
        Fn(
          ([position, mip, jitter]: [
            Node<'vec3'>,
            Node<'float'>,
            Node<'float'>
          ]) => {
            if (deps.trackSampleCount) {
              refinementCounter.addAssign(
                sampleCountDelta(bool(true), mip, jitter)
              )
            }
            const height = length(position).sub(bottomRadius)
            const uv = getGlobeUv(position)
            const fraction = remapClamp(
              vec4(height),
              deps.minLayerHeights,
              deps.maxLayerHeights
            ).toVar()
            const density = deps.sampleWeather(uv, height, mip, fraction)
            const media = deps.sampleMedia(
              density,
              fraction,
              position,
              uv,
              mip,
              jitter
            )
            return computeMediaOutputs(
              media,
              deps.scatteringCoefficient,
              deps.absorptionCoefficient
            ).extinction.greaterThan(deps.minExtinction)
          }
        )
      )
    : null
  const front = createFrontTracker(refineFront)

  return Fn(
    ([
      rayOrigin,
      rayDirection,
      rayNearFar,
      cosTheta,
      jitter,
      rayStartTexelsPerPixel
    ]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'vec2'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const radianceIntegral = vec3(0).toVar()
      const transmittanceIntegral = float(1).toVar()
      const weightedDistanceSum = float(0).toVar()
      const transmittanceSum = float(0).toVar()
      const sampleCounter = deps.trackSampleCount ? vec3(0).toVar() : null
      refinementCounter = vec3(0).toVar()

      const maxRayDistance = rayNearFar.y.sub(rayNearFar.x)
      const stepSize = float(minStepSize)
        .add(float(perspectiveStepScale).sub(1).mul(rayNearFar.x))
        .toVar()
      // I don't understand why spatial aliasing remains unless doubling the jitter
      const rayDistance = stepSize.mul(jitter).mul(2.0).toVar()
      front.initialize()

      // Per-ray terms the per-step shading reads (emitted before the loop)
      prepareRayLighting(deps, cosTheta, rayDirection)

      Loop({ start: 0, end: maxIterationCount }, () => {
        If(rayDistance.greaterThan(maxRayDistance), () => {
          Break()
        })

        // NOTE(port): Not exactly the original 0.25 mipLevelScale (CloudsMaterial.ts:346)
        const mipLevelAt = () =>
          log2(
            max(
              float(1),
              float(rayStartTexelsPerPixel).add(rayDistance.mul(1e-5))
            )
          )

        rayDistance.assign(
          front.refine(
            rayOrigin,
            rayDirection,
            rayDistance,
            mipLevelAt(),
            jitter
          )
        )
        const position = rayDirection.mul(rayDistance).add(rayOrigin)
        const height = length(position).sub(bottomRadius)

        const doSampling = Fn(() => {
          // Built per branch, not shared across the skip If: three r186
          // declares a shared node at its first use, and the other branch then
          // reads a stale value
          const mipLevel = mipLevelAt()
          const sample = sampleStep(
            position,
            height,
            cosTheta,
            mipLevel,
            jitter,
            stepSize,
            rayDistance,
            transmittanceIntegral
          )
          front.record(rayDistance, sample.get('occupied') as Node<'bool'>)
          if (sampleCounter != null) {
            const hasDensity = sample.get('hasDensity') as Node<'bool'>
            sampleCounter.addAssign(
              sampleCountDelta(hasDensity, mipLevel, jitter)
            )
          }
          // struct .get() is not generic over the member table
          radianceIntegral.addAssign(
            sample.get('radianceDelta') as Node<'vec3'>
          )
          transmittanceIntegral.assign(sample.get('transmittance'))
          weightedDistanceSum.addAssign(
            sample.get('weightedDistanceDelta') as Node<'float'>
          )
          transmittanceSum.addAssign(
            sample.get('transmittanceSumDelta') as Node<'float'>
          )

          If(sample.get('hasDensity'), () => {
            If(transmittanceIntegral.lessThanEqual(minTransmittance), () => {
              Break()
            })

            // Take a shorter step because we've already hit the clouds
            stepSize.mulAssign(perspectiveStepScale)
            rayDistance.addAssign(stepSize)
          }).Else(() => {
            const skipped = intervalSkipStep(stepSize, rayDistance, mipLevel)
            stepSize.assign(skipped.get('stepSize'))
            rayDistance.assign(skipped.get('rayDistance'))
          })
        }, 'void')

        if (deps.disableIntervalSkip) {
          doSampling().toStack()
        } else {
          If(
            insideLayerIntervals(
              height,
              minIntervalHeights,
              maxIntervalHeights
            ),
            () => {
              front.record(rayDistance, bool(false))
              const skipped = intervalSkipStep(
                stepSize,
                rayDistance,
                mipLevelAt()
              )
              stepSize.assign(skipped.get('stepSize'))
              rayDistance.assign(skipped.get('rayDistance'))
            }
          ).Else(() => {
            doSampling().toStack()
          })
        }
      })

      if (sampleCounter != null) {
        const wl = writeLayer(
          radianceIntegral,
          transmittanceIntegral,
          minTransmittance,
          weightedDistanceSum,
          transmittanceSum,
          worldToUnit
        )
        return marchOutputStruct(
          wl.get('layer'),
          wl.get('depthVelocity'),
          sampleCounter.add(refinementCounter)
        )
      }
      const wl = writeLayer(
        radianceIntegral,
        transmittanceIntegral,
        minTransmittance,
        weightedDistanceSum,
        transmittanceSum,
        worldToUnit
      )
      return marchOutputStruct(
        wl.get('layer'),
        wl.get('depthVelocity'),
        vec3(0)
      )
    }
  )
}

// CPU twins for testing

export function remapClampedCPU(
  value: number,
  inLow: number,
  inHigh: number
): number {
  return Math.max(0, Math.min(1, (value - inLow) / (inHigh - inLow)))
}

export function sampleCountDeltaCPU(
  hasWeatherDensity: boolean,
  mipLevel: number,
  jitter: number,
  shapeDetail: boolean
): [number, number, number] {
  const usesDetail = mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5
  return [
    1,
    hasWeatherDensity ? 1 : 0,
    hasWeatherDensity && shapeDetail && usesDetail ? 1 : 0
  ]
}

export function insideLayerIntervalsCPU(
  height: number,
  minH: [number, number, number],
  maxH: [number, number, number]
): boolean {
  for (let i = 0; i < 3; i++) {
    if (height > minH[i]! && height < maxH[i]!) return true
  }
  return false
}

export interface IntegrateStepState {
  radianceR: number
  radianceG: number
  radianceB: number
  transmittanceIntegral: number
  weightedDistanceSum: number
  transmittanceSum: number
}

export function integrateStepCPU(
  radiance: [number, number, number],
  extinction: number,
  stepSize: number,
  rayDistance: number,
  state: IntegrateStepState
): void {
  const transmittance = Math.exp(-extinction * stepSize)
  const clamped = Math.max(extinction, 1e-7)
  for (let c = 0; c < 3; c++) {
    const r = radiance[c]!
    const si = (r - r * transmittance) / clamped
    if (c === 0) state.radianceR += state.transmittanceIntegral * si
    if (c === 1) state.radianceG += state.transmittanceIntegral * si
    if (c === 2) state.radianceB += state.transmittanceIntegral * si
  }
  state.transmittanceIntegral *= transmittance
  state.weightedDistanceSum += rayDistance * state.transmittanceIntegral
  state.transmittanceSum += state.transmittanceIntegral
}

export function frontDepthCPU(state: IntegrateStepState): number {
  return state.transmittanceSum > 0
    ? state.weightedDistanceSum / state.transmittanceSum
    : -1
}

// clouds.frag:553, horizon-only PCF radius
export function bsmPcfRadiusCPU(
  sunDirDotNormal: number,
  maxShadowFilterRadius: number
): number {
  return maxShadowFilterRadius * remapClampedCPU(sunDirDotNormal, 0.1, 0)
}
