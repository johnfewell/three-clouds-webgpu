// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: @takram/three-geospatial cascadedShadowMaps.glsl (cascade selection)
// Reference: https://github.com/mrdoob/three.js/blob/r171/examples/jsm/csm/CSMShader.js
// https://x.com/shotamatsuda/status/1885322308908442106

import {
  float,
  Fn,
  If,
  int,
  min,
  vec4,
  viewZToOrthographicDepth
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { UniformArrayLike } from '../CloudsPassNode'
import { MAX_CASCADE_COUNT } from './CascadedShadowMaps'

export interface FadedCascadeIndexDeps {
  viewMatrix: Node<'mat4'>
  cameraNear: Node<'float'>
  shadowFar: Node<'float'>
  shadowIntervals: UniformArrayLike<'vec2'>
  // Runtime count, not a graph-time constant. The loop unrolls to
  // MAX_CASCADE_COUNT with a guard per slot, as cascadedShadowMaps.glsl loops
  // to 4 under SHADOW_CASCADE_COUNT

  // Unrolling the count froze consumers at their build-time count, selecting a
  // removed layer through a stale interval
  cascadeCount: Node<'int'>
}

// Selects the cascade a world-space position falls in, dithering across the
// overlap between neighbouring cascades so the seam breaks up into noise
// instead of a hard line

// Each interval is expanded by a margin proportional to its closest edge
// squared. `jitter` against `alpha` picks this or the previous cascade, a
// crossfade over the jitter sequence. -1 means beyond the last cascade

// Shared by both shadow samplers and the cascades debug view, which differ
// only in where `far`, `intervals` and `cascadeCount` come from
export function createFadedCascadeIndex(deps: FadedCascadeIndexDeps) {
  const { viewMatrix } = deps
  const fromViewZ = createFadedCascadeIndexFromViewZ(deps)

  return Fn(([worldPosition, jitter]: [Node<'vec3'>, Node<'float'>]) => {
    // toVar(): evaluated once. Otherwise TSL re-emits it in every unrolled
    // branch, eight mat4 multiplies per shadow sample in both marches' inner
    // loops
    const viewPosition = viewMatrix
      .mul(vec4(worldPosition.x, worldPosition.y, worldPosition.z, 1))
      .toVar()
    return fromViewZ(viewPosition.z, jitter)
  })
}

// The selection itself, from view-space depth. The marches pass a depth from
// one dot product with a pre-composed matrix row, and the wrapper above serves
// consumers that have a position
export function createFadedCascadeIndexFromViewZ(
  deps: Omit<FadedCascadeIndexDeps, 'viewMatrix'>
) {
  const { cameraNear, shadowFar, shadowIntervals, cascadeCount } = deps

  return Fn(([viewZ, jitter]: [Node<'float'>, Node<'float'>]) => {
    const depth = viewZToOrthographicDepth(viewZ, cameraNear, shadowFar).toVar()

    const nextIdx = int(-1).toVar()
    const prevIdx = int(-1).toVar()
    const alpha = float(0).toVar()

    const lastIdx = cascadeCount.sub(1)

    for (let i = 0; i < MAX_CASCADE_COUNT; i++) {
      // Slots at or past the live count hold stale intervals (the descriptor
      // only writes the first `cascadeCount`), so they must not be reachable
      If(int(i).lessThan(cascadeCount), () => {
        const interval = shadowIntervals.element(i)
        const intervalCenter = interval.x.add(interval.y).mul(0.5)
        const closestEdge = depth
          .lessThan(intervalCenter)
          .select(interval.x, interval.y)
        const margin = closestEdge.mul(closestEdge).mul(0.5)
        const expandedNear = interval.x.sub(margin.mul(0.5))
        const expandedFar = interval.y.add(margin.mul(0.5))

        // Which iteration is "last" is now a runtime question, since the count
        // can change under a graph that is not rebuilt
        If(int(i).equal(lastIdx), () => {
          // Don't fade out the last cascade (cascadedShadowMaps.glsl)
          If(depth.greaterThanEqual(expandedNear), () => {
            prevIdx.assign(nextIdx)
            nextIdx.assign(i)
            alpha.assign(depth.sub(expandedNear).div(margin).clamp(0, 1))
          })
        }).Else(() => {
          If(
            depth
              .greaterThanEqual(expandedNear)
              .and(depth.lessThan(expandedFar)),
            () => {
              prevIdx.assign(nextIdx)
              nextIdx.assign(i)
              alpha.assign(
                min(depth.sub(expandedNear), expandedFar.sub(depth))
                  .div(margin)
                  .clamp(0, 1)
              )
            }
          )
        })
      })
    }

    return jitter.lessThanEqual(alpha).select(nextIdx, prevIdx)
  })
}
