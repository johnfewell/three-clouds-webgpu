// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:417 - two horizon samples for directional ambient light

import {
  abs,
  clamp,
  cross,
  dot,
  float,
  Fn,
  max,
  normalize,
  sqrt,
  varying,
  vec3
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import { createIndirectLuminance } from '../lighting/sunSkyLight'

// A positive degree-2 zonal kernel. Two samples cannot recover arbitrary
// nine-coefficient SH, so this is a constrained two-lobe approximation,
// normalized by the same weights so an isotropic sky keeps its energy
const skyKernel = Fn(([cosine]: [Node<'float'>]) =>
  float(1).add(cosine.mul(0.6)).add(cosine.mul(cosine).mul(3).sub(1).mul(0.25))
)

export const directionalSkyFactor = Fn(
  ([toward, away, muToward, muAway]: [
    Node<'vec3'>,
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const a = skyKernel(muToward)
    const b = skyKernel(muAway)
    const weighted = toward.mul(a).add(away.mul(b))
    const mean = toward.add(away).mul(0.5).mul(a.add(b))
    // Black channels stay neutral rather than producing 0/0 or colour speckles
    return clamp(weighted.add(1e-6).div(mean.add(1e-6)), vec3(0.25), vec3(4))
  }
)

export function createDirectionalSkylight(
  cameraPosition: Node<'vec3'>,
  sunDirection: Node<'vec3'>,
  bottomRadius: Node<'float'>,
  height: Node<'float'>,
  incidentSky?: (
    position: Node<'vec3'>,
    direction: Node<'vec3'>
  ) => Node<'vec3'>
) {
  const up = normalize(cameraPosition)
  const axis = Fn(() => {
    const reference = abs(up.z)
      .lessThan(0.9)
      .select(vec3(0, 0, 1), vec3(1, 0, 0))
    const tangent = sunDirection.sub(up.mul(dot(sunDirection, up)))
    return normalize(
      dot(tangent, tangent)
        .greaterThan(1e-6)
        .select(tangent, cross(up, reference))
    )
  })()
  const radius = bottomRadius.add(max(height, float(1)))
  const ratio = bottomRadius.div(radius)
  const horizon = sqrt(max(float(0), float(1).sub(ratio.mul(ratio))))
    .negate()
    .add(0.03)
  const horizontal = sqrt(max(float(0), float(1).sub(horizon.mul(horizon))))
  const towardDirection = axis.mul(horizontal).add(up.mul(horizon))
  const awayDirection = axis.mul(horizontal.negate()).add(up.mul(horizon))
  const sampleSky = createIndirectLuminance(sunDirection)
  const readSky =
    incidentSky ??
    ((position: Node<'vec3'>, direction: Node<'vec3'>) =>
      sampleSky(position, direction).get('luminance') as Node<'vec3'>)
  const point = up.mul(radius)
  const toward = varying(readSky(point, towardDirection))
  const away = varying(readSky(point, awayDirection))
  const towardAxis = varying(towardDirection)
  const awayAxis = varying(awayDirection)
  let factor: Node<'vec3'> = vec3(1)
  return {
    prepare: (direction: Node<'vec3'>) => {
      factor = directionalSkyFactor(
        toward,
        away,
        dot(direction.negate(), towardAxis),
        dot(direction.negate(), awayAxis)
      ).toVar()
    },
    evaluate: () => factor
  }
}

export function directionalSkyFactorCPU(
  toward: number,
  away: number,
  muToward: number,
  muAway: number
): number {
  const kernel = (x: number) => 1 + 0.6 * x + 0.25 * (3 * x * x - 1)
  const a = kernel(muToward)
  const b = kernel(muAway)
  return Math.max(
    0.25,
    Math.min(
      4,
      (toward * a + away * b + 1e-6) / ((toward + away) * 0.5 * (a + b) + 1e-6)
    )
  )
}
