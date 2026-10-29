// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: @takram/three-atmosphere build/shared.js:326-355 (getShadowRadius),
// and the clouds port owns this consumer, so it carries the clouds attribution

// Per-pixel PCF radius: a one-texel shadow offset projected to screen space and
// remapped onto [0, shadowRadius]. Radius 0 degrades through the Vogel disk,
// with no point-sample short-circuit

// A hard-coded 0 made side B's shadows hard where side A's are soft

import { Vector2, Vector3, type Matrix4 } from 'three'
import { float, Fn, length, max, remapClamp, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { UniformArrayLike } from '../CloudsPassNode'

// Cite: shared.js:730 `new Uniform(3)`. The clouds reference never overrides
// it, so 3 is the value in play
export const DEFAULT_SHADOW_RADIUS = 3

// The screen-space footprint band the radius is remapped from, in pixels
// Cite: shared.js:355 `remapClamped(size, 10.0, 50.0, 0.0, shadowRadius)`
const MIN_FOOTPRINT_PX = 10
export const MAX_FOOTPRINT_PX = 50

export interface ShadowRadiusDeps {
  // Cascade 0 only: the reference measures the footprint in the tightest
  // cascade and applies it to every tap
  shadowMatrices: UniformArrayLike<'mat4'>
  inverseShadowMatrices: UniformArrayLike<'mat4'>
  shadowMapSize: Node<'vec2'>
  projectionMatrix: Node<'mat4'>
  viewMatrix: Node<'mat4'>
  resolution: Node<'vec2'>
  shadowRadius: Node<'float'>
}

export function createGetShadowRadius(deps: ShadowRadiusDeps) {
  const {
    shadowMatrices,
    inverseShadowMatrices,
    shadowMapSize,
    projectionMatrix,
    viewMatrix,
    resolution,
    shadowRadius
  } = deps

  return /*#__PURE__*/ Fn(([worldPosition]: [Node<'vec3'>]) => {
    const clip = shadowMatrices
      .element(0)
      .mul(vec4(worldPosition.x, worldPosition.y, worldPosition.z, 1))
      .toVar()
    clip.assign(clip.div(clip.w))

    // Offset by 1px in each direction in shadow clip coordinates. The 2.0 is
    // the clip-space width (-1..1) divided by the texel count
    const offset = vec3(
      float(2).div(shadowMapSize.x),
      float(2).div(shadowMapSize.y),
      0
    )
    const clipX = vec4(clip.x.add(offset.x), clip.y, clip.z, clip.w)
    const clipY = vec4(clip.x, clip.y.add(offset.y), clip.z, clip.w)

    const worldX = inverseShadowMatrices.element(0).mul(clipX)
    const worldY = inverseShadowMatrices.element(0).mul(clipY)

    const viewProjection = projectionMatrix.mul(viewMatrix)
    const projected = viewProjection
      .mul(vec4(worldPosition.x, worldPosition.y, worldPosition.z, 1))
      .toVar()
    const projectedX = viewProjection.mul(worldX).toVar()
    const projectedY = viewProjection.mul(worldY).toVar()
    projected.assign(projected.div(projected.w))
    projectedX.assign(projectedX.div(projectedX.w))
    projectedY.assign(projectedY.div(projectedY.w))

    // Take the mean of pixel sizes
    const center = projected.xy.mul(0.5).add(0.5).mul(resolution)
    const offsetX = projectedX.xy.mul(0.5).add(0.5).mul(resolution)
    const offsetY = projectedY.xy.mul(0.5).add(0.5).mul(resolution)
    const size = max(length(offsetX.sub(center)), length(offsetY.sub(center)))

    return remapClamp(
      size,
      float(MIN_FOOTPRINT_PX),
      float(MAX_FOOTPRINT_PX),
      float(0),
      shadowRadius
    )
  })
}

// CPU twin for testing

export function remapClampedCPU(
  x: number,
  min1: number,
  max1: number,
  min2: number,
  max2: number
): number {
  const t = (x - min1) / (max1 - min1)
  return min2 + Math.min(Math.max(t, 0), 1) * (max2 - min2)
}

// The footprint→radius law, independent of the projection maths: this is the
// half a wrong radius would come from
export function shadowRadiusFromFootprintCPU(
  sizePx: number,
  shadowRadius: number = DEFAULT_SHADOW_RADIUS
): number {
  return remapClampedCPU(
    sizePx,
    MIN_FOOTPRINT_PX,
    MAX_FOOTPRINT_PX,
    0,
    shadowRadius
  )
}

export interface ShadowRadiusFootprint {
  // One shadow texel, in screen pixels
  readonly sizePx: number
  // remapClamp(sizePx, 10, 50, 0, shadowRadius)
  readonly radius: number
  // The same offset in metres, the cascade's texel world size
  readonly worldSizeMetres: number
}

// The whole projection, not just the remap: the twin above cannot see a wrong
// CASCADE, because the footprint is a cascade texel and the shadow range
// decides it
export function shadowRadiusFromCascadeCPU(
  worldPosition: Vector3,
  shadowMatrix: Matrix4,
  inverseShadowMatrix: Matrix4,
  shadowMapSize: Vector2,
  viewProjection: Matrix4,
  resolution: Vector2,
  shadowRadius: number = DEFAULT_SHADOW_RADIUS
): ShadowRadiusFootprint {
  const clip = new Vector3()
  const m = shadowMatrix.elements
  const w =
    m[3] * worldPosition.x +
    m[7] * worldPosition.y +
    m[11] * worldPosition.z +
    m[15]
  const nx =
    (m[0] * worldPosition.x +
      m[4] * worldPosition.y +
      m[8] * worldPosition.z +
      m[12]) /
    w
  const ny =
    (m[1] * worldPosition.x +
      m[5] * worldPosition.y +
      m[9] * worldPosition.z +
      m[13]) /
    w
  const nz =
    (m[2] * worldPosition.x +
      m[6] * worldPosition.y +
      m[10] * worldPosition.z +
      m[14]) /
    w
  clip.set(nx, ny, nz)

  const im = inverseShadowMatrix.elements
  const unproject = (dx: number, dy: number): Vector3 =>
    new Vector3(
      im[0] * (clip.x + dx) + im[4] * (clip.y + dy) + im[8] * clip.z + im[12],
      im[1] * (clip.x + dx) + im[5] * (clip.y + dy) + im[9] * clip.z + im[13],
      im[2] * (clip.x + dx) + im[6] * (clip.y + dy) + im[10] * clip.z + im[14]
    )
  const worldX = unproject(2 / shadowMapSize.x, 0)
  const worldY = unproject(0, 2 / shadowMapSize.y)
  const worldSizeMetres = worldX.distanceTo(worldPosition)

  const e = viewProjection.elements
  const project = (p: Vector3): Vector2 => {
    const px = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]
    const py = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]
    const pw = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15]
    return new Vector2((px / pw) * 0.5 + 0.5, (py / pw) * 0.5 + 0.5).multiply(
      resolution
    )
  }
  const center = project(worldPosition)
  const sizePx = Math.max(
    project(worldX).distanceTo(center),
    project(worldY).distanceTo(center)
  )
  return {
    sizePx,
    radius: shadowRadiusFromFootprintCPU(sizePx, shadowRadius),
    worldSizeMetres
  }
}
