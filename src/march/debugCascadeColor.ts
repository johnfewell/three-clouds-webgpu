// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:139–169 (DEBUG_SHOW_CASCADES, getFadedCascadeColor)

import { Fn, If, int, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// clouds.frag:141–146, one colour per cascade, in cascade order
const CASCADE_COLORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0]
]

// The original returns white for a position outside every cascade
// (clouds.frag:167 `cascadeIndex >= 0 ? cascadeColors[cascadeIndex] : vec3(1.0)`).
const OUT_OF_RANGE_COLOR: readonly [number, number, number] = [1, 1, 1]

export interface DebugCascadeColorDeps {
  getFadedCascadeIndex: (
    worldPosition: Node<'vec3'>,
    jitter: Node<'float'>
  ) => Node<'int'>
  ecefToWorldMatrix: Node<'mat4'>
  altitudeCorrection: Node<'vec3'>
  // Unrolled at graph time, so this is a JS number, not a node
  cascadeCount: number
}

// Colours a march position by the shadow cascade that covers it, the
// DEBUG_SHOW_CASCADES view

// TSL cannot index a constant array by a node, so `cascadeColors[cascadeIndex]`
// unrolls into a comparison chain over the `cascadeCount` colours. It exists
// only when `debug === 'cascades'`
export function createDebugCascadeColor(deps: DebugCascadeColorDeps) {
  const {
    getFadedCascadeIndex,
    ecefToWorldMatrix,
    altitudeCorrection,
    cascadeCount
  } = deps

  return Fn(([rayPosition, jitter]: [Node<'vec3'>, Node<'float'>]) => {
    // Same ECEF -> world convention the shadow samplers use: undo the altitude
    // correction before the matrix, since the correction lives in ECEF
    const corrected = rayPosition.sub(altitudeCorrection)
    const worldPosition = ecefToWorldMatrix.mul(
      vec4(corrected.x, corrected.y, corrected.z, 1)
    ).xyz

    const cascadeIndex = getFadedCascadeIndex(worldPosition, jitter)
    const color = vec3(
      OUT_OF_RANGE_COLOR[0],
      OUT_OF_RANGE_COLOR[1],
      OUT_OF_RANGE_COLOR[2]
    ).toVar()

    const count = Math.min(cascadeCount, CASCADE_COLORS.length)
    for (let i = 0; i < count; i++) {
      const rgb = CASCADE_COLORS[i]!
      // int(i), not the bare JS number: WGSL has no `i32 == abstract-float`
      // overload, and the failed compile takes the whole CloudsPass pipeline
      // with it (found on hardware)
      If(cascadeIndex.equal(int(i)), () => {
        color.assign(vec3(rgb[0], rgb[1], rgb[2]))
      })
    }

    return color
  })
}
