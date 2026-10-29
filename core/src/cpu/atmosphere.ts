// Ported from @takram/three-atmosphere 0.19.1 webgpu/AtmosphereContext.ts and
// the sky nodes' defaults (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// The atmosphere context's per-render values, which the composite, sky and
// stars read. The camera matrices those passes read are CameraState's own

import type { CameraState } from './camera'
import {
  Ellipsoid,
  geodeticHeight,
  getAltitudeCorrectionOffset
} from './geodesy'
import { Mat4, Vec2, Vec3 } from './math'

// What the app sets on the context. takram's uniforms default to an identity
// matrix and a zero vector, which is what an unset field is here
export interface AtmosphereInputs {
  readonly matrixWorldToECEF: Mat4
  readonly matrixECIToECEF: Mat4
  readonly matrixMoonFixedToECEF: Mat4
  readonly sunDirectionECEF: Vec3
  readonly moonDirectionECEF: Vec3
  // AtmosphereParameters.bottomRadius, the atmosphere's and not the clouds'
  bottomRadius: number
  ellipsoid: Ellipsoid
  // SunNode, MoonNode and StarsNode defaults
  sunAngularRadius: number
  sunIntensity: number
  moonAngularRadius: number
  moonIntensity: number
  starsPointSize: number
  starsIntensity: number
  readonly starsMagnitudeRange: Vec2
}

export function createAtmosphereInputs(): AtmosphereInputs {
  return {
    matrixWorldToECEF: new Mat4(),
    matrixECIToECEF: new Mat4(),
    matrixMoonFixedToECEF: new Mat4(),
    sunDirectionECEF: new Vec3(),
    moonDirectionECEF: new Vec3(),
    bottomRadius: 6360000,
    ellipsoid: Ellipsoid.WGS84,
    sunAngularRadius: 0.004675,
    sunIntensity: 1,
    moonAngularRadius: 0.0045,
    moonIntensity: 1,
    starsPointSize: 1,
    starsIntensity: 1000,
    starsMagnitudeRange: new Vec2(-2, 8)
  }
}

export interface AtmosphereUniformValues {
  readonly matrixWorldToECEF: Mat4
  // The transpose, not the inverse: takram requires an orthogonal frame
  readonly matrixECEFToWorld: Mat4
  readonly matrixECIToECEF: Mat4
  readonly matrixMoonFixedToECEF: Mat4
  readonly sunDirectionECEF: Vec3
  readonly moonDirectionECEF: Vec3
  readonly cameraPositionECEF: Vec3
  // Computed whatever correctAltitude says, as takram does
  readonly altitudeCorrectionECEF: Vec3
  cameraHeight: number
}

export function createAtmosphereUniformValues(): AtmosphereUniformValues {
  return {
    matrixWorldToECEF: new Mat4(),
    matrixECEFToWorld: new Mat4(),
    matrixECIToECEF: new Mat4(),
    matrixMoonFixedToECEF: new Mat4(),
    sunDirectionECEF: new Vec3(),
    moonDirectionECEF: new Vec3(),
    cameraPositionECEF: new Vec3(),
    altitudeCorrectionECEF: new Vec3(),
    cameraHeight: 0
  }
}

export function updateAtmosphereUniformValues(
  u: AtmosphereUniformValues,
  inputs: AtmosphereInputs,
  camera: CameraState
): AtmosphereUniformValues {
  u.matrixWorldToECEF.copy(inputs.matrixWorldToECEF)
  u.matrixECEFToWorld.copy(inputs.matrixWorldToECEF).transpose()
  u.matrixECIToECEF.copy(inputs.matrixECIToECEF)
  u.matrixMoonFixedToECEF.copy(inputs.matrixMoonFixedToECEF)
  u.sunDirectionECEF.copy(inputs.sunDirectionECEF)
  u.moonDirectionECEF.copy(inputs.moonDirectionECEF)
  u.cameraPositionECEF
    .setFromMatrixPosition(camera.matrixWorld)
    .applyMatrix4(inputs.matrixWorldToECEF)
  getAltitudeCorrectionOffset(
    u.cameraPositionECEF,
    inputs.bottomRadius,
    inputs.ellipsoid,
    u.altitudeCorrectionECEF
  )
  // takram throws where the camera cannot be projected and keeps the value
  const height = geodeticHeight(u.cameraPositionECEF)
  if (height != null) u.cameraHeight = height
  return u
}
