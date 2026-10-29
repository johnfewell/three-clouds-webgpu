// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: turbulence.frag:12–51

import { Fn, normalize, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { createPerlinFbm } from './tileableNoise'

const FREQUENCY = /*#__PURE__*/ vec3(12, 12, 12)
const perlinFbm3 = /*#__PURE__*/ createPerlinFbm(3)

const perlinAt = (p: Node<'vec3'>): Node<'float'> => perlinFbm3(p, FREQUENCY)

// Three Perlin fields, one per component, decorrelated by the swizzles and
// offsets. One field sampled three times would be a gradient, whose curl is
// zero, and the turbulence texture would come out uniform
const perlin3d = /*#__PURE__*/ Fn(([point]: [Node<'vec3'>]) =>
  vec3(
    perlinAt(point),
    perlinAt(point.yzx.add(vec3(-19.1, 33.4, 47.2))),
    perlinAt(point.zxy.add(vec3(74.2, -124.5, 99.4)))
  )
)

// Curl by central differences, delta 0.1
//
// Curl is divergence-free by construction, which is the point: advecting cloud
// density along it swirls the field without creating or destroying any
const curl = /*#__PURE__*/ Fn(([point]: [Node<'vec3'>]) => {
  const delta = 0.1
  const at = (dx: number, dy: number, dz: number): Node<'vec3'> =>
    perlin3d(point.add(vec3(dx, dy, dz)))

  const px0 = at(-delta, 0, 0)
  const px1 = at(delta, 0, 0)
  const py0 = at(0, -delta, 0)
  const py1 = at(0, delta, 0)
  const pz0 = at(0, 0, -delta)
  const pz1 = at(0, 0, delta)

  const x = py1.z.sub(py0.z).sub(pz1.y).add(pz0.y)
  const y = pz1.x.sub(pz0.x).sub(px1.z).add(px0.z)
  const z = px1.y.sub(px0.y).sub(py1.x).add(py0.x)

  // The divisor cancels under the normalize that follows, but it is kept so the
  // expression matches the reference line for line. The pre-normalize vector is
  // what a debug view would show
  const divisor = 1 / (2 * delta)
  return normalize(vec3(x, y, z).mul(divisor))
})

// The 128² turbulence texture: curl packed into [0, 1]
export const turbulence = /*#__PURE__*/ Fn(([uv]: [Node<'vec2'>]) => {
  const c = curl(vec3(uv.x, uv.y, 0))
  return vec4(c.mul(0.5).add(0.5), 1)
})
