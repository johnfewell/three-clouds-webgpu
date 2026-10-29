// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: shadowResolve.frag (76 lines)

import type { Texture } from 'three'
import {
  float,
  Fn,
  If,
  int,
  ivec2,
  ivec3,
  mix,
  textureLoad,
  texture as tslTexture,
  uv,
  vec4
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

import { varianceClipping } from '../resolve/varianceClipping'
import { buildCascadeSetup } from './opticalDepthMarch'

// Cite: shadow.frag:168–179 (velocity for temporal resolution)

export interface ShadowVelocityDeps {
  // Texture | TextureNode: a live node keeps sampling the current target after
  // it is recreated. textureLoad's clone keeps referenceNode, so .value updates
  // propagate
  odBuffer: Texture | TextureNode
  // the front depth (unit space) when the velocity is computed in the
  // shadow MARCH pass itself, as the reference's shadow.frag:168-179 does in
  // the same draw. Absent, the pass reads it back from odBuffer.
  frontDepthUnit?: Node<'float'>
  inverseShadowMatrix: Node<'mat4'>
  reprojectionMatrix: Node<'mat4'>
  worldToECEFMatrix: Node<'mat4'>
  ecefToWorldMatrix: Node<'mat4'>
  altitudeCorrection: Node<'vec3'>
  sunDirection: Node<'vec3'>
  bottomRadius: Node<'float'>
  shadowTopHeight: Node<'float'>
  // 1 / bottomRadius. The atlas stores front depth in unit space
  // (opticalDepthMarch.ts:278), the reference in metres (shadow.frag:125), and
  // this pass adds it to an ECEF ray in metres, so it converts
  worldToUnit: Node<'float'>
  shadowBottomHeight: Node<'float'>
  resolution: Node<'vec2'>
  cascadeIndex: Node<'float'>
}

export function buildShadowVelocity(deps: ShadowVelocityDeps) {
  return Fn(() => {
    const pixelXY = uv().mul(deps.resolution).floor()
    // pixelXY is float (uv * resolution, floored). TSL's ivec2 constructor
    // emits the i32 conversion itself, so this declares what is already
    // happening rather than inserting a .toInt() node into the graph
    const coord = ivec2(
      pixelXY.x as unknown as Node<'int'>,
      pixelXY.y as unknown as Node<'int'>
    )
    // DataArrayTexture reads: WGSL textureLoad needs the layer as .depth()
    const frontDepthUnit =
      deps.frontDepthUnit ??
      textureLoad(deps.odBuffer, coord, int(0)).depth(deps.cascadeIndex).x

    const clipXY = uv().mul(2).sub(1)
    const setup = buildCascadeSetup(
      clipXY,
      deps.inverseShadowMatrix,
      deps.worldToECEFMatrix,
      deps.altitudeCorrection,
      deps.sunDirection,
      deps.bottomRadius,
      deps.shadowTopHeight,
      deps.shadowBottomHeight
    )

    // Unit space to metres before adding to an ECEF ray, or frontPosition
    // collapses onto the shell entry point. Cite: shadow.frag:170, metres added
    // to metres

    // Static ladder cases cannot see this: with nothing moving the velocity is
    // ~0 whatever frontPosition is
    const frontDepthMetres = frontDepthUnit.div(deps.worldToUnit)
    const frontPosition = setup.rayDirection
      .mul(frontDepthMetres)
      .add(setup.rayOrigin)
    const uncorrected = frontPosition.sub(deps.altitudeCorrection)
    const frontPositionWorld = deps.ecefToWorldMatrix.mul(
      vec4(uncorrected.x, uncorrected.y, uncorrected.z, 1)
    ).xyz

    const prevClip = deps.reprojectionMatrix
      .mul(
        vec4(
          frontPositionWorld.x,
          frontPositionWorld.y,
          frontPositionWorld.z,
          1
        )
      )
      .toVar()
    prevClip.assign(prevClip.div(prevClip.w))
    const prevUv = prevClip.xy.mul(0.5).add(0.5)
    const velocity = uv().sub(prevUv).mul(deps.resolution)

    return vec4(frontDepthUnit, velocity.x, velocity.y, float(0))
  })()
}

// Cite: shadowResolve.frag:32–49 (3×3 closest fragment search)

const NEIGHBOR_OFFSETS: readonly [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 0],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
]

// Cite: shadowResolve.frag:32–49
function getClosestFragment(
  velocityBuffer: Texture | TextureNode,
  coord: Node<'ivec2'>,
  cascadeIndex: Node<'float'>
) {
  return Fn(() => {
    const result = vec4(1e7, 0, 0, 0).toVar()
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const neighborCoord = ivec2(coord.x.add(dx), coord.y.add(dy))
      const neighbor = textureLoad(velocityBuffer, neighborCoord, int(0)).depth(
        cascadeIndex
      )
      If(neighbor.r.lessThan(result.r), () => {
        result.assign(neighbor)
      })
    }
    return result
  })()
}

