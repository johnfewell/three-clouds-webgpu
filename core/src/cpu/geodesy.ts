// Ported from @takram/three-geospatial 0.9.1 and @takram/three-atmosphere
// 0.19.1 (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Ellipsoid, Geodetic.setFromECEF, projectOnEllipsoidSurface and
// getAltitudeCorrectionOffset, with the same operation order

import { Vec3 } from './math'

export class Ellipsoid {
  static readonly WGS84 = /*#__PURE__*/ new Ellipsoid(
    6378137,
    6378137,
    6356752.3142451793
  )

  readonly radii: Vec3

  constructor(x: number, y: number, z: number) {
    this.radii = new Vec3(x, y, z)
  }

  reciprocalRadiiSquared(result = new Vec3()): Vec3 {
    const { x, y, z } = this.radii
    return result.set(1 / x ** 2, 1 / y ** 2, 1 / z ** 2)
  }

  projectOnSurface(
    position: Vec3,
    result = new Vec3(),
    centerTolerance?: number
  ): Vec3 | undefined {
    return projectOnEllipsoidSurface(
      position,
      this.reciprocalRadiiSquared(),
      result,
      centerTolerance
    )
  }

  getSurfaceNormal(position: Vec3, result = new Vec3()): Vec3 {
    return result
      .multiplyVectors(this.reciprocalRadiiSquared(vectorScratch1), position)
      .normalize()
  }

  // Only for an ellipsoid of revolution about z, as takram asserts
  getOsculatingSphereCenter(
    surfacePosition: Vec3,
    radius: number,
    result = new Vec3()
  ): Vec3 {
    if (this.radii.x !== this.radii.y) {
      throw new Error('Osculating sphere needs radii.x === radii.y')
    }
    const a2 = this.radii.x ** 2
    const b2 = this.radii.z ** 2
    const normal = vectorScratch1
      .set(
        surfacePosition.x / a2,
        surfacePosition.y / a2,
        surfacePosition.z / b2
      )
      .normalize()
    return result.copy(normal.multiplyScalar(-radius).add(surfacePosition))
  }
}

const vectorScratch1 = /*#__PURE__*/ new Vec3()
const vectorScratch2 = /*#__PURE__*/ new Vec3()
const projectScratch = /*#__PURE__*/ new Vec3()
const altitudeScratch = /*#__PURE__*/ new Vec3()

// Newton iteration onto the surface, after Cesium's scaleToGeodeticSurface
// See: https://github.com/CesiumGS/cesium/blob/1.122/packages/engine/Source/Core/scaleToGeodeticSurface.js
export function projectOnEllipsoidSurface(
  position: Vec3,
  reciprocalRadiiSquared: Vec3,
  result = new Vec3(),
  centerTolerance = 0.1
): Vec3 | undefined {
  const { x, y, z } = position
  const rx = reciprocalRadiiSquared.x
  const ry = reciprocalRadiiSquared.y
  const rz = reciprocalRadiiSquared.z
  const x2 = x * x * rx
  const y2 = y * y * ry
  const z2 = z * z * rz

  const normSquared = x2 + y2 + z2
  const ratio = Math.sqrt(1 / normSquared)
  // At or very near the centre
  if (!Number.isFinite(ratio)) {
    return undefined
  }

  // The radial intersection is the first guess
  const intersection = projectScratch.copy(position).multiplyScalar(ratio)
  if (normSquared < centerTolerance) {
    return result.copy(intersection)
  }

  // The gradient stands in for the unit normal, its length is absorbed below
  const gradient = intersection
    .multiply(reciprocalRadiiSquared)
    .multiplyScalar(2)
  let lambda = ((1 - ratio) * position.length()) / (gradient.length() / 2)

  let correction = 0
  let sx: number
  let sy: number
  let sz: number
  let error: number
  do {
    lambda -= correction
    sx = 1 / (1 + lambda * rx)
    sy = 1 / (1 + lambda * ry)
    sz = 1 / (1 + lambda * rz)
    const sx2 = sx * sx
    const sy2 = sy * sy
    const sz2 = sz * sz
    const sx3 = sx2 * sx
    const sy3 = sy2 * sy
    const sz3 = sz2 * sz
    error = x2 * sx2 + y2 * sy2 + z2 * sz2 - 1
    correction = error / ((x2 * sx3 * rx + y2 * sy3 * ry + z2 * sz3 * rz) * -2)
  } while (Math.abs(error) > 1e-12)

  return result.set(x * sx, y * sy, z * sz)
}

// Geodetic.setFromECEF's height, the only member the clouds read. Returns
// undefined where takram throws, at the centre
export function geodeticHeight(
  position: Vec3,
  ellipsoid = Ellipsoid.WGS84
): number | undefined {
  const reciprocalRadiiSquared =
    ellipsoid.reciprocalRadiiSquared(vectorScratch1)
  const projection = projectOnEllipsoidSurface(
    position,
    reciprocalRadiiSquared,
    vectorScratch2
  )
  if (projection == null) return undefined
  const height = vectorScratch1.subVectors(position, projection)
  return Math.sign(height.dot(position)) * height.length()
}

// Geodetic.toECEF, for an observer given in radians and metres
export function geodeticToECEF(
  longitude: number,
  latitude: number,
  height: number,
  result = new Vec3(),
  ellipsoid = Ellipsoid.WGS84
): Vec3 {
  const radiiSquared = vectorScratch1.multiplyVectors(
    ellipsoid.radii,
    ellipsoid.radii
  )
  const cosLatitude = Math.cos(latitude)
  const normal = vectorScratch2
    .set(
      cosLatitude * Math.cos(longitude),
      cosLatitude * Math.sin(longitude),
      Math.sin(latitude)
    )
    .normalize()
  result.multiplyVectors(radiiSquared, normal)
  return result
    .divideScalar(Math.sqrt(normal.dot(result)))
    .add(normal.multiplyScalar(height))
}

// The offset that puts the camera's surface point on a sphere of
// bottomRadius, from @takram/three-atmosphere getAltitudeCorrectionOffset
export function getAltitudeCorrectionOffset(
  cameraPosition: Vec3,
  bottomRadius: number,
  ellipsoid: Ellipsoid,
  result: Vec3
): Vec3 {
  const surfacePosition = ellipsoid.projectOnSurface(
    cameraPosition,
    altitudeScratch
  )
  return surfacePosition != null
    ? ellipsoid
        .getOsculatingSphereCenter(surfacePosition, bottomRadius, result)
        .negate()
    : result.setScalar(0)
}
