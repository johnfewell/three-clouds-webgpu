// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.glsl:1–5 (original sampling)
// Cite: reference/core-webgpu/stbn-texture-node:66–70 (same division pattern)

import type { Data3DTexture } from 'three'
import {
  Fn,
  int,
  screenCoordinate,
  screenSize,
  texture3D,
  vec2,
  vec3
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

// The reference indexes blue noise by gl_FragCoord (rows bottom-up), three's
// screenCoordinate is top-down. Screen-space passes index by this instead (jg7u,
// ADR-013 Amendment 5). Light-space passes keep screenCoordinate
export const referenceFragCoord = (): Node<'vec2'> =>
  vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y))

// Takes a texture or a TextureNode. The pass hands a node re-synced from
// CloudsContext.stbnTexture each frame, so a later swap needs no rebuild. A raw
// Data3DTexture is captured at build time

// `frame` may be float or int, the body wraps it in int(). Dimensions are read
// once: every accepted jitter volume is 128×128×64
export function getSTBN(
  stbnTexture: Data3DTexture | TextureNode,
  frame: Node<'float'> | Node<'int'>,
  coordinate: Node<'vec2'> = screenCoordinate.xy,
  name: string = 'stbn'
): Node<'float'> {
  const stbn =
    'isTextureNode' in stbnTexture ? stbnTexture : texture3D(stbnTexture)
  const { width, height, depth } = (stbn.value as Data3DTexture).image
  // vec3 uv: keep the 2D uv-matrix transform off (JoinNode arity)
  stbn.updateMatrix = false
  return Fn(() => {
    return stbn
      .sample(
        vec3(coordinate, int(frame).mod(depth)).div(vec3(width, height, depth))
      )
      .r.toConst(name)
  }).once()()
}
