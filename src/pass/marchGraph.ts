// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// The march pass's graph: every factory the primary march and the fragment it
// feeds are built from, and the MRT the fragment writes. Graph-time only, so
// every branch is a JS `if` around node construction, rebuilt by cache key

import { PerspectiveCamera, type Camera } from 'three'
import { float, Fn, int, mrt } from 'three/tsl'
import type { Node, NodeMaterial, StructNode, TextureNode } from 'three/webgpu'

import type { CloudsContext } from '../CloudsContext'
import type { CloudShadowDescriptor, UniformArrayLike } from '../CloudsPassNode'
import { createSampleMedia } from '../density/sampleShape'
import { createSampleWeather } from '../density/sampleWeather'
import {
  createCirrusDeckComposite,
  type CirrusDeckUniforms
} from '../experimental/cirrusDeck'
import type { CloudShapeDeps } from '../experimental/cloudShape'
import type { CloudTypeBlendNodes } from '../experimental/cloudTypeMap'
import type { ConvectiveDeps } from '../experimental/convectiveProfile'
import { createDirectionalSkylight } from '../experimental/directionalSkylight'
import type { EvolvingWeather } from '../experimental/evolvingWeather'
import {
  buildLightningDeps,
  lightningParamsDefault,
  type LightningUniforms
} from '../experimental/lightning'
import {
  createMoonlightNodes,
  type MoonlightNodes
} from '../experimental/moonlight'
import type { RainShaftDeps } from '../experimental/rainShafts'
import type { WindHistory } from '../experimental/WindHistory'
import type { LayerUniforms } from '../layerUniforms'
import { createApproxMultiScatterTSL } from '../lighting/multiScatter'
import {
  accuratePhaseFunctionTSL,
  phaseFunctionTSL
} from '../lighting/phaseFunction'
import {
  createCloudsSunSkyIrradiance,
  createCloudsSunSkyIrradianceInterpolated,
  createGroundSunSkyIrradiance,
  createGroundSunSkyIrradianceInterpolated,
  createIndirectLuminanceToPoint,
  createSunSkyIrradianceCache
} from '../lighting/sunSkyLight'
import { createApplyAerialPerspective } from '../march/aerialPerspective'
import {
  type buildCloudsFragment,
  type CloudsFragmentDeps
} from '../march/cloudsFragment'
import { createApproximateHaze } from '../march/hazeMarch'
import { getSTBN, referenceFragCoord } from '../march/jitter'
import { createMarchClouds, type MarchCloudsDeps } from '../march/primaryMarch'
import { createRainShaftMarch } from '../march/rainShaftMarch'
import { createGetRayDistanceToScene } from '../march/sceneDepth'
import { createApproximateRadianceFromGround } from '../march/secondaryGroundMarch'
import { createMarchOpticalDepth } from '../march/secondarySunMarch'
import {
  createMarchShadowLength,
  createMarchShadowLengthQuadPartial,
  type ShadowLengthMarchDeps
} from '../march/shadowLengthMarch'
import type { MarchUniforms } from '../marchUniforms'
import type { ParameterUniforms } from '../parameterUniforms'
import {
  createSampleShadowOpticalDepth,
  type ShadowSamplerDeps
} from '../shadow/sampleShadowOpticalDepth'
import { buildDebugCascadeColor } from './debugViews'

const defaultCamera = /*#__PURE__*/ new PerspectiveCamera()

// Picks the ground-bounce irradiance producer as the reference's
// `#ifdef ACCURATE_SUN_SKY_LIGHT` does (clouds.frag:419-437), and not as an
// inline ternary: that took the factory wiring to 14 decision points
export function selectGroundSunSkyIrradiance(
  accurate: boolean,
  sunDirectionECEF: Parameters<typeof createGroundSunSkyIrradiance>[0],
  cache: Parameters<typeof createGroundSunSkyIrradianceInterpolated>[0]
): ReturnType<typeof createGroundSunSkyIrradiance> {
  return accurate
    ? createGroundSunSkyIrradiance(sunDirectionECEF)
    : createGroundSunSkyIrradianceInterpolated(cache)
}

