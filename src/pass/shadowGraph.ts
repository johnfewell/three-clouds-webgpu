// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// The shadow march pass's graph: the per-cascade optical-depth draw, and the MRT
// it writes when the temporal resolve is on (atlas + depth velocity, so one
// march feeds both). Graph-time only

import { Fn, mrt, texture as tslTexture, uv, vec4 } from 'three/tsl'
import type { NodeMaterial, RenderTarget, TextureNode } from 'three/webgpu'

import type { CloudsContext } from '../CloudsContext'
import { createSampleMedia } from '../density/sampleShape'
import { createSampleWeather } from '../density/sampleWeather'
import type { CloudShapeDeps } from '../experimental/cloudShape'
import type { CloudTypeBlendNodes } from '../experimental/cloudTypeMap'
import type { ConvectiveDeps } from '../experimental/convectiveProfile'
import type { EvolvingWeather } from '../experimental/evolvingWeather'
import type { LayerUniforms } from '../layerUniforms'
import { getSTBN } from '../march/jitter'
import type { MarchUniforms } from '../marchUniforms'
import type { ParameterUniforms } from '../parameterUniforms'
import {
  buildCascadeSetup,
  createOpticalDepthMarch
} from '../shadow/opticalDepthMarch'
import { buildShadowVelocity } from '../shadow/shadowResolve'
import { cloudTypeBlend } from './marchGraph'
import type { ShadowPassUniforms } from './shadowUniforms'
import { SHADOW_ATLAS, SHADOW_VELOCITY, shadowPassOutput } from './targets'

// What the shadow march pass's graph needs from the pass, and nothing more
export interface ShadowGraphHost {
  material: NodeMaterial
  // Allocates the atlas at this shape, re-pointing every sampling node
  ensureShadowRT(width: number, height: number, depth: number): void
  shadowRT(): RenderTarget | null
  // A live handle: the target is recreated outside the graph build
  odTexNode(): TextureNode | null
  // Opt-in weather evolution and convection, both null-safe on the off graph
  weatherEvolution: EvolvingWeather
  convectiveDeps: (
    ctx: CloudsContext,
    layerU: LayerUniforms,
    paramU: ParameterUniforms
  ) => ConvectiveDeps | null
  // The opt-in shape controls. The shadow map marches in cascade texel space,
  // so only the two that move a shape lookup reach this graph: the coverage
  // bank has no view distance here and the base shadow has no sun term
  cloudShapeDeps: (ctx: CloudsContext) => CloudShapeDeps
}

// Cite: shadow.frag:37–193, ShadowPass.ts:124–140

