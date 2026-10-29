// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// which ports GLM's gtc/noise.inl, kept close to the original's constants
// Cite: perlin.glsl:57–211
// Reference: https://github.com/g-truc/glm/blob/master/glm/gtc/noise.inl

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * OpenGL Mathematics (GLM)
 *
 * GLM is licensed under The Happy Bunny License or MIT License
 *
 * The Happy Bunny License (Modified MIT License)
 *
 * Copyright (c) 2005 - G-Truc Creation
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
 * Restrictions:
 *  By making use of the Software for military purposes, you choose to make a
 *  Bunny unhappy.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * The MIT License
 *
 * Copyright (c) 2005 - G-Truc Creation
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

import { abs, float, Fn, mix, step, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// GLSL `mod` floors (`x - y * floor(x / y)`) and WGSL's `%` truncates toward
// zero, so they disagree for every negative coordinate. The generators evaluate
// noise at negative positions, so this is written out rather than delegated
const glslMod = (x: Node<'vec4'>, y: Node<'vec4'>): Node<'vec4'> =>
  x.sub(y.mul(x.div(y).floor()))

const mod289 = (x: Node<'vec4'>): Node<'vec4'> =>
  x.sub(
    x
      .mul(1 / 289)
      .floor()
      .mul(289)
  )

const permute = (v: Node<'vec4'>): Node<'vec4'> =>
  mod289(v.mul(34).add(1).mul(v))

const taylorInvSqrt = (r: Node<'vec4'>): Node<'vec4'> =>
  float(1.79284291400159).sub(r.mul(0.85373472095314))

const fade = (v: Node<'vec4'>): Node<'vec4'> =>
  v
    .mul(v)
    .mul(v)
    .mul(v.mul(v.mul(6).sub(15)).add(10))

interface Gradients {
  gx: Node<'vec4'>
  gy: Node<'vec4'>
  gz: Node<'vec4'>
  gw: Node<'vec4'>
}

// One of the four gradient sets, as four packed component vectors: `gx` holds
// the x component of four different gradients, and so on

// The GLSL repeats this block for ixy00/01/10/11 with only the index vector
// varying, so it is factored: a drifted hand-copy would still look like noise
function gradients(ixy: Node<'vec4'>): Gradients {
  const gxRaw = ixy.div(7)
  const gyRaw = gxRaw.floor().div(7)
  const gzRaw = gyRaw.floor().div(6)

  const gx0 = gxRaw.fract().sub(0.5)
  const gy0 = gyRaw.fract().sub(0.5)
  const gz = gzRaw.fract().sub(0.5)

  const gw = float(0.75).sub(abs(gx0)).sub(abs(gy0)).sub(abs(gz))

  // `sw` marks gradients that fell outside the tetrahedron, and the corrections
  // reflect those back in. `step(edge, x)` is `x < edge ? 0 : 1`, so
  // `step(gw, 0)` selects the components where gw <= 0
  const sw = step(gw, vec4(0))
  const gx = gx0.sub(sw.mul(step(vec4(0), gx0).sub(0.5)))
  const gy = gy0.sub(sw.mul(step(vec4(0), gy0).sub(0.5)))

  return { gx, gy, gz, gw }
}

const corner = (g: Gradients, c: 'x' | 'y' | 'z' | 'w'): Node<'vec4'> =>
  vec4(g.gx[c], g.gy[c], g.gz[c], g.gw[c])

// Classic Perlin noise in four dimensions, periodic in `rep`: `perlin(p, rep)`
// equals `perlin(p + rep, rep)` on every axis, so the textures tile. Returns
// roughly [-1, 1], and exactly 0 at integer lattice points

// The CPU twin in `test/helpers/perlinReference.ts` is written independently
// from the GLSL and pins both properties. s68's e2e compares against it
export const perlin = /*#__PURE__*/ Fn(
  ([position, rep]: [Node<'vec4'>, Node<'vec4'>]) => {
    const Pi0 = glslMod(position.floor(), rep)
    const Pi1 = glslMod(Pi0.add(1), rep)
    const Pf0 = position.fract()
    const Pf1 = Pf0.sub(1)

    const ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x)
    const iy = vec4(Pi0.y, Pi0.y, Pi1.y, Pi1.y)
    const iz0 = vec4(Pi0.z)
    const iz1 = vec4(Pi1.z)
    const iw0 = vec4(Pi0.w)
    const iw1 = vec4(Pi1.w)

    const ixy = permute(permute(ix).add(iy))
    const ixy0 = permute(ixy.add(iz0))
    const ixy1 = permute(ixy.add(iz1))

    const g00 = gradients(permute(ixy0.add(iw0)))
    const g01 = gradients(permute(ixy0.add(iw1)))
    const g10 = gradients(permute(ixy1.add(iw0)))
    const g11 = gradients(permute(ixy1.add(iw1)))

    // Bit order in the names is x,y,z,w
    const g0000 = corner(g00, 'x')
    const g1000 = corner(g00, 'y')
    const g0100 = corner(g00, 'z')
    const g1100 = corner(g00, 'w')
    const g0010 = corner(g10, 'x')
    const g1010 = corner(g10, 'y')
    const g0110 = corner(g10, 'z')
    const g1110 = corner(g10, 'w')
    const g0001 = corner(g01, 'x')
    const g1001 = corner(g01, 'y')
    const g0101 = corner(g01, 'z')
    const g1101 = corner(g01, 'w')
    const g0011 = corner(g11, 'x')
    const g1011 = corner(g11, 'y')
    const g0111 = corner(g11, 'z')
    const g1111 = corner(g11, 'w')

    // Note the order: the GLSL normalises (0000, 0100, 1000, 1100), y and z
    // swapped. Reading it as x,y,z,w pairs gradients with the wrong factor and
    // still looks like noise
    const norm = (
      a: Node<'vec4'>,
      b: Node<'vec4'>,
      c: Node<'vec4'>,
      d: Node<'vec4'>
    ): Node<'vec4'> =>
      taylorInvSqrt(vec4(a.dot(a), b.dot(b), c.dot(c), d.dot(d)))

    const n00 = norm(g0000, g0100, g1000, g1100)
    const n01 = norm(g0001, g0101, g1001, g1101)
    const n10 = norm(g0010, g0110, g1010, g1110)
    const n11 = norm(g0011, g0111, g1011, g1111)

    const p0000 = g0000.mul(n00.x)
    const p0100 = g0100.mul(n00.y)
    const p1000 = g1000.mul(n00.z)
    const p1100 = g1100.mul(n00.w)
    const p0001 = g0001.mul(n01.x)
    const p0101 = g0101.mul(n01.y)
    const p1001 = g1001.mul(n01.z)
    const p1101 = g1101.mul(n01.w)
    const p0010 = g0010.mul(n10.x)
    const p0110 = g0110.mul(n10.y)
    const p1010 = g1010.mul(n10.z)
    const p1110 = g1110.mul(n10.w)
    const p0011 = g0011.mul(n11.x)
    const p0111 = g0111.mul(n11.y)
    const p1011 = g1011.mul(n11.z)
    const p1111 = g1111.mul(n11.w)

    const at = (x: 0 | 1, y: 0 | 1, z: 0 | 1, w: 0 | 1): Node<'vec4'> =>
      vec4(
        x ? Pf1.x : Pf0.x,
        y ? Pf1.y : Pf0.y,
        z ? Pf1.z : Pf0.z,
        w ? Pf1.w : Pf0.w
      )

    const n0000 = p0000.dot(Pf0)
    const n1000 = p1000.dot(at(1, 0, 0, 0))
    const n0100 = p0100.dot(at(0, 1, 0, 0))
    const n1100 = p1100.dot(at(1, 1, 0, 0))
    const n0010 = p0010.dot(at(0, 0, 1, 0))
    const n1010 = p1010.dot(at(1, 0, 1, 0))
    const n0110 = p0110.dot(at(0, 1, 1, 0))
    const n1110 = p1110.dot(at(1, 1, 1, 0))
    const n0001 = p0001.dot(at(0, 0, 0, 1))
    const n1001 = p1001.dot(at(1, 0, 0, 1))
    const n0101 = p0101.dot(at(0, 1, 0, 1))
    const n1101 = p1101.dot(at(1, 1, 0, 1))
    const n0011 = p0011.dot(at(0, 0, 1, 1))
    const n1011 = p1011.dot(at(1, 0, 1, 1))
    const n0111 = p0111.dot(at(0, 1, 1, 1))
    const n1111 = p1111.dot(Pf1)

    const f = fade(Pf0)
    const n0w = mix(
      vec4(n0000, n1000, n0100, n1100),
      vec4(n0001, n1001, n0101, n1101),
      f.w
    )
    const n1w = mix(
      vec4(n0010, n1010, n0110, n1110),
      vec4(n0011, n1011, n0111, n1111),
      f.w
    )
    const nzw = mix(n0w, n1w, f.z)
    const nyzw = mix(nzw.xy, nzw.zw, f.y)

    return mix(nyzw.x, nyzw.y, f.x).mul(2.2)
  }
)