// Opt-in regional cloud-type map. Absent, the two density samplers read their
// base uniforms and the graph is the reference's. The map rides the weather
// channel's uv transform, so it takes no tiling of its own
export function cloudTypeBlend(
  ctx: CloudsContext,
  paramU: ParameterUniforms
): CloudTypeBlendNodes | undefined {
  if (!ctx.experimental.cloudTypeMap) return undefined
  return ctx.cloudTypes.blendNodes(
    paramU.localWeatherRepeat,
    paramU.localWeatherOffset
  )
}

// Cite: clouds.frag:622–650, the shafts' shadow-length march, and its
// quad-shared partial when the pass runs lightShaftsHalfResolution. Null
// without light shafts or without a shadow atlas to sample
export function createShadowLengthMarches(
  ctx: CloudsContext,
  marchU: MarchUniforms,
  sampleShadowOD: ShadowLengthMarchDeps['sampleShadowOpticalDepth'] | null,
  quadShadowLength: boolean
): {
  marchShadowLengthFn: ReturnType<typeof createMarchShadowLength> | null
  marchShadowLengthQuadPartialFn: ReturnType<
    typeof createMarchShadowLengthQuadPartial
  > | null
} {
  if (!ctx.lightShafts || sampleShadowOD == null) {
    return { marchShadowLengthFn: null, marchShadowLengthQuadPartialFn: null }
  }
  const deps: ShadowLengthMarchDeps = {
    sampleShadowOpticalDepth: sampleShadowOD,
    perspectiveStepScale: marchU.perspectiveStepScale,
    minShadowLengthStepSize: marchU.minShadowLengthStepSize,
    maxShadowLengthIterationCount: ctx.clouds.maxShadowLengthIterationCount
  }
  return {
    marchShadowLengthFn: createMarchShadowLength(deps),
    marchShadowLengthQuadPartialFn: quadShadowLength
      ? createMarchShadowLengthQuadPartial(deps)
      : null
  }
}

export function buildDistantShadowExperiment(
  ctx: CloudsContext,
  deps: ShadowSamplerDeps
): MarchCloudsDeps['sampleShadowOpticalDepth'] {
  return ctx.experimental.distantCloudShadows
    ? createSampleShadowOpticalDepth(deps, -1)
    : undefined
}

// Null when the option is off, and null emits no node, which is what keeps the
// off graph byte-identical. The uniforms are created here and written every
// frame by CloudsPassNode.updateBefore, so striking a flash costs no rebuild
export function buildLightningExperiment(
  ctx: CloudsContext,
  marchOpticalDepth: MarchCloudsDeps['marchOpticalDepth'],
  uniforms: LightningUniforms
): Pick<MarchCloudsDeps, 'lightningInScatter'> {
  if (!ctx.experimental.lightning) return {}
  return {
    lightningInScatter: buildLightningDeps({
      marchOpticalDepth,
      cameraPosition: ctx.cameraUniforms.cameraPositionECEF,
      accuratePhaseFunction: ctx.accuratePhaseFunction,
      scatterAnisotropy1: ctx.scatterAnisotropy1,
      scatterAnisotropy2: ctx.scatterAnisotropy2,
      scatterAnisotropyMix: ctx.scatterAnisotropyMix,
      uniforms,
      params: lightningParamsDefault
    }).inScatter
  }
}

export function buildSkylightExperiment(
  ctx: CloudsContext,
  marchU: MarchUniforms,
  layerU: LayerUniforms
): Pick<MarchCloudsDeps, 'prepareSkylight' | 'skyLightModulation'> {
  if (!ctx.experimental.directionalSkylight) return {}
  const sky = createDirectionalSkylight(
    ctx.cameraUniforms.cameraPositionECEF,
    marchU.sunDirection,
    marchU.bottomRadius,
    layerU.minHeight.add(layerU.maxHeight).mul(0.5)
  )
  return { prepareSkylight: sky.prepare, skyLightModulation: sky.evaluate }
}

