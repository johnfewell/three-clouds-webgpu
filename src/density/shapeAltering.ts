// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.glsl:68–73

import { clamp, Fn, pow, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

export const shapeAlteringFunction = /*#__PURE__*/ Fn(
  ([heightFraction, bias]: [Node<'vec4'>, Node<'vec4'>]) => {
    const biased = pow(heightFraction, bias)
    const x = clamp(biased.mul(2).sub(1), -1, 1)
    return vec4(1).sub(x.mul(x))
  }
)

export function cpuShapeAltering(heightFraction: number, bias: number): number {
  const biased = Math.pow(heightFraction, bias)
  const x = Math.max(-1, Math.min(1, biased * 2 - 1))
  return 1 - x * x
}
