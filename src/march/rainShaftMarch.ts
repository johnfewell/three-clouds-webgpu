// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// The shaft march: its own closed segment over the band below the deck, which
// the primary march starts after and its skip would empty anyway
// Ray geometry from clouds.frag:743-769, read at the cloud base

import { exp, float, Fn, Loop, max, min, select, vec3, vec4 } from 'three/tsl'
import type { Node, StructNode } from 'three/webgpu'

import { raySpheresIntersections } from '@takram/three-geospatial/webgpu'

import { getGlobeUv } from '../density/globeUv'
import {
  RAIN_SHAFT_ALBEDO,
  RAIN_SHAFT_STEP_COUNT,
  RAIN_SHAFT_SUN_EXTINCTION,
  type RainShaftDeps
} from '../experimental/rainShafts'
import { RECIPROCAL_PI4 } from '../lighting/sunSkyLight'

export interface RainShaftMarchDeps {
  density: RainShaftDeps['density']
  getCloudsSunSkyIrradiance: (
    position: Node<'vec3'>,
    height: Node<'float'>
  ) => StructNode
  bottomRadius: Node<'float'>
  // The lowest layer's altitude, so the band's top IS the cell base and a
  // taller deck lifts the shafts with it
  baseHeight: Node<'float'>
  maxRayDistance: Node<'float'>
}

// The shaft segment: a closed march of fixed step count over the part of the ray
// below the cloud base and in front of whatever the ray hits, returning its rgb
// in-scatter and its own transmittance. The primary march cannot do this
export function createRainShaftMarch(deps: RainShaftMarchDeps) {
  return Fn(
    ([cameraPosition, rayDirection, sunShadowLength, sceneRayDistance]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      // Reuse the cloud march's sphere helper, including its miss sentinel
      // Cite: clouds.frag:730-741, core webgpu/math.ts raySpheresIntersections
      const intersections = raySpheresIntersections(
        cameraPosition,
        rayDirection,
        vec3(0),
        deps.bottomRadius.add(vec4(0, deps.baseHeight, 0, deps.baseHeight))
      )
      const entry = intersections.get('near') as Node<'vec4'>
      const exit = intersections.get('far') as Node<'vec4'>
      const near = max(entry.y, float(0))
      // Bare-ellipsoid skies have no scene depth, but the planet still blocks
      // rain. An origin inside the ground has no visible shaft segment
      const groundBound = select(
        cameraPosition.length().lessThan(deps.bottomRadius),
        float(0),
        select(entry.x.greaterThanEqual(0), entry.x, deps.maxRayDistance)
      ).toVar('rainGroundBound')
      const sceneBound = select(
        sceneRayDistance.greaterThan(0),
        sceneRayDistance,
        deps.maxRayDistance
      )
      const far = max(
        near,
        min(min(exit.y, sceneBound), min(groundBound, deps.maxRayDistance))
      ).toVar('rainFar')
      // Clamped, not branched: an empty segment then marches four zero-length
      // steps, which integrate to no in-scatter and a transmittance of 1
      const span = max(far.sub(near), float(0)).toVar()
      const stepSize = span.div(float(RAIN_SHAFT_STEP_COUNT)).toVar()

      // Lighting once per ray, at the segment's top. The interpolated
      // irradiance path (accurateSunSkyLight off) reads only the height, so one
      // read is exact there rather than an approximation
      const topPosition = rayDirection.mul(far).add(cameraPosition).toVar()
      const topHeight = topPosition.length().sub(deps.bottomRadius)
      const irradiance = deps.getCloudsSunSkyIrradiance(topPosition, topHeight)
      // The cloud between this pixel and the sun, as the marched shadow length
      // the aerial perspective already computed. Without lightShafts there is
      // no such length, and the shafts stay lit under the deck
      const sunTransmittance = sunShadowLength
        .mul(-RAIN_SHAFT_SUN_EXTINCTION)
        .exp()
      // struct .get() is not generic over the member table
      const sunIrradiance = irradiance.get('direct') as Node<'vec3'>
      const skyIrradiance = irradiance.get('indirect') as Node<'vec3'>
      const ambient = sunIrradiance
        .mul(sunTransmittance)
        .add(skyIrradiance)
        .mul(RECIPROCAL_PI4)
        .mul(RAIN_SHAFT_ALBEDO)

      const radiance = vec3(0).toVar()
      const transmittance = float(1).toVar()
      // The midpoint of each step, and not the frame's jitter: stbn is declared
      // where the march branch first reads it, so a second read from the
      // composite compiles and then fails WGSL validation as an unresolved value
      const distance = float(0).toVar()
      distance.assign(near.add(stepSize.mul(0.5)))

      Loop(RAIN_SHAFT_STEP_COUNT, () => {
        const position = rayDirection.mul(distance).add(cameraPosition)
        const height = position.length().sub(deps.bottomRadius)
        const extinction = deps.density(height, getGlobeUv(position))
        const stepTransmittance = exp(extinction.mul(stepSize).negate())
        // One albedo term for the whole segment: single scattering in a medium
        // thin enough that its own extinction never shadows its in-scatter
        radiance.addAssign(
          transmittance.mul(stepTransmittance.oneMinus()).mul(ambient)
        )
        transmittance.mulAssign(stepTransmittance)
        distance.addAssign(stepSize)
      })

      return vec4(radiance, transmittance)
    }
  )
}

