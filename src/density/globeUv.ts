// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.glsl:7–55

import {
  abs,
  asin,
  atan,
  dFdx,
  dFdy,
  dot,
  float,
  Fn,
  greaterThan,
  log2,
  max,
  normalize,
  select,
  sign,
  sqrt,
  vec2
} from 'three/tsl'
import type { Node } from 'three/webgpu'

const RECIPROCAL_PI2 = 1 / (2 * Math.PI)
const RECIPROCAL_PI = 1 / Math.PI

export const getSphericalUv = /*#__PURE__*/ Fn(([position]: [Node<'vec3'>]) => {
  const st = normalize(position.yx)
  const phi = atan(st.x, st.y)
  const theta = asin(normalize(position).z)
  return vec2(
    phi.mul(RECIPROCAL_PI2).add(0.5),
    theta.mul(RECIPROCAL_PI).add(0.5)
  )
})

// Cube-sphere relaxation by: http://mathproofs.blogspot.com/2005/07/mapping-cube-to-sphere.html
// eslint-disable-next-line no-comment-slop/no-trailing-period -- verbatim upstream TODO
// TODO(port): Tile and fix seams.
// Possible improvements:
// https://iquilezles.org/articles/texturerepetition/
// https://gamedev.stackexchange.com/questions/184388/fragment-shader-map-dot-texture-repeatedly-over-the-sphere
// https://github.com/mmikk/hextile-demo
export const getCubeSphereUv = /*#__PURE__*/ Fn(
  ([position]: [Node<'vec3'>]) => {
    const n = normalize(position)
    const f = abs(n)
    const c = n.div(max(f.x, max(f.y, f.z)))

    // Face selection: which axis is dominant
    const fyGtFx = greaterThan(f.y, f.x)
    const fyGtFz = greaterThan(f.y, f.z)
    const fxGtFy = greaterThan(f.x, f.y)
    const fxGtFz = greaterThan(f.x, f.z)

    const isYFace = fyGtFx.and(fyGtFz)
    const isXFace = fxGtFy.and(fxGtFz)

    // Y-dominant face: m = (-n.x, n.z) or (n.x, n.z), m.y is n.z either way
    const yMx = select(c.y.greaterThan(0), n.x.negate(), n.x)
    const yMy = n.z

    // X-dominant face: m = (n.y, n.z) or (-n.y, n.z), m.y is n.z either way
    const xMx = select(c.x.greaterThan(0), n.y, n.y.negate())
    const xMy = n.z

    // Z-dominant face: m = (n.x, n.y) or (n.x, -n.y), m.x is n.x either way
    const zMx = n.x
    const zMy = select(c.z.greaterThan(0), n.y, n.y.negate())

    const mx = select(isYFace, yMx, select(isXFace, xMx, zMx))
    const my = select(isYFace, yMy, select(isXFace, xMy, zMy))

    const mx2 = mx.mul(mx)
    const my2 = my.mul(my)

    // q = dot(m², (-2, 2)) - 3 = -2·mx² + 2·my² - 3
    const q = mx2.mul(-2).add(my2.mul(2)).sub(3)
    const q2 = q.mul(q)

    // uv.x = sqrt(1.5 + mx² - my² - 0.5·sqrt(-24·mx² + q²)) · sign(mx)
    // Cite: clouds.glsl:15–40 (the reference's unguarded form)

    // max(0, ...) defines what the reference leaves undefined. On the tie
    // f.x == f.y the Z face is taken and the inner radicand reaches -3, the only
    // negative case in a 320k-direction sweep

    // GLSL drivers return 0 for sqrt(negative), WGSL returns NaN (the case
    // 49). The CPU twin always had these guards, so it could not catch this
    const uvx = sqrt(
      max(
        float(0),
        float(1.5)
          .add(mx2)
          .sub(my2)
          .sub(sqrt(max(float(0), mx2.mul(-24).add(q2))).mul(0.5))
      )
    ).mul(sign(mx))

    // uv.y = sqrt(6 / (3 - uvx²)) · my
    const uvy = sqrt(
      max(float(0), float(6).div(float(3).sub(uvx.mul(uvx))))
    ).mul(my)

    return vec2(uvx, uvy).mul(0.5).add(0.5)
  }
)

export const getGlobeUv = /*#__PURE__*/ Fn(([position]: [Node<'vec3'>]) => {
  return getCubeSphereUv(position)
})

export const getMipLevel = /*#__PURE__*/ Fn(
  ([uv, resolution]: [Node<'vec2'>, Node<'vec2'>]) => {
    const mipLevelScale = 0.1
    const coord = uv.mul(resolution)
    const ddx = dFdx(coord)
    const ddy = dFdy(coord)
    const deltaMaxSqr = max(dot(ddx, ddx), dot(ddy, ddy)).mul(mipLevelScale)
    return max(float(0), log2(max(float(1), deltaMaxSqr)).mul(0.5))
  }
)

// CPU-twin functions for testing
export function cpuGetSphericalUv(
  px: number,
  py: number,
  pz: number
): [number, number] {
  const len = Math.sqrt(px * px + py * py + pz * pz)
  const nz = pz / len

  const stLen = Math.sqrt(py * py + px * px)
  const stx = stLen > 0 ? py / stLen : 0
  const sty = stLen > 0 ? px / stLen : 0

  const phi = Math.atan2(stx, sty)
  const theta = Math.asin(Math.max(-1, Math.min(1, nz)))
  return [phi * RECIPROCAL_PI2 + 0.5, theta * RECIPROCAL_PI + 0.5]
}

export function cpuGetCubeSphereUv(
  px: number,
  py: number,
  pz: number
): [number, number] {
  const len = Math.sqrt(px * px + py * py + pz * pz)
  const nx = px / len
  const ny = py / len
  const nz = pz / len

  const fx = Math.abs(nx)
  const fy = Math.abs(ny)
  const fz = Math.abs(nz)

  const fmax = Math.max(fx, fy, fz)
  const cx = nx / fmax
  const cy = ny / fmax
  const cz = nz / fmax

  let mx: number
  let my: number

  if (fy > fx && fy > fz) {
    mx = cy > 0 ? -nx : nx
    my = nz
  } else if (fx > fy && fx > fz) {
    mx = cx > 0 ? ny : -ny
    my = nz
  } else {
    mx = nx
    my = cz > 0 ? ny : -ny
  }

  const mx2 = mx * mx
  const my2 = my * my
  const q = -2 * mx2 + 2 * my2 - 3
  const q2 = q * q
  const inner = -24 * mx2 + q2
  const uvx =
    Math.sqrt(
      Math.max(0, 1.5 + mx2 - my2 - 0.5 * Math.sqrt(Math.max(0, inner)))
    ) * Math.sign(mx)
  const denom = 3 - uvx * uvx
  const uvy = Math.sqrt(Math.max(0, 6 / denom)) * my

  return [uvx * 0.5 + 0.5, uvy * 0.5 + 0.5]
}
