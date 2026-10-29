// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:449–470 (approximateRadianceFromGround)

import { exp, float, Fn } from 'three/tsl'
import type { Node, StructNode } from 'three/webgpu'

// Structural call signatures rather than ReturnType<typeof factory>: the
// inferred FnNode pins internal VarNode nesting that test doubles and other
// implementations cannot satisfy
export interface GroundBounceDeps {
  marchOpticalDepth: (
    position: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    maxIterationCount: Node<'float'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec2'>
  getGroundSunSkyIrradiance: (
    position: Node<'vec3'>,
    surfaceNormal: Node<'vec3'>,
    height: Node<'float'>
  ) => StructNode
  maxIterationCountToGround: Node<'float'>
  coverage: Node<'float'>
}

const GROUND_ALBEDO = 0.3
const RECIPROCAL_PI = 1 / Math.PI

// Cite: clouds.frag:449–470
export function createApproximateRadianceFromGround(deps: GroundBounceDeps) {
  const {
    marchOpticalDepth,
    getGroundSunSkyIrradiance,
    maxIterationCountToGround,
    coverage
  } = deps

  return /*#__PURE__*/ Fn(
    ([position, surfaceNormal, height, mipLevel, jitter]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const odResult = marchOpticalDepth(
        position,
        surfaceNormal.negate(),
        maxIterationCountToGround,
        mipLevel,
        jitter
      )
      // marchOpticalDepth returns vec2(opticalDepth, rayDistance)
      const opticalDepthToGround = odResult.x

      const irradiance = getGroundSunSkyIrradiance(
        position,
        surfaceNormal,
        height
      )
      // struct .get() is not generic over the member table (see
      // cloudsFragment.ts); both members are vec3 irradiance
      const sunIrradiance = irradiance.get('direct') as Node<'vec3'>
      const skyIrradiance = irradiance.get('indirect') as Node<'vec3'>

      const groundIrradiance = skyIrradiance.add(
        float(1).sub(coverage).mul(sunIrradiance)
      )
      const bouncedRadiance = groundIrradiance.mul(
        GROUND_ALBEDO * RECIPROCAL_PI
      )
      return bouncedRadiance.mul(exp(opticalDepthToGround.negate()))
    }
  )
}

// CPU twin for testing

export function approximateRadianceFromGroundCPU(
  opticalDepthToGround: number,
  sunIrradiance: [number, number, number],
  skyIrradiance: [number, number, number],
  coverage: number
): [number, number, number] {
  const groundIrradiance: [number, number, number] = [
    skyIrradiance[0] + (1 - coverage) * sunIrradiance[0],
    skyIrradiance[1] + (1 - coverage) * sunIrradiance[1],
    skyIrradiance[2] + (1 - coverage) * sunIrradiance[2]
  ]
  const factor = GROUND_ALBEDO * RECIPROCAL_PI * Math.exp(-opticalDepthToGround)
  return [
    groundIrradiance[0] * factor,
    groundIrradiance[1] * factor,
    groundIrradiance[2] * factor
  ]
}