// Returns the atlas node the velocity reads, so the caller keeps the handle it
// built with rather than minting a second one for the same target
export function buildShadowPassGraph(
  ctx: CloudsContext,
  marchU: MarchUniforms,
  layerU: LayerUniforms,
  paramU: ParameterUniforms,
  su: ShadowPassUniforms,
  host: ShadowGraphHost
): TextureNode | null {
  const cloudTypes: CloudTypeBlendNodes | undefined = cloudTypeBlend(
    ctx,
    paramU
  )
  const evolution = host.weatherEvolution.build(ctx, paramU.localWeatherTexture)
  // With no layer casting a shadow the mask zeroes the weather read, so the
  // read is dropped. Exact only without pow: a finite unorm times 0 is +0
  const maskedOut =
    !ctx.cloudLayers.castsShadow &&
    ctx.cloudLayers.structure.weatherExponentOne &&
    evolution == null
  const shadowWeather = createSampleWeather(
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
    true,
    ctx.cloudLayers.structure,
    maskedOut ? () => vec4(0) : evolution,
    host.convectiveDeps(ctx, layerU, paramU),
    cloudTypes
  )

  const shadowMedia = createSampleMedia(
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
    // The shadow map marches in cascade texel space, not along the view ray,
    // so the distance fade the horizon needs has no meaning here
    false,
    ctx.cloudLayers.structure,
    host.convectiveDeps(ctx, layerU, paramU),
    cloudTypes,
    host.cloudShapeDeps(ctx)
  )

  const marchOD = createOpticalDepthMarch({
    sampleWeather: shadowWeather,
    sampleMedia: shadowMedia,
    bottomRadius: marchU.bottomRadius,
    minIntervalHeights: layerU.minIntervalHeights,
    maxIntervalHeights: layerU.maxIntervalHeights,
    minLayerHeights: layerU.minLayerHeights,
    maxLayerHeights: layerU.maxLayerHeights,
    maxIterationCount: su.maxIterationCount,
    minStepSize: su.minStepSize,
    maxStepSize: su.maxStepSize,
    minDensity: su.minDensity,
    minExtinction: su.minExtinction,
    minTransmittance: su.minTransmittance,
    opticalDepthTailScale: su.opticalDepthTailScale,
    scatteringCoefficient: paramU.scatteringCoefficient,
    absorptionCoefficient: paramU.absorptionCoefficient,
    worldToUnit: marchU.worldToUnit,
    temporalJitter: ctx.shadow.temporalJitter
  })

  // Indexed by ctx.frame even under updateInterval N, so the slices match
  // the reference's on the same frames (shadow-temporal 0.954 vs 0.945 with
  // a per-update index, 2026-09-04)
  const stbn = getSTBN(
    paramU.stbnTexture,
    paramU.frame,
    undefined,
    'stbnShadow'
  )

  // The light the map is fitted to and marches along, which is the sun's
  // unless experimental.moonlight has handed it to the moon
  const lightDirection = ctx.experimental.moonlight
    ? marchU.lightDirection
    : marchU.sunDirection

  const temporal = ctx.shadow.temporalPass
  let odTexNode = host.odTexNode()
  if (temporal) {
    const sz = ctx.shadow.mapSize
    host.ensureShadowRT(sz.x, sz.y, ctx.shadow.cascadeCount)
    odTexNode ??= tslTexture(host.shadowRT()!.texture)
  }
  const shadowFragment = Fn(() => {
    const setup = buildCascadeSetup(
      uv().mul(2).sub(1),
      su.inverseShadowMatrix,
      marchU.worldToECEFMatrix,
      marchU.altitudeCorrection,
      lightDirection,
      marchU.bottomRadius,
      layerU.shadowTopHeight,
      layerU.shadowBottomHeight
    )
    const od = marchOD(
      setup.rayOrigin,
      setup.rayDirection,
      setup.maxRayDistance,
      stbn,
      su.mipLevel
    ).toVar()
    if (!temporal) return od
    // Cite: shadow.frag:168-179. The depth velocity from the same draw's front
    // depth, written as a second attachment. It replaces a separate velocity
    // pass per cascade that re-read the fp16 atlas
    const velocity = buildShadowVelocity({
      odBuffer: odTexNode!,
      frontDepthUnit: od.x,
      inverseShadowMatrix: su.inverseShadowMatrix,
      reprojectionMatrix: su.reprojectionMatrix,
      worldToECEFMatrix: marchU.worldToECEFMatrix,
      ecefToWorldMatrix: marchU.ecefToWorldMatrix,
      altitudeCorrection: marchU.altitudeCorrection,
      sunDirection: lightDirection,
      bottomRadius: marchU.bottomRadius,
      // The atlas's unit-space front depth is converted to metres here
      worldToUnit: marchU.worldToUnit,
      shadowTopHeight: layerU.shadowTopHeight,
      shadowBottomHeight: layerU.shadowBottomHeight,
      resolution: su.shadowResolution,
      cascadeIndex: su.cascadeIndex
    })
    return shadowPassOutput(od, velocity)
  })()
  host.material.fragmentNode = temporal
    ? mrt({
        [SHADOW_ATLAS]: shadowFragment.get('atlas'),
        [SHADOW_VELOCITY]: shadowFragment.get('velocity')
      })
    : shadowFragment
  host.material.needsUpdate = true
  return odTexNode
}
