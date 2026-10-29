// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Based on Sébastien Hillaire's TileableVolumeNoise (MIT, Copyright (c) 2017):
// https://github.com/sebh/TileableVolumeNoise
// Cite: cloudShape.frag:41–78, cloudShapeDetail.frag:41–56

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

import { dot, float, Fn, remap, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { createPerlinFbm, worleyNoise } from './tileableNoise'

// The octave weights, which appear four times across the two generators. They
// sum to 1, which is what keeps each fbm in the same range as its inputs
const WEIGHTS = /*#__PURE__*/ vec3(0.625, 0.25, 0.125)

// Both generators build a four-band Worley fbm that differs only in base cell
// count and band multipliers, so it is factored rather than transcribed twice

// The third band is a two-component dot weighted 0.75/0.25, unlike the other
// two. The asymmetry is the reference's, and regularising it would change the
// output while still looking like cloud shape
function worleyBandFbm(
  point: Node<'vec3'>,
  cellCount: number,
  multipliers: readonly [number, number, number, number]
): Node<'float'> {
  const band = (m: number): Node<'float'> =>
    float(1).sub(worleyNoise(point, float(cellCount * m)))

  const n0 = band(multipliers[0])
  const n1 = band(multipliers[1])
  const n2 = band(multipliers[2])
  const n3 = band(multipliers[3])

  const fbm = vec3(
    dot(vec3(n0, n1, n2), WEIGHTS),
    dot(vec3(n1, n2, n3), WEIGHTS),
    dot(vec2(n2, n3), vec2(0.75, 0.25))
  )
  return dot(fbm, WEIGHTS)
}

const perlinFbm3 = /*#__PURE__*/ createPerlinFbm(3)

// cloudShape's Perlin-Worley term: a 3-octave Perlin at frequency 8, clamped,
// then remapped so its low end lands on a three-band Worley fbm instead of 0,
// which gives the base shape its billowy floor
export const perlinWorley = /*#__PURE__*/ Fn(([point]: [Node<'vec3'>]) => {
  const perlinValue = perlinFbm3(point, vec3(8, 8, 8)).clamp(0, 1)

  const cellCount = 4
  const noise = vec3(
    float(1).sub(worleyNoise(point, float(cellCount * 2))),
    float(1).sub(worleyNoise(point, float(cellCount * 8))),
    float(1).sub(worleyNoise(point, float(cellCount * 14)))
  )
  const fbm = dot(noise, WEIGHTS)

  return remap(perlinValue, float(0), float(1), fbm, float(1))
})

// cloudShape's Worley fbm term: base cell count 4, bands 2/4/8/16
export const worleyFbm = /*#__PURE__*/ Fn(([point]: [Node<'vec3'>]) =>
  worleyBandFbm(point, 4, [2, 4, 8, 16])
)

// The 128³ base shape texture. The final remap is unclamped like the
// reference's: the R8 target clamps on write, and clamping here too would
// change the distribution rather than just its endpoints
export const cloudShape = /*#__PURE__*/ Fn(([point]: [Node<'vec3'>]) =>
  remap(perlinWorley(point), worleyFbm(point).sub(1), float(1))
)

// The 32³ detail texture: base cell count 2, bands 1/2/4/8, no Perlin term
export const cloudShapeDetail = /*#__PURE__*/ Fn(([point]: [Node<'vec3'>]) =>
  worleyBandFbm(point, 2, [1, 2, 4, 8])
)