// The producer with the moon folded into its direct member, or the producer
// itself. A separate function and not a branch in the factory below, which was
// at 14 decision points with it inline
export function withMoonlight(
  producer: (position: Node<'vec3'>, height: Node<'float'>) => StructNode,
  moonlight: MoonlightNodes | null
): (position: Node<'vec3'>, height: Node<'float'>) => StructNode {
  if (moonlight == null) return producer
  const { addMoonlight } = moonlight
  return (position, height) => addMoonlight(producer(position, height))
}

// Opt-in moonlight: the march's one light retargeted rather than a second one
// added, so the phase function, the Beer-shadow march and the cascades follow
// it. Absent, the light is the sun's and the irradiance the atmosphere's
export function buildMoonlight(
  ctx: CloudsContext,
  marchU: MarchUniforms
): MoonlightNodes | null {
  if (!ctx.experimental.moonlight) return null
  return createMoonlightNodes({
    lightDirection: marchU.lightDirection,
    irradianceRatio: marchU.moonIrradianceRatio,
    sunAngularRadius: ctx.sunAngularRadius
  })
}

// Cite: CloudsMaterial.ts:273–284 (uniform/factory wiring for the fragment)
export function buildFragmentDeps(
  ctx: CloudsContext,
  marchU: MarchUniforms,
  layerU: LayerUniforms,
  paramU: ParameterUniforms,
  windHistory: WindHistory,
  cloudShadow: () => CloudShadowDescriptor,
  factories: Pick<
    CloudsFragmentDeps,
    | 'marchClouds'
    | 'applyAerialPerspective'
    | 'getRayDistanceToScene'
    | 'stbn'
    | 'marchShadowLength'
    | 'marchShadowLengthQuadPartial'
    | 'approximateHaze'
    | 'marchRainShafts'
    | 'compositeCirrusDeck'
  >
): CloudsFragmentDeps {
  const camU = ctx.cameraUniforms
  const desc = cloudShadow()
  return {
    windDisplacement: ctx.experimental.windReprojection
      ? windHistory.displacement
      : undefined,
    inverseProjectionMatrix: camU.inverseProjectionMatrix,
    inverseViewMatrix: camU.inverseViewMatrix,
    worldToECEFMatrix: marchU.worldToECEFMatrix,
    ecefToWorldMatrix: marchU.ecefToWorldMatrix,
    reprojectionMatrix: camU.reprojectionMatrix,
    viewReprojectionMatrix: camU.viewReprojectionMatrix,
    cameraPositionECEF: camU.cameraPositionECEF,
    cameraDirectionECEF: camU.cameraDirectionECEF,
    altitudeCorrection: marchU.altitudeCorrection,
    cameraNear: camU.cameraNear,
    cameraFar: camU.cameraFar,
    sunDirection: marchU.sunDirection,
    bottomRadius: marchU.bottomRadius,
    worldToUnit: marchU.worldToUnit,
    cameraHeight: marchU.cameraHeight,
    maxRayDistance: marchU.maxRayDistance,
    minHeight: layerU.minHeight,
    maxHeight: layerU.maxHeight,
    shadowTopHeight: layerU.shadowTopHeight,
    localWeatherRepeat: paramU.localWeatherRepeat,
    resolution: paramU.resolution,
    mipLevelScale: paramU.mipLevelScale,
    ...factories,
    lightShafts: ctx.lightShafts,
    maxShadowLengthRayDistance: ctx.lightShafts
      ? marchU.maxShadowLengthRayDistance
      : null,
    haze: ctx.haze,
    debug: ctx.debug,
    localWeatherOffset: paramU.localWeatherOffset,
    // The live handle, only when the view that reads it is on. A captured `map`
    // was the 1x1 placeholder and the debug view drew a blank tiling
    shadowBuffer: ctx.debug === 'shadowMap' ? desc.mapNode : null,
    shadowCascadeCount: desc.cascadeCountNode
  }
}

