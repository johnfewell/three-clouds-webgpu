// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: ADR-007 (the shadow consumers), clouds.frag:221-250 (the sampler entry
// point), CloudsEffect.ts:421-431 (AtmosphereShadow)

// The ground consumer's transmittance Fn verbatim behind a world -> ECEF metres
// conversion, so a water, vegetation or particle material sees exactly what the
// aerial perspective sees on the surface below it

import { Fn, vec2, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { CloudShadowDescriptor } from '../CloudsPassNode'
import {
  createCloudShadowTransmittance,
  type GroundShadowExtraDeps
} from './sampleCloudShadowOpticalDepth'

export interface CloudShadowNodeDeps extends GroundShadowExtraDeps {
  // The pass's CloudShadowDescriptor: its atlas and cascade matrices
  descriptor: CloudShadowDescriptor
  // three.js world -> ECEF metres. The shadow atlas is indexed in ECEF, so a
  // consumer in world space converts before anything else
  worldToECEFMatrix: Node<'mat4'>
}

export interface CloudShadowNodeOptions {
  // PCF taps per fetch. The ground consumer's own default is 8
  shadowSampleCount?: number
}

export interface CloudShadowAtOptions extends CloudShadowNodeOptions {
  // PCF radius in shadow texels. DEFAULT_SHADOW_RADIUS unless given. The aerial
  // consumer computes a per-pixel adaptive radius instead
  // (createGetShadowRadius), which a material that wants it passes here
  radius?: Node<'float'>
  // Per-pixel dither in 0..1, selecting the cascade and rotating the PCF disk
  // (0 unless given: the disk seed is already per-pixel, from the fragment's
  // own coordinate)
  jitter?: Node<'float'>
}

// An Fn taking a three.js world position, a PCF radius and a jitter, returning
// the sun transmittance there. CloudsPassNode.cloudShadowAt wraps this with the
// pass's own uniforms, which is what most callers want
export function createCloudShadowNode(
  deps: CloudShadowNodeDeps,
  options: CloudShadowNodeOptions = {}
) {
  const transmittance = createCloudShadowTransmittance(
    deps.descriptor,
    deps,
    options
  )
  return Fn(
    ([worldPosition, radius, jitter]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const positionECEF = deps.worldToECEFMatrix.mul(
        vec4(worldPosition.x, worldPosition.y, worldPosition.z, 1)
      ).xyz
      // The altitude correction is the ground consumer's own: added on the way
      // in and taken back out inside the sampler, so the ray-sphere distance to
      // the shadow top is measured with the two large terms cancelled
      return transmittance(
        positionECEF.add(deps.altitudeCorrection),
        radius,
        jitter
      )
    }
  )
}

// The atlas resolution recovered from texelSize, which the pass keeps equal to
// 1 / shadow.mapSize. It scales the temporal jitter into pixels, so it has to
// follow a map-size change without a second uniform to keep in step
export const cloudShadowAtlasResolution = (
  descriptor: CloudShadowDescriptor
): Node<'vec2'> => vec2(1, 1).div(descriptor.texelSize)

// CPU twin for testing

// The transmittance a sample returns, exp(-od) over the optical depth the ground
// consumer's sampler computes. It mirrors createCloudShadowTransmittance's
// single expression, so a test can state what the shader must produce
export function cpuCloudShadowTransmittance(opticalDepth: number): number {
  return Math.exp(-opticalDepth)
}
