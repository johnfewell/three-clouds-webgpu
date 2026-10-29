// Ported from @takram/three-atmosphere 0.19.1 celestialDirections.ts and the
// port's src/experimental/moonlight.ts (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Sun and moon directions in ECEF, with astronomy-engine as takram uses it

import {
  AstroTime,
  Body,
  GeoVector,
  KM_PER_AU,
  Pivot,
  Rotation_EQJ_EQD,
  RotationAxis,
  SiderealTime,
  type RotationMatrix
} from 'astronomy-engine'

import { DEG2RAD, Mat4, Quat, Vec3 } from './math'

const METER_TO_AU = 0.001 / KM_PER_AU

export function toAstroTime(value: number | Date | AstroTime): AstroTime {
  return value instanceof AstroTime
    ? value
    : new AstroTime(value instanceof Date ? value : new Date(value))
}

function fromAstroRotationMatrix(
  matrix: RotationMatrix,
  result = new Mat4()
): Mat4 {
  const [row0, row1, row2] = matrix.rot as [number[], number[], number[]]
  return result.set(
    row0[0]!,
    row1[0]!,
    row2[0]!,
    0,
    row0[1]!,
    row1[1]!,
    row2[1]!,
    0,
    row0[2]!,
    row1[2]!,
    row2[2]!,
    0,
    0,
    0,
    0,
    1
  )
}

export function getECIToECEFRotationMatrix(
  date: number | Date | AstroTime,
  result = new Mat4()
): Mat4 {
  const time = toAstroTime(date)
  const matrix = Pivot(Rotation_EQJ_EQD(time), 2, -15 * SiderealTime(time))
  return fromAstroRotationMatrix(matrix, result)
}

const axisScratch1 = /*#__PURE__*/ new Vec3()
const axisScratch2 = /*#__PURE__*/ new Vec3()
const axisScratch3 = /*#__PURE__*/ new Vec3()
const quaternionScratch = /*#__PURE__*/ new Quat()

// The moon's body-fixed frame in ECI. The spin is the prime meridian's angle
// from the ascending node of the moon's equator, measured east
// See: https://link.springer.com/content/pdf/10.1007/s10569-007-9072-y.pdf
export function getMoonFixedToECIRotationMatrix(
  date: number | Date | AstroTime,
  result = new Mat4()
): Mat4 {
  const time = toAstroTime(date)
  const axis = RotationAxis(Body.Moon, time)
  const north = axisScratch1.set(axis.north.x, axis.north.y, axis.north.z)
  // radians() is MathUtils.degToRad, degrees * DEG2RAD
  const spin = axis.spin * DEG2RAD
  const ascendingNode = axisScratch2.set(0, 0, 1).cross(north).normalize()
  const primeMeridian = ascendingNode
    .applyQuaternion(quaternionScratch.setFromAxisAngle(north, spin))
    .normalize()
  const east = axisScratch3.copy(north).cross(primeMeridian).normalize()
  return result.makeBasis(primeMeridian, east, north)
}

const vectorScratch = /*#__PURE__*/ new Vec3()
const matrixScratch1 = /*#__PURE__*/ new Mat4()
const matrixScratch2 = /*#__PURE__*/ new Mat4()

function getDirectionECI(
  body: Body,
  time: AstroTime,
  result: Vec3,
  observerECEF?: Vec3
): Vec3 {
  const vector = GeoVector(body, time, false)
  result.set(vector.x, vector.y, vector.z)
  if (observerECEF != null) {
    // Topocentric: the observer's offset, rotated into ECI and in AU
    const matrixECEFToECI = getECIToECEFRotationMatrix(
      time,
      matrixScratch2
    ).transpose()
    result.sub(
      vectorScratch
        .copy(observerECEF)
        .applyMatrix4(matrixECEFToECI)
        .multiplyScalar(METER_TO_AU)
    )
  }
  return result.normalize()
}

function getDirectionECEF(
  body: Body,
  date: number | Date | AstroTime,
  result: Vec3,
  observerECEF?: Vec3
): Vec3 {
  const time = toAstroTime(date)
  return getDirectionECI(body, time, result, observerECEF).applyMatrix4(
    getECIToECEFRotationMatrix(time, matrixScratch1)
  )
}

// The observer is an ECEF position in metres, as takram takes it. Build one
// from radians with geodeticToECEF
export function getSunDirectionECEF(
  date: number | Date | AstroTime,
  result = new Vec3(),
  observerECEF?: Vec3
): Vec3 {
  return getDirectionECEF(Body.Sun, date, result, observerECEF)
}

export function getMoonDirectionECEF(
  date: number | Date | AstroTime,
  result = new Vec3(),
  observerECEF?: Vec3
): Vec3 {
  return getDirectionECEF(Body.Moon, date, result, observerECEF)
}

// Moonlight: twilight hands the march's one light from the sun to the moon

// Full-moon irradiance as a fraction of the sun's, 10^(-0.4 * (-12.74 + 26.74))
export const FULL_MOON_IRRADIANCE_RATIO = 2.5e-6

// Civil twilight, sin(-6 deg)
export const TWILIGHT_SIN_ELEVATION = -0.104528

// 0 while the sun is up, 1 once it is 6 degrees below the horizon
export function twilightBlend(sunElevation: number): number {
  const t = Math.min(Math.max(-sunElevation / -TWILIGHT_SIN_ELEVATION, 0), 1)
  return t * t * (3 - 2 * t)
}

// The lit fraction of the disc, from the sun-moon elongation
export function illuminatedFraction(
  sunDirection: Vec3,
  moonDirection: Vec3
): number {
  return (1 - sunDirection.dot(moonDirection)) / 2
}

export interface MoonlightResult {
  readonly lightDirection: Vec3
  readonly irradianceRatio: Vec3
}

const _up = /*#__PURE__*/ new Vec3()
const _moon = /*#__PURE__*/ new Vec3()
const _light = /*#__PURE__*/ new Vec3()

// The march's light direction and the moon's share of the irradiance. A zero
// moon leaves the sun in charge, and gain 0 is the option off
export function moonlight(
  sunDirection: Vec3,
  moonDirection: Vec3,
  cameraPositionECEF: Vec3,
  gain: number,
  color: Vec3,
  out: MoonlightResult
): { blend: number; illuminated: number } {
  // A degenerate sun is passed through, never normalised into NaN
  if (sunDirection.lengthSq() === 0) {
    out.lightDirection.copy(sunDirection)
    out.irradianceRatio.set(0, 0, 0)
    return { blend: 0, illuminated: 0 }
  }
  _up.copy(cameraPositionECEF)
  const hasUp = _up.lengthSq() > 0
  if (hasUp) _up.normalize()

  const blend = twilightBlend(hasUp ? sunDirection.dot(_up) : -1)
  const illuminated = illuminatedFraction(sunDirection, moonDirection)

  _moon.copy(moonDirection)
  const hasMoon = _moon.lengthSq() > 0
  if (hasMoon) _moon.normalize()

  _light
    .copy(sunDirection)
    .lerp(hasMoon ? _moon : sunDirection, blend)
    .normalize()
  out.lightDirection.copy(_light)

  const share = FULL_MOON_IRRADIANCE_RATIO * illuminated * gain * blend
  out.irradianceRatio.copy(color).multiplyScalar(share)
  return { blend, illuminated }
}
