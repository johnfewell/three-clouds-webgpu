// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:346-360,545-556 - retain the near march, replace only its fallback

import { float, Fn, If, int, max, remap } from 'three/tsl'
import type { Node } from 'three/webgpu'

export const sunMarchIterationCount = Fn(
  ([maximum, mip, jitter]: [Node<'float'>, Node<'float'>, Node<'float'>]) =>
    int(
      max(
        float(0),
        remap(mip, float(0), float(1), maximum.add(1), float(1)).sub(jitter)
      )
    )
)

export const combineDistantShadow = Fn(
  ([local, coarse, replacement]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => replacement.greaterThanEqual(0).select(replacement, local.add(coarse))
)

export function combineDistantShadowCPU(
  local: number,
  coarse: number,
  replacement: number
): number {
  return replacement >= 0 ? replacement : local + coarse
}

export function createDistantShadowAdjustment(
  sample?: (
    position: Node<'vec3'>,
    distance: Node<'float'>,
    radius: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'float'>
) {
  return Fn(
    ([opticalDepth, position, count, mip, jitter]: [
      Node<'float'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const result = opticalDepth.toVar()
      if (sample != null) {
        If(sunMarchIterationCount(count, mip, jitter).equal(0), () => {
          // Covered map values replace the whole segment, not just the 0.5
          // fallback. An uncovered -1 preserves the local + coarse sum.
          const replacement = sample(position, float(0), float(0), jitter)
          result.assign(
            combineDistantShadow(opticalDepth, float(0), replacement)
          )
        })
      }
      return result
    }
  )
}