// Cite: CloudsPass.ts:193–200 (MRT targets follow the light-shafts knob)
export function applyMarchFragmentNode(
  material: NodeMaterial,
  ctx: CloudsContext,
  fragOut: ReturnType<typeof buildCloudsFragment>
): void {
  const mrtTargets: Record<string, Node<'vec4'> | Node<'vec2'>> = {
    layer: fragOut.layer,
    depthVelocity: fragOut.depthVelocity
  }
  if (ctx.lightShafts && fragOut.shadowLength != null) {
    mrtTargets.shadowLength = fragOut.shadowLength
  }
  material.fragmentNode = mrt(mrtTargets)
  material.needsUpdate = true
}

// What the march's factory wiring needs from the pass, and nothing more
export interface MarchGraphHost {
  // Allocates the shadow atlas at this shape, re-pointing every sampling node
  ensureShadowRT(width: number, height: number, depth: number): void
  // A thunk, so a build with no BSM march does not mint the descriptor
  cloudShadow: () => CloudShadowDescriptor
  shadowFromECEF: UniformArrayLike<'mat4'>
  viewZFromECEF: Node<'vec4'>
  // The opt-in wind history, read only when windReprojection is on
  windHistory: WindHistory
  // Opt-in weather evolution, convection and rain shafts, all null-safe on the
  // off graph
  weatherEvolution: EvolvingWeather
  convectiveDeps: (
    ctx: CloudsContext,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ) => ConvectiveDeps | null
  // The opt-in shape controls, null unless one of them is set. Four
  // graph-time literals rather than uniforms (cloudShape.ts header)
  cloudShapeDeps: (ctx: CloudsContext) => CloudShapeDeps
  rainShaftDeps: (
    ctx: CloudsContext,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ) => RainShaftDeps | null
  // Opt-in flash state. An unreferenced uniform emits no node, so holding it
  // before the option is ever on is safe
  lightningUniforms: LightningUniforms
  // Null unless experimental.cirrusDeck is on, and null emits no nodes
  cirrusDeckUniforms: (ctx: CloudsContext) => CirrusDeckUniforms | null
}

// Per-graph overrides of the march's own budget. Absent, every field is what the
// context says, which is the screen pass and the reference's reading

export interface MarchFactoryOverrides {
  maxIterationCount?: Node<'float'>
  maxIterationCountToSun?: Node<'float'>
  cloudFrontRefinement?: boolean
  shadows?: boolean
  shapeDetail?: boolean
}

// One field's override, or the fallback. A helper because five inline
// `overrides?.x ?? y` pairs took the factory wiring to 21 decision points, over
// the gate's 13: the same move selectGroundSunSkyIrradiance makes below

function override<K extends keyof MarchFactoryOverrides>(
  overrides: MarchFactoryOverrides | undefined,
  key: K,
  fallback: NonNullable<MarchFactoryOverrides[K]>
): NonNullable<MarchFactoryOverrides[K]> {
  return overrides?.[key] ?? fallback
}

// Its own function so buildMarchFactories does not collect one more branch:
// main's lightning and this option together took it to 14, over the limit of 13
function buildRainShaftFactory(
  ctx: CloudsContext,
  layerU: LayerUniforms,
  paramU: ParameterUniforms,
  marchU: MarchUniforms,
  host: MarchGraphHost,
  getCloudsSunSkyIrradiance: (
    position: Node<'vec3'>,
    height: Node<'float'>
  ) => StructNode
): CloudsFragmentDeps['marchRainShafts'] {
  const deps = host.rainShaftDeps(ctx, layerU, paramU)
  if (deps == null) return undefined
  return createRainShaftMarch({
    density: deps.density,
    getCloudsSunSkyIrradiance,
    bottomRadius: marchU.bottomRadius,
    baseHeight: layerU.minHeight,
    maxRayDistance: marchU.maxRayDistance
  })
}

