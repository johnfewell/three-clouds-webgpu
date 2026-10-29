// The camera as plain data: what three's PerspectiveCamera holds after
// updateMatrixWorld() and updateProjectionMatrix(), with the inverses taken by
// three's own formula, which the spike found the float32 parity depends on

import { DEG2RAD, Mat4, Quat, Vec3, type CoordinateSystem } from './math'

export interface CameraState {
  readonly matrixWorld: Mat4
  readonly matrixWorldInverse: Mat4
  readonly projectionMatrix: Mat4
  readonly projectionMatrixInverse: Mat4
  near: number
  far: number
  isPerspective: boolean
  coordinateSystem: CoordinateSystem
}

export interface PerspectiveOptions {
  fov: number
  aspect: number
  near: number
  far: number
  zoom?: number
  coordinateSystem?: CoordinateSystem
}

export function createCamera(): CameraState {
  return {
    matrixWorld: new Mat4(),
    matrixWorldInverse: new Mat4(),
    projectionMatrix: new Mat4(),
    projectionMatrixInverse: new Mat4(),
    near: 0.1,
    far: 2000,
    isPerspective: true,
    coordinateSystem: 'webgpu'
  }
}

// PerspectiveCamera.updateProjectionMatrix without view offset or film offset
export function setPerspective(
  camera: CameraState,
  {
    fov,
    aspect,
    near,
    far,
    zoom = 1,
    coordinateSystem = 'webgpu'
  }: PerspectiveOptions
): CameraState {
  const top = (near * Math.tan(DEG2RAD * 0.5 * fov)) / zoom
  const height = 2 * top
  const width = aspect * height
  const left = -0.5 * width
  camera.projectionMatrix.makePerspective(
    left,
    left + width,
    top,
    top - height,
    near,
    far,
    coordinateSystem
  )
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  camera.near = near
  camera.far = far
  camera.isPerspective = true
  camera.coordinateSystem = coordinateSystem
  return camera
}

const _one = /*#__PURE__*/ new Vec3(1, 1, 1)
const _m = /*#__PURE__*/ new Mat4()
const _position = /*#__PURE__*/ new Vec3()
const _quaternion = /*#__PURE__*/ new Quat()
const _scale = /*#__PURE__*/ new Vec3()

// Camera.updateMatrixWorld for a camera without a parent. r185 drops scale
// from the view matrix, so a world matrix whose columns are not exactly unit
// length is recomposed at scale 1 before the inverse
export function setCameraWorld(
  camera: CameraState,
  matrixWorld: Mat4
): CameraState {
  camera.matrixWorld.copy(matrixWorld)
  matrixWorld.decompose(_position, _quaternion, _scale)
  if (_scale.x === 1 && _scale.y === 1 && _scale.z === 1) {
    camera.matrixWorldInverse.copy(matrixWorld).invert()
  } else {
    camera.matrixWorldInverse
      .compose(_position, _quaternion, _scale.set(1, 1, 1))
      .invert()
  }
  return camera
}

export function setCameraPose(
  camera: CameraState,
  position: Vec3,
  quaternion: Quat
): CameraState {
  return setCameraWorld(camera, _m.compose(position, quaternion, _one))
}

// Camera.getWorldPosition
export function cameraWorldPosition(
  camera: CameraState,
  result = new Vec3()
): Vec3 {
  return result.setFromMatrixPosition(camera.matrixWorld)
}
