// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:113–137, 172–250 (shadow sampling + PCF)
// Cite: @takram/three-geospatial cascadedShadowMaps.glsl (cascade selection)
// https://x.com/shotamatsuda/status/1885322308908442106

import {
  float,
  Fn,
  If,
  Loop,
  max,
  min,
  screenCoordinate,
  vec2,
  vec4
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

import {
  interleavedGradientNoise,
  raySphereIntersection
} from '@takram/three-geospatial/webgpu'

import type { UniformArrayLike } from '../CloudsPassNode'
import {
  createFadedCascadeIndex,
  createFadedCascadeIndexFromViewZ
} from './fadedCascadeIndex'

const PI2 = Math.PI * 2

// Cite: core GLSL chunk vogelDisk from @takram/three-geospatial
// Reference: https://www.gamedev.net/tutorials/programming/graphics/contact-hardening-soft-shadows-made-fast-r4906/
export const vogelDisk = /*#__PURE__*/ Fn(
  ([index, sampleCount, phi]: [
    Node<'int'> | Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const goldenAngle = float(2.3999632297286535)
    const r = float(index).add(0.5).sqrt().div(float(sampleCount).sqrt())
    const theta = float(index).mul(goldenAngle).add(phi)
    return vec2(r.mul(theta.cos()), r.mul(theta.sin()))
  }
)

// clouds.frag:113–117
export const getShadowUv = /*#__PURE__*/ Fn(
  ([worldPosition, shadowMatrix]: [Node<'vec3'>, Node<'mat4'>]) => {
    const clip = shadowMatrix
      .mul(vec4(worldPosition.x, worldPosition.y, worldPosition.z, 1))
      .toVar()
    clip.assign(clip.div(clip.w))
    return clip.xy.mul(0.5).add(0.5)
  }
)

// clouds.frag:119–128
export const getDistanceToShadowTop = /*#__PURE__*/ Fn(
  ([rayPosition, sunDirection, bottomRadius, shadowTopHeight]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const result = raySphereIntersection(
      rayPosition,
      sunDirection,
      float(0),
      bottomRadius.add(shadowTopHeight)
    )
    return result.y
  }
)

export interface ShadowSamplerDeps {
  // The atlas as a LIVE handle. Must be a TextureNode whose .value follows the
  // shadow-target swap. A raw Texture captured here goes stale the moment the
  // pass reassigns its output
  shadowBuffer: TextureNode
  shadowTexelSize: Node<'vec2'>
  shadowIntervals: UniformArrayLike<'vec2'>
  shadowMatrices: UniformArrayLike<'mat4'>
  shadowFar: Node<'float'>
  viewMatrix: Node<'mat4'>
  cameraNear: Node<'float'>
  sunDirection: Node<'vec3'>
  bottomRadius: Node<'float'>
  shadowTopHeight: Node<'float'>
  ecefToWorldMatrix: Node<'mat4'>
  altitudeCorrection: Node<'vec3'>
  worldToUnit: Node<'float'>
  temporalJitter: Node<'vec2'>
  resolution: Node<'vec2'>
  // Runtime count, see FadedCascadeIndexDeps.cascadeCount
  cascadeCount: Node<'int'>
  shadowSampleCount: number
  // Pre-composed per frame on the CPU (CloudsPassNode.updateCloudShadowDescriptor):
  //   shadowFromECEFMatrices[i] = shadowMatrices[i] * ecefToWorld * T(-altitudeCorrection)
  //   viewZFromECEF = row 2 of viewMatrix * ecefToWorld * T(-altitudeCorrection)

  // A shadow sample then costs one mat4 and one dot product on the ECEF
  // position instead of three mat4 products, in the innermost loop of both
  // marches. Same maths, composed once in double precision, not per sample

  // Both are optional: without them each sample takes the slow path, through
  // ecefToWorld, view and shadow matrices in turn
  shadowFromECEFMatrices?: UniformArrayLike<'mat4'>
  viewZFromECEF?: Node<'vec4'>
}

export function createSampleShadowOpticalDepth(
  deps: ShadowSamplerDeps,
  outsideValue = 0
) {
  const {
    shadowBuffer,
    shadowTexelSize,
    shadowIntervals,
    shadowMatrices,
    shadowFar,
    viewMatrix,
    cameraNear,
    sunDirection,
    bottomRadius,
    shadowTopHeight,
    ecefToWorldMatrix,
    altitudeCorrection,
    worldToUnit,
    temporalJitter,
    resolution,
    cascadeCount,
    shadowSampleCount,
    shadowFromECEFMatrices,
    viewZFromECEF
  } = deps
  const composed =
    shadowFromECEFMatrices != null && viewZFromECEF != null
      ? { shadowFromECEFMatrices, viewZFromECEF }
      : null

  // clouds.frag:172–183
  // r: frontDepth (unit space), g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail
  const readShadowOpticalDepth = Fn(
    ([uv, distanceToTop, distanceOffset, cascadeIndex]: [
      Node<'vec2'>,
      Node<'float'>,
      Node<'float'>,
      Node<'int'>
    ]) => {
      // Explicit LOD: in the march and PCF loops, under per-pixel If/Break,
      // implicit-LOD sampling is undefined in WGSL and Dawn returns ~zeros

      // textureLoad needs no derivatives, which is why the Nearest placeholder
      // "worked" and the debug views, sampling at top level, were unaffected,
      // and textureSampleLevel(..., 0) has no derivative requirement either
      const shadow = shadowBuffer.sample(uv).level(float(0)).depth(cascadeIndex)
      // AUDIT-4: atlas .r is in unit space (ADR-006 "UNITS"), convert back
      const distanceToFront = max(
        float(0),
        distanceToTop.sub(distanceOffset).sub(shadow.r.div(worldToUnit))
      )
      return min(shadow.b.add(shadow.a), shadow.g.mul(distanceToFront))
    }
  )

  // one shared cascade selector instead of a private copy. Three
  // copies meant three places for the cascade contract to drift, and a copy
  // that only read element(0) would still compile and score
  const getFadedCascadeIndex = createFadedCascadeIndex({
    viewMatrix,
    cameraNear,
    shadowFar,
    shadowIntervals,
    cascadeCount
  })
  const getFadedCascadeIndexFromViewZ = createFadedCascadeIndexFromViewZ({
    cameraNear,
    shadowFar,
    shadowIntervals,
    cascadeCount
  })

  // clouds.frag:185–219
  // `position` is the world position on the slow path and the ECEF ray
  // position on the composed path, and the matrix it is multiplied by matches
  const sampleShadowOpticalDepthPCF = Fn(
    ([position, distanceToTop, distanceOffset, radius, cascadeIndex]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>,
      Node<'int'>
    ]) => {
      const uv = getShadowUv(
        position,
        (composed?.shadowFromECEFMatrices ?? shadowMatrices).element(
          cascadeIndex
        )
      )
      const outOfBounds = uv.x
        .lessThan(0)
        .or(uv.x.greaterThan(1))
        .or(uv.y.lessThan(0))
        .or(uv.y.greaterThan(1))

      const result = float(0).toVar()

      If(outOfBounds, () => {
        result.assign(outsideValue)
      })
        .ElseIf(radius.lessThan(0.1), () => {
          result.assign(
            readShadowOpticalDepth(
              uv,
              distanceToTop,
              distanceOffset,
              cascadeIndex
            )
          )
        })
        .Else(() => {
          // @takram/three-geospatial/webgpu declares its own Node type,
          // structurally distinct from three/webgpu's. This is the package
          // boundary, not a loss of type information
          const ign = interleavedGradientNoise(
            screenCoordinate.xy.add(temporalJitter.mul(resolution))
          ) as unknown as Node<'float'>
          const phi = float(ign).mul(PI2)

          const sum = float(0).toVar()
          Loop(
            { start: 0, end: shadowSampleCount },
            ({ i }: { i: Node<'int'> }) => {
              const offset = vogelDisk(i, float(shadowSampleCount), phi)
              sum.addAssign(
                readShadowOpticalDepth(
                  uv.add(offset.mul(radius).mul(shadowTexelSize)),
                  distanceToTop,
                  distanceOffset,
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

  // clouds.frag:221–250
  return Fn(
    ([rayPosition, distanceOffset, radius, jitter]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const distanceToTop = getDistanceToShadowTop(
        rayPosition,
        sunDirection,
        bottomRadius,
        shadowTopHeight
      )

      const result = float(outsideValue).toVar()
      If(distanceToTop.greaterThan(0), () => {
        if (composed != null) {
          const viewZ = composed.viewZFromECEF.dot(
            vec4(rayPosition.x, rayPosition.y, rayPosition.z, 1)
          )
          const cascadeIndex = getFadedCascadeIndexFromViewZ(viewZ, jitter)
          If(cascadeIndex.greaterThanEqual(0), () => {
            result.assign(
              sampleShadowOpticalDepthPCF(
                rayPosition,
                distanceToTop,
                distanceOffset,
                radius,
                cascadeIndex
              )
            )
          })
          return
        }
        // clouds.frag:109–111 ecefToWorld
        // toVar(): see fadedCascadeIndex. `worldPosition` is used by the
        // cascade selection and the shadow-uv transform, per shadow sample
        const corrected = rayPosition.sub(altitudeCorrection).toVar()
        const worldPosition = ecefToWorldMatrix
          .mul(vec4(corrected.x, corrected.y, corrected.z, 1))
          .xyz.toVar()

        const cascadeIndex = getFadedCascadeIndex(worldPosition, jitter)
        If(cascadeIndex.greaterThanEqual(0), () => {
          result.assign(
            sampleShadowOpticalDepthPCF(
              worldPosition,
              distanceToTop,
              distanceOffset,
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

// CPU twin for testing

export function cpuVogelDisk(
  index: number,
  sampleCount: number,
  phi: number
): [number, number] {
  const goldenAngle = 2.3999632297286535
  const r = Math.sqrt(index + 0.5) / Math.sqrt(sampleCount)
  const theta = index * goldenAngle + phi
  return [r * Math.cos(theta), r * Math.sin(theta)]
}

export function cpuReadShadowOpticalDepth(
  shadow: { r: number; g: number; b: number; a: number },
  distanceToTop: number,
  distanceOffset: number,
  worldToUnit: number
): number {
  const distanceToFront = Math.max(
    0,
    distanceToTop - distanceOffset - shadow.r / worldToUnit
  )
  return Math.min(shadow.b + shadow.a, shadow.g * distanceToFront)
}

export function cpuGetFadedCascadeIndex(
  depth: number,
  intervals: Array<[number, number]>,
  jitter: number
): number {
  let nextIndex = -1
  let prevIndex = -1
  let alpha = 0

  for (let i = 0; i < intervals.length; i++) {
    const [start, end] = intervals[i]!
    const intervalCenter = (start + end) * 0.5
    const closestEdge = depth < intervalCenter ? start : end
    const margin = closestEdge * closestEdge * 0.5
    const expandedNear = start - margin * 0.5
    const expandedFar = end + margin * 0.5

    if (i < intervals.length - 1) {
      if (depth >= expandedNear && depth < expandedFar) {
        prevIndex = nextIndex
        nextIndex = i
        alpha = Math.min(
          Math.max(
            Math.min(depth - expandedNear, expandedFar - depth) / margin,
            0
          ),
          1
        )
      }
    } else {
      if (depth >= expandedNear) {
        prevIndex = nextIndex
        nextIndex = i
        alpha = Math.min(Math.max((depth - expandedNear) / margin, 0), 1)
      }
    }
  }

  return jitter <= alpha ? nextIndex : prevIndex
}

export function cpuInterleavedGradientNoise(x: number, y: number): number {
  return (((x * 0.06711056 + y * 0.00583715) % 1) * 52.9829189) % 1
}
