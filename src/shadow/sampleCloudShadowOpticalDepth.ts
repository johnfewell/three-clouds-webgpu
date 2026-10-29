// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:172–250 (shadow sampling), CloudsEffect.ts:421–431 (AtmosphereShadow)
// Cite: @takram/three-geospatial cascadedShadowMaps.glsl (cascade selection)

import {
  float,
  Fn,
  If,
  Loop,
  max,
  min,
  screenCoordinate,
  screenSize,
  vec2,
  vec4
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import { interleavedGradientNoise } from '@takram/three-geospatial/webgpu'

import type { CloudShadowDescriptor } from '../CloudsPassNode'
import { createFadedCascadeIndex } from './fadedCascadeIndex'
import {
  getDistanceToShadowTop,
  getShadowUv,
  vogelDisk
} from './sampleShadowOpticalDepth'

const PI2 = Math.PI * 2

// The reference seeds its PCF disk from gl_FragCoord, which is bottom-first
// three's screenCoordinate is top-first, so the same pixel would read a
// different seed. Same shape as the Bayer row fix in src/resolve/bayer.ts

// The framebuffer's own height, not the shadow map's `resolution`: the row index
// belongs to the frame the ground receiver is drawn on
export const webglFragCoord = (coord: Node<'vec2'>): Node<'vec2'> =>
  vec2(coord.x, screenSize.y.sub(coord.y))

export interface GroundShadowExtraDeps {
  viewMatrix: Node<'mat4'>
  cameraNear: Node<'float'>
  sunDirection: Node<'vec3'>
  bottomRadius: Node<'float'>
  ecefToWorldMatrix: Node<'mat4'>
  altitudeCorrection: Node<'vec3'>
  worldToUnit: Node<'float'>
  temporalJitter: Node<'vec2'>
  resolution: Node<'vec2'>
}

export function createSampleCloudShadowOpticalDepth(
  descriptor: CloudShadowDescriptor,
  deps: GroundShadowExtraDeps,
  options: { shadowSampleCount?: number } = {}
) {
  // The reference's ground consumer, AerialPerspectiveEffect, defaults its
  // SHADOW_SAMPLE_COUNT to 8 (@takram/three-atmosphere, WebGL). 16 doubled the
  // PCF taps per ground pixel
  const { shadowSampleCount = 8 } = options
  const {
    viewMatrix,
    cameraNear,
    sunDirection,
    bottomRadius,
    ecefToWorldMatrix,
    altitudeCorrection,
    worldToUnit,
    temporalJitter,
    resolution
  } = deps

  // Cite: aerialPerspectiveEffect.frag:177–183 (the ground formula omits tail)
  const readGroundShadowOpticalDepth = Fn(
    ([uv, distanceToTop, cascadeIndex]: [
      Node<'vec2'>,
      Node<'float'>,
      Node<'int'>
    ]) => {
      // Live handle, not descriptor.map: `map` is repointed every update
      // (ShadowPass.ts:164-171 semantics), and a texture captured at build time
      // reads the 1x1 placeholder forever

      // The same defect made side B's light shafts read zero from a full atlas

      // Explicit LOD: in the march and PCF loops, under per-pixel If/Break,
      // implicit-LOD sampling is undefined in WGSL and Dawn returns ~zeros

      // textureLoad needs no derivatives, which is why the Nearest placeholder
      // "worked" and the debug views, sampling at top level, were unaffected,
      // and textureSampleLevel(..., 0) has no derivative requirement either
      const shadow = descriptor.mapNode
        .sample(uv)
        .level(float(0))
        .depth(cascadeIndex)
      const distanceToFront = max(
        float(0),
        distanceToTop.sub(shadow.r.div(worldToUnit))
      )
      return min(shadow.b, shadow.g.mul(distanceToFront))
    }
  )

  // the shared selector replaces the last private copy of it, which
  // differed only in where far, intervals and the count came from, and
  // unrolled `descriptor.cascadeCount` at build time

  // This builder is public API (createCloudShadowTransmittance): an external
  // consumer builds it once, and a count change then left it selecting a stale
  // slot for a layer that no longer exists
  const getFadedCascadeIndex = createFadedCascadeIndex({
    viewMatrix,
    cameraNear,
    shadowFar: descriptor.far,
    shadowIntervals: descriptor.intervals,
    cascadeCount: descriptor.cascadeCountNode
  })

  // Cite: clouds.frag:185–219 (PCF with Vogel disk taps)
  const sampleGroundShadowODPCF = Fn(
    ([worldPosition, distanceToTop, radius, cascadeIndex]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'int'>
    ]) => {
      const uv = getShadowUv(
        worldPosition,
        descriptor.matrices.element(cascadeIndex)
      )
      const outOfBounds = uv.x
        .lessThan(0)
        .or(uv.x.greaterThan(1))
        .or(uv.y.lessThan(0))
        .or(uv.y.greaterThan(1))

      const result = float(0).toVar()

      If(outOfBounds, () => {
        result.assign(0)
      })
        .ElseIf(radius.lessThan(0.1), () => {
          result.assign(
            readGroundShadowOpticalDepth(uv, distanceToTop, cascadeIndex)
          )
        })
        .Else(() => {
          const ign = interleavedGradientNoise(
            webglFragCoord(screenCoordinate).add(temporalJitter.mul(resolution))
          ) as unknown as Node<'float'>
          const phi = float(ign).mul(PI2)

          const sum = float(0).toVar()
          Loop(
            { start: 0, end: shadowSampleCount },
            ({ i }: { i: Node<'int'> }) => {
              const offset = vogelDisk(i, float(shadowSampleCount), phi)
              sum.addAssign(
                readGroundShadowOpticalDepth(
                  uv.add(offset.mul(radius).mul(descriptor.texelSize)),
                  distanceToTop,
                  cascadeIndex
                )
              )
            }
          )
          result.assign(sum.div(float(shadowSampleCount)))
        })

      return result
    }
  )

  // Cite: clouds.frag:221–250 (main entry point)
  return Fn(
    ([rayPosition, radius, jitter]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const distanceToTop = getDistanceToShadowTop(
        rayPosition,
        sunDirection,
        bottomRadius,
        descriptor.topHeight
      )

      const result = float(0).toVar()
      If(distanceToTop.greaterThan(0), () => {
        const corrected = rayPosition.sub(altitudeCorrection)
        const worldPosition = ecefToWorldMatrix.mul(
          vec4(corrected.x, corrected.y, corrected.z, 1)
        ).xyz

        const cascadeIndex = getFadedCascadeIndex(worldPosition, jitter)
        If(cascadeIndex.greaterThanEqual(0), () => {
          result.assign(
            sampleGroundShadowODPCF(
              worldPosition,
              distanceToTop,
              radius,
              cascadeIndex
            )
          )
        })
      })

      return result
    }
  )
}

