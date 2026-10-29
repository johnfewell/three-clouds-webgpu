// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: clouds.glsl:105–110

import { Fn } from 'three/tsl'
import type { Node } from 'three/webgpu'

export const getLayerDensity = /*#__PURE__*/ Fn(
  ([heightFraction, expTerms, exponents, linearTerms, constantTerms]: [
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>
  ]) => {
    return expTerms
      .mul(exponents.mul(heightFraction).exp())
      .add(linearTerms.mul(heightFraction))
      .add(constantTerms)
  }
)

export function getLayerDensityCPU(
  heightFraction: number,
  expTerm: number,
  exponent: number,
  linearTerm: number,
  constantTerm: number
): number {
  return (
    expTerm * Math.exp(exponent * heightFraction) +
    linearTerm * heightFraction +
    constantTerm
  )
}
