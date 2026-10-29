// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: varianceClipping.glsl (114 lines)
// clipAABB is Playdead's, transliterated variable name for variable name
// Reference: https://github.com/playdeadgames/temporal
// Reference: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * The MIT License (MIT)
 *
 * Copyright (c) [2015] [Playdead]
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

import type { Texture } from 'three'
import {
  abs,
  clamp,
  float,
  Fn,
  If,
  int,
  ivec2,
  max,
  sqrt,
  texture,
  textureLoad,
  textureSize,
  vec2,
  vec4
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

// varianceClipping.glsl:19–30
export const clipAABB = /*#__PURE__*/ Fn(
  ([current, history, minColor, maxColor]: [
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>
  ]) => {
    const pClip = maxColor.xyz.add(minColor.xyz).mul(0.5)
    const eClip = maxColor.xyz.sub(minColor.xyz).mul(0.5).add(1e-7)
    const vClip = history.sub(vec4(pClip.x, pClip.y, pClip.z, current.w))
    const vUnit = vClip.xyz.div(eClip)
    const aUnit = abs(vUnit)
    const maUnit = max(aUnit.x, max(aUnit.y, aUnit.z))
    const result = history.toVar()
    If(maUnit.greaterThan(1), () => {
      result.assign(
        vec4(pClip.x, pClip.y, pClip.z, current.w).add(vClip.div(maUnit))
      )
    })
    return result
  }
)

export const OFFSETS_9 = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
] as const

export const OFFSETS_4 = [
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
] as const

// CPU twin for clipAABB
export function clipAABBCPU(
  current: [number, number, number, number],
  history: [number, number, number, number],
  minColor: [number, number, number, number],
  maxColor: [number, number, number, number]
): [number, number, number, number] {
  const pClip = [
    0.5 * (maxColor[0] + minColor[0]),
    0.5 * (maxColor[1] + minColor[1]),
    0.5 * (maxColor[2] + minColor[2])
  ]
  const eClip = [
    0.5 * (maxColor[0] - minColor[0]) + 1e-7,
    0.5 * (maxColor[1] - minColor[1]) + 1e-7,
    0.5 * (maxColor[2] - minColor[2]) + 1e-7
  ]
  const vClip = [
    history[0] - pClip[0]!,
    history[1] - pClip[1]!,
    history[2] - pClip[2]!,
    history[3] - current[3]
  ]
  const vUnit = [
    vClip[0]! / eClip[0]!,
    vClip[1]! / eClip[1]!,
    vClip[2]! / eClip[2]!
  ]
  const aUnit = vUnit.map(Math.abs)
  const maUnit = Math.max(aUnit[0]!, aUnit[1]!, aUnit[2]!)
  if (maUnit > 1) {
    return [
      pClip[0]! + vClip[0]! / maUnit,
      pClip[1]! + vClip[1]! / maUnit,
      pClip[2]! + vClip[2]! / maUnit,
      current[3] + vClip[3]! / maUnit
    ]
  }
  return [...history]
}

// CPU twin for varianceClipping math (without texture sampling)
export function varianceClippingCPU(
  current: [number, number, number, number],
  neighbours: [number, number, number, number][],
  history: [number, number, number, number],
  gamma: number
): [number, number, number, number] {
  const N = neighbours.length + 1
  const m1: [number, number, number, number] = [...current]
  const m2: [number, number, number, number] = [
    current[0] * current[0],
    current[1] * current[1],
    current[2] * current[2],
    current[3] * current[3]
  ]
  for (const n of neighbours) {
    for (let c = 0; c < 4; c++) {
      const nc = n[c]!
      m1[c] = m1[c]! + nc
      m2[c] = m2[c]! + nc * nc
    }
  }
  const mean: [number, number, number, number] = [0, 0, 0, 0]
  const vg: [number, number, number, number] = [0, 0, 0, 0]
  const minC: [number, number, number, number] = [0, 0, 0, 0]
  const maxC: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    mean[c] = m1[c]! / N
    vg[c] = Math.sqrt(Math.max(m2[c]! / N - mean[c]! * mean[c]!, 0)) * gamma
    minC[c] = mean[c]! - vg[c]!
    maxC[c] = mean[c]! + vg[c]!
  }
  const clamped: [number, number, number, number] = [
    Math.max(minC[0], Math.min(maxC[0], mean[0])),
    Math.max(minC[1], Math.min(maxC[1], mean[1])),
    Math.max(minC[2], Math.min(maxC[2], mean[2])),
    Math.max(minC[3], Math.min(maxC[3], mean[3]))
  ]
  return clipAABBCPU(clamped, history, minC, maxC)
}

