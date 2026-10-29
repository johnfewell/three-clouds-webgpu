import type { Camera } from 'three'
import { float, Fn, uv, vec4 } from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

export function createManualAerialShadow(
  camera: Camera,
  depth: TextureNode,
  sampleShadow: (
    position: Node<'vec3'>,
    options: { radius: Node<'float'>; jitter: Node<'float'> }
  ) => Node<'float'>
): Node<'float'> {
  return Fn(() => {
    const sample = depth.r.toConst()
    const positionView = screenToPositionView(
      uv(),
      sample,
      depthToViewZ(sample, camera),
      projectionMatrix(camera),
      inverseProjectionMatrix(camera)
    ) as unknown as Node<'vec3'>
    const positionWorld = (
      inverseViewMatrix(camera) as unknown as Node<'mat4'>
    ).mul(vec4(positionView, 1)).xyz
    return sampleShadow(positionWorld, {
      radius: float(0),
      jitter: float(0)
    })
  })()
}