// The deck reads the per-position LUT irradiance whatever accurateSunSkyLight
// says: the interpolated path is a cache over the volumetric layers' heights
// and would light a 10 km sheet as if it sat at the deck's top
function buildCirrusDeckFactory(
  ctx: CloudsContext,
  marchU: MarchUniforms,
  host: MarchGraphHost,
  applyAerialPerspective: ReturnType<typeof createApplyAerialPerspective>
): CloudsFragmentDeps['compositeCirrusDeck'] {
  const uniforms = host.cirrusDeckUniforms(ctx)
  if (uniforms == null) return undefined
  return createCirrusDeckComposite({
    uniforms,
    bottomRadius: marchU.bottomRadius,
    sunDirection: marchU.sunDirection,
    getSunSkyIrradiance: createCloudsSunSkyIrradiance(marchU.sunDirection),
    applyAerialPerspective,
    scatterAnisotropy1: ctx.scatterAnisotropy1,
    scatterAnisotropy2: ctx.scatterAnisotropy2,
    scatterAnisotropyMix: ctx.scatterAnisotropyMix
  })
}

export function buildMarchFactories(
  ctx: CloudsContext,
  marchU: MarchUniforms,
  layerU: LayerUniforms,
  paramU: ParameterUniforms,
  quadShadowLength: boolean,
  host: MarchGraphHost,
  overrides?: MarchFactoryOverrides
) {
  // The shadow cascades read the same blend, so a cumulus casts a cumulus
  // shadow rather than the deck's
  const cloudTypes = cloudTypeBlend(ctx, paramU)
  const cloudShapeDeps = host.cloudShapeDeps(ctx)
  const sampleWeather = createSampleWeather(
    paramU.localWeatherTexture,
    paramU.localWeatherRepeat,
    paramU.localWeatherOffset,
    layerU.minLayerHeights,
    layerU.maxLayerHeights,
    layerU.weatherExponents,
    layerU.shapeAlteringBiases,
    paramU.coverage,
    layerU.coverageFilterWidths,
    layerU.shadowLayerMask,
    ctx.cloudLayers.localWeatherChannels,
    false,
    ctx.cloudLayers.structure,
    host.weatherEvolution.build(ctx, paramU.localWeatherTexture),
    host.convectiveDeps(ctx, layerU, paramU),
    cloudTypes
  )

  const sampleMedia = createSampleMedia(
    paramU.shapeTexture,
    paramU.shapeRepeat,
    paramU.shapeOffset,
    layerU.shapeAmounts,
    paramU.shapeDetailTexture,
    paramU.shapeDetailRepeat,
    paramU.shapeDetailOffset,
    layerU.shapeDetailAmounts,
    paramU.turbulenceTexture,
    paramU.turbulenceRepeat,
    paramU.turbulenceDisplacement,
    paramU.localWeatherRepeat,
    paramU.localWeatherOffset,
    layerU.densityScales,
    layerU.densityProfileExpTerms,
    layerU.densityProfileExponents,
    layerU.densityProfileLinearTerms,
    layerU.densityProfileConstantTerms,
    ctx.turbulence,
    ctx.shapeDetail,
    ctx.experimental.distantShapeDetailFade,
    ctx.cloudLayers.structure,
    host.convectiveDeps(ctx, layerU, paramU),
    cloudTypes,
    cloudShapeDeps
  )

  const marchOpticalDepth = createMarchOpticalDepth({
    sampleWeather,
    sampleMedia,
    bottomRadius: marchU.bottomRadius,
    minSecondaryStepSize: marchU.minSecondaryStepSize,
    secondaryStepScale: marchU.secondaryStepScale,
    minLayerHeights: layerU.minLayerHeights,
    maxLayerHeights: layerU.maxLayerHeights,
    scatteringCoefficient: paramU.scatteringCoefficient,
    absorptionCoefficient: paramU.absorptionCoefficient
  })

  // Literal nodes, not uniforms: graph-time constants like the reference's
  // SCATTER_ANISOTROPY_* defines (see CloudsContext.scatterAnisotropy1)
  const multiScatter = createApproxMultiScatterTSL(
    ctx.multiScatteringOctaves,
    float(ctx.scatterAnisotropy1),
    float(ctx.scatterAnisotropy2),
    float(ctx.scatterAnisotropyMix),
    ctx.accuratePhaseFunction
  )
  const approxMultiScatter = multiScatter.evaluate

  const camU = ctx.cameraUniforms

  // Always create the irradiance cache: haze uses ground varyings even when
  // the march reads the LUT per sample. The LUT unit is the atmosphere's
  // (ADR-013), not marchU.worldToUnit's depth-storage scale
  const cache = createSunSkyIrradianceCache(
    marchU.sunDirection,
    camU.cameraPositionECEF,
    marchU.bottomRadius,
    layerU.minHeight,
    layerU.maxHeight
  )

  // Two producers with different shapes feed this (accurate vs interpolated),
  // so it carries the consumer's structural signature, the one
  // MarchCloudsDeps declares, rather than either producer's ReturnType
  let getCloudsSunSkyIrradiance: (
    position: Node<'vec3'>,
    height: Node<'float'>
  ) => StructNode
  if (ctx.accurateSunSkyLight) {
    getCloudsSunSkyIrradiance = createCloudsSunSkyIrradiance(
      marchU.sunDirection
    )
  } else {
    getCloudsSunSkyIrradiance = createCloudsSunSkyIrradianceInterpolated(
      cache,
      layerU.minHeight,
      layerU.maxHeight
    )
  }

  // The light the march shades by, and the moon's share of its direct
  // irradiance. With the option off this is the sun and the atmosphere's
  const moonlight = buildMoonlight(ctx, marchU)
  const lightDirection = moonlight?.direction ?? marchU.sunDirection
  getCloudsSunSkyIrradiance = withMoonlight(
    getCloudsSunSkyIrradiance,
    moonlight
  )

  // Cite: clouds.frag:449–470 (ground bounce)
  let approximateRadianceFromGround: ReturnType<
    typeof createApproximateRadianceFromGround
  > | null = null
  if (ctx.groundBounce) {
    // Select on the flag as the cloud irradiance does and as the reference's
    // #ifdef ACCURATE_SUN_SKY_LIGHT (clouds.frag:419-437). The accurate producer
    // was wired unconditionally, an A/B divergence

    // Masked today because ground bounce contributes ~nothing, and fixed now so
    // un-masking it does not read as a regression
    const getGroundSunSkyIrradiance = selectGroundSunSkyIrradiance(
      ctx.accurateSunSkyLight,
      marchU.sunDirection,
      cache
    )
    approximateRadianceFromGround = createApproximateRadianceFromGround({
      marchOpticalDepth,
      getGroundSunSkyIrradiance,
      maxIterationCountToGround: marchU.maxIterationCountToGround,
      coverage: paramU.coverage
    })
  }

  // Cite: clouds.frag:545–556. The BSM hook needs the in-cloud sampler built
  // before the primary march, and the shafts march reuses the same instance

  // The predicate is that some layer casts. shadowMaps always exists, so
  // testing it alone would change the Phase-1 ladder (ADR-011). The fallback
  // is eager and read-only, so computing it under an override costs nothing
  const shadows = override(
    overrides,
    'shadows',
    ctx.shadowMaps != null &&
      ctx.shadow.cascadeCount > 0 &&
      ctx.cloudLayers.some(layer => layer.shadow)
  )
  let sampleShadowOD: ReturnType<typeof createSampleShadowOpticalDepth> | null =
    null
  let sampleDistantShadow: MarchCloudsDeps['sampleShadowOpticalDepth']
  if (shadows) {
    host.ensureShadowRT(
      ctx.shadow.mapSize.x,
      ctx.shadow.mapSize.y,
      ctx.shadow.cascadeCount
    )
    const desc = host.cloudShadow()
    const shadowDeps: ShadowSamplerDeps = {
      shadowBuffer: desc.mapNode,
      shadowTexelSize: desc.texelSize,
      shadowIntervals: desc.intervals,
      shadowMatrices: desc.matrices,
      shadowFar: desc.far,
      viewMatrix: camU.viewMatrix,
      cameraNear: camU.cameraNear,
      // The light, not the sun: the cascades are fitted to it
      sunDirection: lightDirection,
      bottomRadius: marchU.bottomRadius,
      shadowTopHeight: layerU.shadowTopHeight,
      ecefToWorldMatrix: marchU.ecefToWorldMatrix,
      altitudeCorrection: marchU.altitudeCorrection,
      worldToUnit: marchU.worldToUnit,
      temporalJitter: paramU.temporalJitter,
      resolution: paramU.resolution,
      // A graph-time literal, as the reference's SHADOW_CASCADE_COUNT, so the
      // per-slot guards fold in both marches. Independently built consumers
      // keep the runtime cascadeCountNode
      cascadeCount: int(ctx.shadow.cascadeCount),
      // Cite: CloudsMaterial.ts:469 (SHADOW_SAMPLE_COUNT = 8)
      shadowSampleCount: 8,
      shadowFromECEFMatrices: host.shadowFromECEF,
      viewZFromECEF: host.viewZFromECEF
    }
    sampleShadowOD = createSampleShadowOpticalDepth(shadowDeps)
    sampleDistantShadow = buildDistantShadowExperiment(ctx, shadowDeps)
  }

  const marchClouds = createMarchClouds({
    ...buildSkylightExperiment(ctx, marchU, layerU),
    ...buildLightningExperiment(ctx, marchOpticalDepth, host.lightningUniforms),
    cloudFrontRefinement: override(
      overrides,
      'cloudFrontRefinement',
      ctx.experimental.cloudFrontRefinement
    ),
    sampleDistantShadow,
    sampleWeather,
    sampleMedia,
    cloudShape: cloudShapeDeps,
    getCloudsSunSkyIrradiance,
    marchOpticalDepth,
    approxMultiScatter,
    prepareMultiScatter: multiScatter.prepare,
    // The one light the march shades by
    sunDirection: lightDirection,
    bottomRadius: marchU.bottomRadius,
    minHeight: layerU.minHeight,
    maxHeight: layerU.maxHeight,
    minIntervalHeights: layerU.minIntervalHeights,
    maxIntervalHeights: layerU.maxIntervalHeights,
    minLayerHeights: layerU.minLayerHeights,
    maxLayerHeights: layerU.maxLayerHeights,
    maxIterationCount: override(
      overrides,
      'maxIterationCount',
      marchU.maxIterationCount
    ),
    maxIterationCountToSun: override(
      overrides,
      'maxIterationCountToSun',
      marchU.maxIterationCountToSun
    ),
    minStepSize: marchU.minStepSize,
    maxStepSize: marchU.maxStepSize,
    perspectiveStepScale: marchU.perspectiveStepScale,
    minDensity: paramU.minDensity,
    minExtinction: paramU.minExtinction,
    minTransmittance: paramU.minTransmittance,
    skyLightScale: marchU.skyLightScale,
    scatteringCoefficient: paramU.scatteringCoefficient,
    absorptionCoefficient: paramU.absorptionCoefficient,
    powderScale: marchU.powderScale,
    powderExponent: marchU.powderExponent,
    worldToUnit: marchU.worldToUnit,
    // Read by the ground-bounce guard even without shadow layers (uniform, 0 then)
    shadowTopHeight: layerU.shadowTopHeight,
    // Cite: clouds.frag:546–557, coarse BSM occlusion from other/higher
    // layers, added to the fine local sun march
    shadows,
    sampleShadowOpticalDepth: sampleShadowOD ?? undefined,
    maxShadowFilterRadius: marchU.maxShadowFilterRadius,
    groundBounce: ctx.groundBounce,
    approximateRadianceFromGround: approximateRadianceFromGround ?? undefined,
    groundBounceScale: ctx.groundBounce ? marchU.groundBounceScale : undefined,
    disableIntervalSkip: ctx.debug === 'marchIntervals',
    trackSampleCount:
      ctx.debug === 'sampleCount' || ctx.debug === 'marchIntervals',
    shapeDetail: override(overrides, 'shapeDetail', ctx.shapeDetail),
    getDebugCascadeColor: buildDebugCascadeColor({
      debug: ctx.debug,
      viewMatrix: camU.viewMatrix,
      cameraNear: camU.cameraNear,
      ecefToWorldMatrix: marchU.ecefToWorldMatrix,
      altitudeCorrection: marchU.altitudeCorrection,
      cascadeCount: ctx.shadow.cascadeCount,
      cloudShadow: host.cloudShadow
    })
  })

  const getIndirectLuminanceToPoint = createIndirectLuminanceToPoint(
    marchU.sunDirection
  )
  const applyAerialPerspective = createApplyAerialPerspective(
    getIndirectLuminanceToPoint
  )

  // Screen-space march: index the noise like the reference's gl_FragCoord
  const stbn = getSTBN(
    paramU.stbnTexture,
    paramU.frame,
    referenceFragCoord(),
    'stbnMarch'
  )

  // Cite: clouds.frag:622–650 (shadow length march)
  const { marchShadowLengthFn, marchShadowLengthQuadPartialFn } =
    createShadowLengthMarches(ctx, marchU, sampleShadowOD, quadShadowLength)

  // Cite: clouds.frag:654–697 (haze)
  let approximateHazeFn: ReturnType<typeof createApproximateHaze> | null = null
  if (ctx.haze) {
    const hazePhase = Fn(([cosTheta]: [Node<'float'>]) => {
      return ctx.accuratePhaseFunction
        ? accuratePhaseFunctionTSL(cosTheta, float(1))
        : phaseFunctionTSL(
            cosTheta,
            float(1),
            float(ctx.scatterAnisotropy1),
            float(ctx.scatterAnisotropy2),
            float(ctx.scatterAnisotropyMix)
          )
    })
    approximateHazeFn = createApproximateHaze({
      coverage: paramU.coverage,
      cameraHeight: marchU.cameraHeight,
      bottomRadius: marchU.bottomRadius,
      hazeDensityScale: paramU.hazeDensityScale,
      hazeExponent: paramU.hazeExponent,
      hazeScatteringCoefficient: paramU.hazeScatteringCoefficient,
      hazeAbsorptionCoefficient: paramU.hazeAbsorptionCoefficient,
      skyLightScale: marchU.skyLightScale,
      phaseFunction: hazePhase,
      groundSunIrradiance: cache.groundSun,
      groundSkyIrradiance: cache.groundSky
    })
  }

  // Opt-in storm shafts. A closed march of its own over the band below the
  // cloud base, which the primary march starts after and its interval skip
  // would empty anyway
  const marchRainShaftsFn = buildRainShaftFactory(
    ctx,
    layerU,
    paramU,
    marchU,
    host,
    getCloudsSunSkyIrradiance
  )

  return {
    marchClouds,
    applyAerialPerspective,
    stbn,
    marchShadowLength: marchShadowLengthFn,
    marchShadowLengthQuadPartial: marchShadowLengthQuadPartialFn,
    approximateHaze: approximateHazeFn,
    marchRainShafts: marchRainShaftsFn,
    compositeCirrusDeck: buildCirrusDeckFactory(
      ctx,
      marchU,
      host,
      applyAerialPerspective
    )
  }
}

export function buildSceneDepthNode(
  ctx: CloudsContext,
  paramU: ParameterUniforms,
  sceneDepth: TextureNode | null,
  camera: Camera | null
): ReturnType<typeof createGetRayDistanceToScene> | null {
  if (sceneDepth == null) return null
  return createGetRayDistanceToScene({
    sceneDepthTexture: sceneDepth,
    camera: camera ?? defaultCamera,
    logarithmicDepthBuffer: ctx.logarithmicDepthBuffer,
    targetUvScale: ctx.temporalUpscale ? paramU.targetUvScale : undefined,
    temporalJitter: ctx.temporalUpscale ? paramU.temporalJitter : undefined
  })
}
