// Vendored from three-geospatial storybook-webgpu/src/worker/tasks/computeCreasedNormalAttribute.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim.

import {
  BufferAttribute,
  BufferGeometry,
  Vector3,
  type InterleavedBufferAttribute,
  type TypedArray
} from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

import { Transfer, type TransferResult } from '../transfer'

export interface BufferAttributeLike {
  array: TypedArray
  itemSize: number
  normalized?: boolean
}

export function toBufferAttributeLike(
  attribute: BufferAttribute | InterleavedBufferAttribute
): [BufferAttributeLike, ArrayBufferLike[]] {
  const result = {
    array: attribute.array.slice(),
    itemSize: attribute.itemSize,
    normalized: attribute.normalized
  }
  return [result, [result.array.buffer]]
}

export function fromBufferAttributeLike(
  input: BufferAttributeLike
): BufferAttribute {
  return new BufferAttribute(input.array, input.itemSize, input.normalized)
}

export function computeCreasedNormalAttribute(
  position: BufferAttributeLike,
  creaseAngle?: number
): TransferResult<BufferAttributeLike> {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', fromBufferAttributeLike(position))
  const resultGeometry = toCreasedNormals(geometry, creaseAngle)

  // Triangles can be degenerate lines, producing zero normals and eventually
  // causing NaN values under SH. Fix this by replacing them with a non-zero
  // normal (they are hardly visible because they are degenerate).
  // See: https://github.com/takram-design-engineering/three-geospatial/issues/13
  const normal = resultGeometry.getAttribute('normal')
  const v0 = new Vector3()
  const v1 = new Vector3()
  const v2 = new Vector3()
  for (let i = 0; i < normal.count; i += 3) {
    v0.fromBufferAttribute(normal, i + 0)
    v1.fromBufferAttribute(normal, i + 1)
    v2.fromBufferAttribute(normal, i + 2)
    if (v0.length() < 0.5 || v1.length() < 0.5 || v2.length() < 0.5) {
      normal.setXYZ(i + 0, 0, 0, 1)
      normal.setXYZ(i + 1, 0, 0, 1)
      normal.setXYZ(i + 2, 0, 0, 1)
    }
  }

  return Transfer(...toBufferAttributeLike(normal))
}
