// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Based on Sébastien Hillaire's TileableVolumeNoise (MIT, Copyright (c) 2017):
// https://github.com/sebh/TileableVolumeNoise
// Cite: tileableNoise.glsl:28–88

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * The MIT License (MIT)
 *
 * Copyright(c) 2017 Sébastien Hillaire
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

import { float, Fn, mix, sin, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { perlin } from './perlin'

// GLSL `mod` floors, WGSL `%` truncates toward zero. The Worley wrap below
// uses negative indices on every edge cell, where the two disagree, and that
// would show as a seam at the texture border rather than as an error
const glslMod = (x: Node<'vec3'>, y: Node<'float'>): Node<'vec3'> =>
  x.sub(y.mul(x.div(y).floor()))

// `fract(sin(n + 1.951) * 43758.5453)`, the classic sine hash, kept bit-for-bit
// rather than swapped for a modern integer hash, because the baked textures the
// generators fall back to were produced with this one
export const hash = /*#__PURE__*/ Fn(([n]: [Node<'float'>]) =>
  sin(n.add(1.951)).mul(43758.5453).fract()
)

// Value noise on the integer lattice with a smoothstep fade `f * f * (3 - 2f)`,
// not perlin's quintic. The reference's offsets 1, 57, 113 (sums 58, 114, 170,
// 171) encode the eight corners into one hash argument `x + 57y + 113z`
export const valueNoise = /*#__PURE__*/ Fn(([x]: [Node<'vec3'>]) => {
  const p = x.floor()
  const f0 = x.fract()
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)))

  const n = p.x.add(p.y.mul(57)).add(p.z.mul(113))
  const h = (offset: number): Node<'float'> => hash(n.add(offset))

  return mix(
    mix(mix(h(0), h(1), f.x), mix(h(57), h(58), f.x), f.y),
    mix(mix(h(113), h(114), f.x), mix(h(170), h(171), f.x), f.y),
    f.z
  )
})

// Worley (cellular) noise, tileable over the unit cube. The 3x3x3
// neighbourhood unrolls at graph time (fixed -1..1 bounds in the reference)

// `mod(tp, cellCount)` on the feature-cell index gives the wrap: a cell past
// the far edge hashes like its near-edge counterpart. Without it the field
// still looks like Worley noise but seams at the texture border
export const worleyNoise = /*#__PURE__*/ Fn(
  ([p, cellCount]: [Node<'vec3'>, Node<'float'>]) => {
    const cell = p.mul(cellCount)
    const base = cell.floor()

    let d: Node<'float'> = float(1e10)
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const tp = base.add(vec3(x, y, z))
          const jitter = valueNoise(glslMod(tp, cellCount))
          const delta = cell.sub(tp).sub(jitter)
          d = d.min(delta.dot(delta))
        }
      }
    }
    return d.clamp(0, 1)
  }
)

// Fractal Brownian motion over the periodic Perlin, tileable over the unit
// cube. Each octave is `perlin(point * frequency, vec4(frequency, 1))`, so the
// period is exactly 1. A frequency that misses its rep breaks the tiling

// `octaveCount` unrolls at graph time. Frequency factor 2 and roughness 0.5 as
// in the reference, and the sum is deliberately unclamped
export function createPerlinFbm(octaveCount: number) {
  return Fn(([point, frequency]: [Node<'vec3'>, Node<'vec3'>]) => {
    const roughness = 0.5
    const octaveFrequencyFactor = 2

    let sum: Node<'float'> = float(0)
    let weightSum = 0
    let weight = 1
    let next: Node<'vec3'> = frequency

    for (let i = 0; i < octaveCount; i++) {
      const scaled = vec4(point.x, point.y, point.z, 0).mul(vec4(next, 1))
      sum = sum.add(perlin(scaled, vec4(next, 1)).mul(weight))
      weightSum += weight
      weight *= roughness
      next = next.mul(octaveFrequencyFactor)
    }

    return sum.div(weightSum)
  })
}
