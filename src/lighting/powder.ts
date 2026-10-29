// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Source: clouds.frag:581–583
// Always applied (uniform-driven, no graph-time variant): the term is identity
// when powderScale = 0, so no perf cost to skip the branch. Fewer shader
// variants outweighs the ~0 cost of one exp + mul per step

import { float, Fn } from 'three/tsl'
import type { Node } from 'three/webgpu'

// 1 − powderScale · exp(−extinction · powderExponent)
// powderScale default 0.8, powderExponent default 150
export const powderTerm = /*#__PURE__*/ Fn(
  ([extinction, powderScale, powderExponent]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    return float(1).sub(
      powderScale.mul(extinction.negate().mul(powderExponent).exp())
    )
  }
)