export interface VarianceClippingOptions {
  samples?: 4 | 9
  array?: boolean
}

// varianceClipping.glsl:42–68, texelFetch variant, graph-time unrolled
export function varianceClipping(
  // Texture | TextureNode: callers pass a live node when the underlying render
  // target can be recreated (wh9a). textureLoad below delegates to texture(),
  // which keeps a TextureNode argument tracking its base via referenceNode
  inputBuffer: Texture | TextureNode,
  options: VarianceClippingOptions = {}
) {
  const { samples = 9, array = false } = options
  const offsets = samples === 9 ? OFFSETS_9 : OFFSETS_4

  return /*#__PURE__*/ Fn(
    ([coord, current, history, gamma]: [
      // ivec2 for 2D textures, ivec3 when sampling an array layer. Only .x/.y
      // are read either way: an array texture takes its layer through .depth()
      Node<'ivec2'> | Node<'ivec3'>,
      Node<'vec4'>,
      Node<'vec4'>,
      Node<'float'>
    ]) => {
      const moment1 = current.toVar()
      const moment2 = current.mul(current).toVar()

      for (const [dx, dy] of offsets) {
        // Array textures: the layer goes in .depth(), coords stay 2D (WGSL textureLoad)
        const offsetCoord = ivec2(coord.x.add(dx), coord.y.add(dy))
        // `array` is the caller's contract that coord is an ivec3 whose z is
        // the layer index. The 2D branch never reads .z
        const neighbor = array
          ? textureLoad(inputBuffer, offsetCoord, int(0)).depth(
              (coord as Node<'ivec3'>).z
            )
          : textureLoad(inputBuffer, offsetCoord, int(0))
        moment1.addAssign(neighbor)
        moment2.addAssign(neighbor.mul(neighbor))
      }

      const N = float(offsets.length + 1)
      const mean = moment1.div(N)
      const varianceGamma = sqrt(
        max(moment2.div(N).sub(mean.mul(mean)), float(0))
      ).mul(gamma)
      const minColor = mean.sub(varianceGamma)
      const maxColor = mean.add(varianceGamma)
      return clipAABB(
        clamp(mean, minColor, maxColor),
        history,
        minColor,
        maxColor
      )
    }
  )
}

// varianceClipping.glsl:79–105, bilinear vec2/textureOffset variant
export function varianceClippingUv(
  inputBuffer: Texture,
  options: Pick<VarianceClippingOptions, 'samples'> = {}
) {
  const { samples = 9 } = options
  const offsets = samples === 9 ? OFFSETS_9 : OFFSETS_4
  const inputNode = texture(inputBuffer)
  // @types/three exposes TextureSizeNode as the legacy untyped Node base
  const inputSize = vec2(textureSize(inputNode) as never)
  const texelSize = vec2(1).div(inputSize)

  return /*#__PURE__*/ Fn(
    ([coord, current, history, gamma]: [
      Node<'vec2'>,
      Node<'vec4'>,
      Node<'vec4'>,
      Node<'float'>
    ]) => {
      const moment1 = current.toVar()
      const moment2 = current.mul(current).toVar()

      for (const [dx, dy] of offsets) {
        const offset = vec2(dx, dy).mul(texelSize)
        // Callers clip only history pixels, so derivatives are non-uniform
        // Level zero keeps the reference's bilinear footprint
        const neighbor = inputNode.sample(coord.add(offset)).level(float(0))
        moment1.addAssign(neighbor)
        moment2.addAssign(neighbor.mul(neighbor))
      }

      const N = float(offsets.length + 1)
      const mean = moment1.div(N)
      const varianceGamma = sqrt(
        max(moment2.div(N).sub(mean.mul(mean)), float(0))
      ).mul(gamma)
      const minColor = mean.sub(varianceGamma)
      const maxColor = mean.add(varianceGamma)
      return clipAABB(
        clamp(mean, minColor, maxColor),
        history,
        minColor,
        maxColor
      )
    }
  )
}