// The layer seen through a shaft in front of it. Alpha is opacity, as in
// blendHaze, so the scene behind keeps (1 - a) * shaft.w and a curtain dims it
export function composeThroughShaft(
  color: Node<'vec4'>,
  shaft: Node<'vec4'>
): Node<'vec4'> {
  return vec4(
    color.xyz.mul(shaft.w).add(shaft.xyz),
    color.a.oneMinus().mul(shaft.w).oneMinus()
  )
}

export function composeThroughShaftCPU(
  color: readonly [number, number, number, number],
  shaft: readonly [number, number, number, number]
): [number, number, number, number] {
  const s = shaft[3]
  return [
    color[0] * s + shaft[0],
    color[1] * s + shaft[1],
    color[2] * s + shaft[2],
    1 - (1 - color[3]) * s
  ]
}

// The segment the march integrates, in metres, from the same near and far the
// shader reads, so a test can pin which pixels march and which are a no-op
export function rainShaftSegmentCPU(
  cameraRadius: number,
  cameraAlongRay: number,
  shellRadius: number,
  maxRayDistance: number,
  sceneRayDistance: number,
  bottomRadius: number
): { near: number; far: number; steps: number } {
  const b = cameraAlongRay
  const c = cameraRadius * cameraRadius - shellRadius * shellRadius
  const discriminant = b * b - c
  const halfChord = Math.sqrt(Math.max(discriminant, 0))
  const entry = discriminant >= 0 ? -b - halfChord : -1
  const exit = discriminant >= 0 ? -b + halfChord : -1
  const groundDiscriminant =
    b * b - (cameraRadius * cameraRadius - bottomRadius * bottomRadius)
  const groundEntry =
    groundDiscriminant >= 0 ? -b - Math.sqrt(groundDiscriminant) : -1
  const groundBound =
    cameraRadius < bottomRadius
      ? 0
      : groundEntry >= 0
        ? groundEntry
        : maxRayDistance
  const sceneBound = sceneRayDistance > 0 ? sceneRayDistance : maxRayDistance
  const near = Math.max(entry, 0)
  const far = Math.max(
    near,
    Math.min(exit, sceneBound, groundBound, maxRayDistance)
  )
  const span = Math.max(far - near, 0)
  return { near, far, steps: span / RAIN_SHAFT_STEP_COUNT }
}

// One step of the integration, for the transmittance and in-scatter totals
export function rainShaftStepCPU(
  transmittance: number,
  extinction: number,
  stepSize: number,
  ambient: number
): { transmittance: number; inScatter: number } {
  const stepTransmittance = Math.exp(-extinction * stepSize)
  return {
    transmittance: transmittance * stepTransmittance,
    inScatter: transmittance * (1 - stepTransmittance) * ambient
  }
}
