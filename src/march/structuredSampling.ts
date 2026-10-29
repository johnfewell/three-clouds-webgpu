// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Source: structuredSampling.glsl
// Implements Structured Volume Sampling:
// https://github.com/huwb/volsample
// https://www.shadertoy.com/view/ttVfDc

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2015-2016 Huw Bowles, Daniel Zimmermann, Beibei Wang
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
/* eslint-enable no-comment-slop/max-comment-lines */

import {
  abs,
  dot,
  exp,
  float,
  Fn,
  If,
  mix,
  mod,
  sign,
  step,
  struct,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { Node } from 'three/webgpu'

// A = phi / sqrt(2 + phi), B = 1 / sqrt(2 + phi), KT = 1 / phi, KT2 = 1 / phi²
const A = 0.85065080835204
const B = 0.5257311121191336
const KT = 0.6180339887498948
const KT2 = 0.38196601125010515

// structuredSampling.glsl:6–26
// https://www.ppsloan.org/publications/AmbientDice.pdf

// mix+step instead of select, so the gate does not flag "flow outside Fn"
// (these are called from inside a Fn)
function buildIcosahedralVertices(direction: Node<'vec3'>) {
  const absD = abs(direction)
  const selector1 = dot(absD, vec3(1, KT2, -KT))
  const selector2 = dot(absD, vec3(-KT, 1, KT2))
  const selector3 = dot(absD, vec3(KT2, -KT, 1))
  const octant = sign(direction)
  const gt1 = step(float(0), selector1)
  const gt2 = step(float(0), selector2)
  const gt3 = step(float(0), selector3)
  const v1 = mix(vec3(-B, 0, A), vec3(A, B, 0), gt1)
    .mul(octant)
    .toVar()
  const v2 = mix(vec3(A, -B, 0), vec3(0, A, B), gt2)
    .mul(octant)
    .toVar()
  const v3 = mix(vec3(0, A, -B), vec3(B, 0, A), gt3)
    .mul(octant)
    .toVar()
  return { v1, v2, v3 }
}

const sortedVerticesStruct = /*#__PURE__*/ struct(
  { a: 'vec3', b: 'vec3', c: 'vec3' },
  'SortedVertices'
)

// structuredSampling.glsl:36–47
const sortVertices = /*#__PURE__*/ Fn(
  ([aIn, bIn, cIn]: [Node<'vec3'>, Node<'vec3'>, Node<'vec3'>]) => {
    const base = vec3(0.5, 0.5, 1.0)
    const aw = vec4(aIn.x, aIn.y, aIn.z, dot(aIn, base)).toVar()
    const bw = vec4(bIn.x, bIn.y, bIn.z, dot(bIn, base)).toVar()
    const cw = vec4(cIn.x, cIn.y, cIn.z, dot(cIn, base)).toVar()

    // Cite: structuredSampling.glsl:28–34. The strict comparison is
    // load-bearing: equal weights retain their input order in the reference
    const swapIfBigger = (a: Node<'vec4'>, b: Node<'vec4'>) => {
      const previousA = a.toVar()
      If(a.w.greaterThan(b.w), () => {
        a.assign(b)
        b.assign(previousA)
      })
    }

    swapIfBigger(aw, bw)
    swapIfBigger(bw, cw)
    swapIfBigger(aw, bw)

    return sortedVerticesStruct(aw.xyz, bw.xyz, cw.xyz)
  }
)

// structuredSampling.glsl:49–55
function buildPentagonalWeights(
  direction: Node<'vec3'>,
  v1: Node<'vec3'>,
  v2: Node<'vec3'>,
  v3: Node<'vec3'>
) {
  const d1 = dot(v1, direction)
  const d2 = dot(v2, direction)
  const d3 = dot(v3, direction)
  const w = exp(vec3(d1, d2, d3).mul(40))
  return w.div(w.x.add(w.y).add(w.z))
}

// structuredSampling.glsl:57–78
export const getStructureNormal = /*#__PURE__*/ Fn(
  ([direction, jitter]: [Node<'vec3'>, Node<'float'>]) => {
    const verts = buildIcosahedralVertices(direction)
    const sorted = sortVertices(verts.v1, verts.v2, verts.v3)
    const sortedA = sorted.get('a') as Node<'vec3'>
    const sortedB = sorted.get('b') as Node<'vec3'>
    const sortedC = sorted.get('c') as Node<'vec3'>
    const weights = buildPentagonalWeights(direction, sortedA, sortedB, sortedC)
    const normal = sortedA.toVar()
    If(jitter.greaterThanEqual(weights.x), () => {
      If(jitter.lessThan(weights.x.add(weights.y)), () => {
        normal.assign(sortedB)
      }).Else(() => {
        normal.assign(sortedC)
      })
    })
    return normal
  }
)

// structuredSampling.glsl:81–101
// https://github.com/huwb/volsample/blob/master/src/unity/Assets/Shaders/RayMarchCore.cginc
export const intersectStructuredPlanes = /*#__PURE__*/ Fn(
  ([normal, rayOrigin, rayDirection, samplePeriod]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>
  ]) => {
    const NoD = dot(rayDirection, normal)
    const stepSize = samplePeriod.div(abs(NoD))

    const stepOffset = mod(dot(rayOrigin, normal), samplePeriod)
      .negate()
      .div(NoD)
      .toVar()
    If(stepOffset.lessThan(0), () => {
      stepOffset.addAssign(stepSize)
    })

    // (stepOffset, stepSize) packed as vec2, a Fn returns one node
    return vec2(stepOffset, stepSize)
  }
)