// Cite: shadowResolve.frag:51–66 (per-cascade temporal resolve)

export interface ShadowResolveDeps {
  // Texture | TextureNode, a live node as in ShadowVelocityDeps
  odBuffer: Texture | TextureNode
  velocityBuffer: Texture | TextureNode
  // A TextureNode so the caller can re-point it after a history swap
  historyBuffer: Texture | TextureNode
  texelSize: Node<'vec2'>
  varianceGamma: Node<'float'>
  temporalAlpha: Node<'float'>
  resolution: Node<'vec2'>
  cascadeIndex: Node<'float'>
}

export function buildShadowCascadeResolve(deps: ShadowResolveDeps) {
  const varianceClip = varianceClipping(deps.odBuffer, {
    samples: 9,
    array: true
  })

  return Fn(() => {
    const pixelXY = uv().mul(deps.resolution).floor()
    // pixelXY is float (uv * resolution, floored). TSL's ivec2 constructor
    // emits the i32 conversion itself, so this declares what is already
    // happening rather than inserting a .toInt() node into the graph
    const coord = ivec2(
      pixelXY.x as unknown as Node<'int'>,
      pixelXY.y as unknown as Node<'int'>
    )
    const current = textureLoad(deps.odBuffer, coord, int(0)).depth(
      deps.cascadeIndex
    )

    const depthVelocity = getClosestFragment(
      deps.velocityBuffer,
      coord,
      deps.cascadeIndex
    )
    const velocity = depthVelocity.toVar().gb.mul(deps.texelSize)
    const prevUv = uv().sub(velocity)

    const outOfBounds = prevUv.x
      .lessThan(0)
      .or(prevUv.x.greaterThan(1))
      .or(prevUv.y.lessThan(0))
      .or(prevUv.y.greaterThan(1))

    const resolved = current.toVar()
    If(outOfBounds.not(), () => {
      // Reprojection rejection is non-uniform. Explicit LOD preserves filtered
      // history without relying on derivatives inside the branch
      const history = tslTexture(deps.historyBuffer, prevUv)
        .level(float(0))
        .depth(deps.cascadeIndex)
      const clipped = varianceClip(
        // Same implicit i32 conversion as `coord` above: cascadeIndex is the
        // float uniform CloudsPassNode provides
        ivec3(coord.x, coord.y, deps.cascadeIndex as unknown as Node<'int'>),
        current,
        history,
        deps.varianceGamma
      )
      resolved.assign(mix(clipped, current, deps.temporalAlpha))
    })

    return resolved
  })()
}

// CPU twins for testing

export function getClosestFragmentCPU(
  velocityData: number[][],
  x: number,
  y: number,
  width: number,
  height: number
): [number, number, number, number] {
  let result: [number, number, number, number] = [1e7, 0, 0, 0]
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
    const idx = ny * width + nx
    const neighbor = velocityData[idx]!
    if (neighbor[0]! < result[0]) {
      result = [neighbor[0]!, neighbor[1]!, neighbor[2]!, neighbor[3]!]
    }
  }
  return result
}

export function shadowCascadeResolveCPU(
  odData: [number, number, number, number][],
  velocityData: number[][],
  historyData: [number, number, number, number][],
  x: number,
  y: number,
  width: number,
  height: number,
  texelSizeX: number,
  texelSizeY: number,
  varianceGamma: number,
  temporalAlpha: number,
  varianceClipFn: (
    current: [number, number, number, number],
    neighbours: [number, number, number, number][],
    history: [number, number, number, number],
    gamma: number
  ) => [number, number, number, number]
): [number, number, number, number] {
  const idx = y * width + x
  const current = odData[idx]!

  const closest = getClosestFragmentCPU(velocityData, x, y, width, height)
  const vx = closest[1] * texelSizeX
  const vy = closest[2] * texelSizeY
  const prevU = (x + 0.5) / width - vx
  const prevV = (y + 0.5) / height - vy

  if (prevU < 0 || prevU > 1 || prevV < 0 || prevV > 1) {
    return [...current]
  }

  const hi = Math.min(Math.floor(prevV * height), height - 1)
  const wi = Math.min(Math.floor(prevU * width), width - 1)
  const histIdx = hi * width + wi
  const history = historyData[histIdx]!

  const neighbours: [number, number, number, number][] = []
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    if (dx === 0 && dy === 0) continue
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
    neighbours.push(odData[ny * width + nx]!)
  }

  const clipped = varianceClipFn(current, neighbours, history, varianceGamma)
  return [
    clipped[0] + (current[0] - clipped[0]) * temporalAlpha,
    clipped[1] + (current[1] - clipped[1]) * temporalAlpha,
    clipped[2] + (current[2] - clipped[2]) * temporalAlpha,
    clipped[3] + (current[3] - clipped[3]) * temporalAlpha
  ]
}
