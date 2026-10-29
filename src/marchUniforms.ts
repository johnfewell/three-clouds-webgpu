// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Uniforms for the primary/secondary march that are not in
// ParameterUniforms or LayerUniforms

import type { Matrix4, Vector3 } from 'three'
import { uniform } from 'three/tsl'
import type { UniformNode } from 'three/webgpu'

import type { CloudsContext } from './CloudsContext'

export interface MarchUniforms {
  bottomRadius: UniformNode<'float', number>
  sunDirection: UniformNode<'vec3', Vector3>
  // The march's light: the sun's until twilight hands it to the moon. Read
  // only when experimental.moonlight is on
  lightDirection: UniformNode<'vec3', Vector3>
  // The moon's irradiance as a fraction of the sun's, in the moon's colour
  moonIrradianceRatio: UniformNode<'vec3', Vector3>
  altitudeCorrection: UniformNode<'vec3', Vector3>
  worldToECEFMatrix: UniformNode<'mat4', Matrix4>
  ecefToWorldMatrix: UniformNode<'mat4', Matrix4>
  worldToUnit: UniformNode<'float', number>
  cameraHeight: UniformNode<'float', number>

  maxIterationCount: UniformNode<'float', number>
  maxIterationCountToSun: UniformNode<'float', number>
  minStepSize: UniformNode<'float', number>
  maxStepSize: UniformNode<'float', number>
  maxRayDistance: UniformNode<'float', number>
  perspectiveStepScale: UniformNode<'float', number>
  minSecondaryStepSize: UniformNode<'float', number>
  secondaryStepScale: UniformNode<'float', number>

  minShadowLengthStepSize: UniformNode<'float', number>
  maxShadowLengthRayDistance: UniformNode<'float', number>
  // PCF radius for the primary march's Beer-shadow-map hook (clouds.frag:551)
  maxShadowFilterRadius: UniformNode<'float', number>

  maxIterationCountToGround: UniformNode<'float', number>

  skyLightScale: UniformNode<'float', number>
  groundBounceScale: UniformNode<'float', number>
  powderScale: UniformNode<'float', number>
  powderExponent: UniformNode<'float', number>
}

export function createMarchUniforms(ctx: CloudsContext): MarchUniforms {
  return {
    bottomRadius: uniform(ctx.bottomRadius).setName('march_bottomRadius'),
    sunDirection: uniform(ctx.sunDirection).setName('march_sunDirection'),
    lightDirection: uniform(ctx.lightDirection).setName('march_lightDirection'),
    moonIrradianceRatio: uniform(ctx.moonIrradianceRatio).setName(
      'march_moonIrradianceRatio'
    ),
    altitudeCorrection: uniform(ctx.altitudeCorrection).setName(
      'march_altitudeCorrection'
    ),
    worldToECEFMatrix: uniform(ctx.worldToECEFMatrix).setName(
      'march_worldToECEFMatrix'
    ),
    ecefToWorldMatrix: uniform(ctx.ecefToWorldMatrix).setName(
      'march_ecefToWorldMatrix'
    ),
    worldToUnit: uniform(1 / ctx.bottomRadius).setName('march_worldToUnit'),
    cameraHeight: uniform(ctx.cameraHeight).setName('march_cameraHeight'),

    maxIterationCount: uniform(ctx.clouds.maxIterationCount).setName(
      'march_maxIterationCount'
    ),
    maxIterationCountToSun: uniform(ctx.clouds.maxIterationCountToSun).setName(
      'march_maxIterationCountToSun'
    ),
    minStepSize: uniform(ctx.clouds.minStepSize).setName('march_minStepSize'),
    maxStepSize: uniform(ctx.clouds.maxStepSize).setName('march_maxStepSize'),
    maxRayDistance: uniform(ctx.clouds.maxRayDistance).setName(
      'march_maxRayDistance'
    ),
    perspectiveStepScale: uniform(ctx.clouds.perspectiveStepScale).setName(
      'march_perspectiveStepScale'
    ),
    minSecondaryStepSize: uniform(ctx.clouds.minSecondaryStepSize).setName(
      'march_minSecondaryStepSize'
    ),
    secondaryStepScale: uniform(ctx.clouds.secondaryStepScale).setName(
      'march_secondaryStepScale'
    ),

    minShadowLengthStepSize: uniform(
      ctx.clouds.minShadowLengthStepSize
    ).setName('march_minShadowLengthStepSize'),
    maxShadowLengthRayDistance: uniform(
      ctx.clouds.maxShadowLengthRayDistance
    ).setName('march_maxShadowLengthRayDistance'),
    maxShadowFilterRadius: uniform(ctx.clouds.maxShadowFilterRadius).setName(
      'march_maxShadowFilterRadius'
    ),

    maxIterationCountToGround: uniform(
      ctx.clouds.maxIterationCountToGround
    ).setName('march_maxIterationCountToGround'),

    skyLightScale: uniform(ctx.skyLightScale).setName('march_skyLightScale'),
    groundBounceScale: uniform(ctx.groundBounceScale).setName(
      'march_groundBounceScale'
    ),
    powderScale: uniform(ctx.powderScale).setName('march_powderScale'),
    powderExponent: uniform(ctx.powderExponent).setName('march_powderExponent')
  }
}

export function updateMarchUniforms(
  u: MarchUniforms,
  ctx: CloudsContext
): void {
  u.bottomRadius.value = ctx.bottomRadius
  // First, so the light the rest of the frame reads is this frame's
  ctx.updateMoonlight()
  u.sunDirection.value.copy(ctx.sunDirection)
  u.lightDirection.value.copy(ctx.lightDirection)
  u.moonIrradianceRatio.value.copy(ctx.moonIrradianceRatio)
  u.altitudeCorrection.value.copy(ctx.altitudeCorrection)
  u.worldToECEFMatrix.value.copy(ctx.worldToECEFMatrix)
  u.ecefToWorldMatrix.value.copy(ctx.ecefToWorldMatrix)
  u.worldToUnit.value = 1 / ctx.bottomRadius
  u.cameraHeight.value = ctx.cameraHeight

  u.maxIterationCount.value = ctx.clouds.maxIterationCount
  u.maxIterationCountToSun.value = ctx.clouds.maxIterationCountToSun
  u.minStepSize.value = ctx.clouds.minStepSize
  u.maxStepSize.value = ctx.clouds.maxStepSize
  u.maxRayDistance.value = ctx.clouds.maxRayDistance
  u.perspectiveStepScale.value = ctx.clouds.perspectiveStepScale
  u.minSecondaryStepSize.value = ctx.clouds.minSecondaryStepSize
  u.secondaryStepScale.value = ctx.clouds.secondaryStepScale

  u.minShadowLengthStepSize.value = ctx.clouds.minShadowLengthStepSize
  u.maxShadowLengthRayDistance.value = ctx.clouds.maxShadowLengthRayDistance
  u.maxShadowFilterRadius.value = ctx.clouds.maxShadowFilterRadius

  u.maxIterationCountToGround.value = ctx.clouds.maxIterationCountToGround

  u.skyLightScale.value = ctx.skyLightScale
  u.groundBounceScale.value = ctx.groundBounceScale
  u.powderScale.value = ctx.powderScale
  u.powderExponent.value = ctx.powderExponent
}
