// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: @takram/three-atmosphere MoonNode.getLunarRadiance, for its 2.5e-6
// Twilight moonlight retargets the march's ONE light: the phase function, the
// Beer-shadow march and the cascades follow it. Never a second light

import { Vector3 } from 'three'
import { add, Fn } from 'three/tsl'
import type { Node, StructNode } from 'three/webgpu'

import { cloudsSolarLuminance, splitIlluminance } from '../lighting/sunSkyLight'

// Full-moon irradiance as a fraction of the sun's: the visual magnitudes
// m_sun = -26.74 and m_moon = -12.74 give 10^(-0.4 * (m_moon - m_sun)) = 2.5e-6
// (NASA fact sheets, the pair MoonNode.getLunarRadiance cites)
export const FULL_MOON_IRRADIANCE_RATIO = 2.5e-6

// Civil twilight, sin(-6 deg). The handover from sun to moon runs from the
// horizon down to this, so it is a fade rather than a pop at sunset
export const TWILIGHT_SIN_ELEVATION = -0.104528

// How far the sun has set, 0 while it is up and 1 once it is 6 degrees below
// the observer's horizon. `sunElevation` is `dot(sunDirection, up)`, so it is
// the sine of the elevation angle
export function twilightBlendCPU(sunElevation: number): number {
  const t = Math.min(Math.max(-sunElevation / -TWILIGHT_SIN_ELEVATION, 0), 1)
  return t * t * (3 - 2 * t)
}

// The illuminated fraction of the disc, from the sun-moon elongation: 0 is new
// moon and pi is full. A sphere scatters over its lit fraction, so that is the
// share of a full moon's irradiance it delivers
export function illuminatedFractionCPU(
  sunDirection: Vector3,
  moonDirection: Vector3
): number {
  return (1 - sunDirection.dot(moonDirection)) / 2
}

const _up = /*#__PURE__*/ new Vector3()
const _moon = /*#__PURE__*/ new Vector3()
const _light = /*#__PURE__*/ new Vector3()

// Writes the march's light direction and the moon's share of the irradiance
// into `out`. A zero `moonDirection` leaves the sun in charge, which is what an
// unset context gets
export function moonlightCPU(
  sunDirection: Vector3,
  moonDirection: Vector3,
  cameraPositionECEF: Vector3,
  gain: number,
  color: Vector3,
  out: { lightDirection: Vector3; irradianceRatio: Vector3 }
): { blend: number; illuminated: number } {
  // A degenerate sun is left exactly as it came in. Normalizing it would put
  // NaN in the march's light, and the reference never normalized it at all
  if (sunDirection.lengthSq() === 0) {
    out.lightDirection.copy(sunDirection)
    out.irradianceRatio.set(0, 0, 0)
    return { blend: 0, illuminated: 0 }
  }

  // Up at the observer. Zero for a camera at the planet's centre, where the
  // sun's elevation is undefined and any axis reads the same
  _up.copy(cameraPositionECEF)
  const hasUp = _up.lengthSq() > 0
  if (hasUp) _up.normalize()

  const blend = twilightBlendCPU(hasUp ? sunDirection.dot(_up) : -1)
  const illuminated = illuminatedFractionCPU(sunDirection, moonDirection)

  _moon.copy(moonDirection)
  const hasMoon = _moon.lengthSq() > 0
  if (hasMoon) _moon.normalize()

  // The blend, not a branch on the sun's sign: at blend 0 this is exactly the
  // sun's direction, so the daylight path is the reference's
  _light
    .copy(sunDirection)
    .lerp(hasMoon ? _moon : sunDirection, blend)
    .normalize()
  out.lightDirection.copy(_light)

  const share = FULL_MOON_IRRADIANCE_RATIO * illuminated * gain * blend
  out.irradianceRatio.copy(color).multiplyScalar(share)
  return { blend, illuminated }
}

export interface MoonlightNodes {
  // The march's one light direction, sun or moon
  direction: Node<'vec3'>
  // Adds the moon's irradiance to the direct member of the sun-and-sky
  // irradiance struct. The sky member is the atmosphere's and stays as it is,
  // since the LUT carries no moon
  addMoonlight: <T extends StructNode>(irradiance: T) => StructNode
}

// The shader half. The moon's irradiance is the sun's, scaled by the CPU's
// ratio, so the moonlit clouds agree with the moon disc takram's SkyNode draws
// in the same frame: both take the sun's disc radiance from the same LUT
export function createMoonlightNodes(deps: {
  lightDirection: Node<'vec3'>
  irradianceRatio: Node<'vec3'>
  sunAngularRadius: number
}): MoonlightNodes {
  // Solar irradiance as radiance times solid angle, the inverse of what
  // MoonNode.getLunarRadiance does with the same disc
  const solarIrradiance = cloudsSolarLuminance().mul(
    Math.PI * deps.sunAngularRadius * deps.sunAngularRadius
  )

  const addMoonlight = Fn(([irradiance]: [StructNode]) => {
    // One temp per sample: the sun's disc radiance is a chain of uniform
    // multiplies, and the march reads this once per in-cloud sample
    const moonIrradiance = solarIrradiance.mul(deps.irradianceRatio).toVar()
    return splitIlluminance(
      add(irradiance.get('direct') as Node<'vec3'>, moonIrradiance),
      irradiance.get('indirect') as Node<'vec3'>
    )
  })
  return { direction: deps.lightDirection, addMoonlight }
}