export function createCloudShadowTransmittance(
  descriptor: CloudShadowDescriptor,
  deps: GroundShadowExtraDeps,
  options: { enabled?: boolean; shadowSampleCount?: number } = {}
) {
  const { enabled = true } = options
  if (!enabled || descriptor.cascadeCount === 0) {
    return Fn(
      ([_position, _radius, _jitter]: [
        Node<'vec3'>,
        Node<'float'>,
        Node<'float'>
      ]) => float(1)
    )
  }
  const sampleOD = createSampleCloudShadowOpticalDepth(
    descriptor,
    deps,
    options
  )
  return Fn(
    ([positionECEF, radius, jitter]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      return sampleOD(positionECEF, radius, jitter).negate().exp()
    }
  )
}

// CPU twin for testing

export function cpuReadGroundShadowOpticalDepth(
  shadow: { r: number; g: number; b: number; a: number },
  distanceToTop: number,
  worldToUnit: number
): number {
  const distanceToFront = Math.max(0, distanceToTop - shadow.r / worldToUnit)
  return Math.min(shadow.b, shadow.g * distanceToFront)
}

// CPU twin for the row conversion, so the test can show what the emitted shader
// computes without a GPU
export function webglFragCoordCPU(
  coord: readonly [number, number],
  framebufferHeight: number
): [number, number] {
  return [coord[0], framebufferHeight - coord[1]]
}
