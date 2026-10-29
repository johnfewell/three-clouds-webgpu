// Ported from three.js r185 (MIT, Copyright (c) 2010-2026 three.js authors)
// https://github.com/mrdoob/three.js/tree/r185/src
// The built-in uniforms three writes for the default graph: screen size,
// viewport, pixel ratio, model matrices, the full-screen quad's camera and
// the textures' UV transform. A three-free runtime must write the same bytes

import { cameraWorldPosition, type CameraState } from './camera'
import { Mat3, Mat4, Vec2, Vec3, Vec4 } from './math'

export interface BuiltinUniformValues {
  // three_screenSize of a pass drawing into the canvas size. It is the size
  // of the pass's own target, so the march pass reads the march size
  readonly screenSize: Vec2
  // three_viewport: the full drawing buffer
  readonly viewport: Vec4
  // three_dpr
  pixelRatio: number
  // three_modelWorldMatrix of every full-screen pass, the identity
  readonly modelWorldMatrix: Mat4
  // three_modelWorldMatrix of StarsNode's points, which follow the camera
  readonly starsModelWorldMatrix: Mat4
  // cameraProjectionMatrix and cameraViewMatrix of a QuadMesh pass
  readonly quadProjectionMatrix: Mat4
  readonly quadViewMatrix: Mat4
  // three_matrixUniform of a texture at default offset, repeat and rotation
  readonly uvTransform: Mat3
  // shadowConsumer_screenResolution: renderer.getSize(), CSS pixels
  readonly screenResolution: Vec2
}

export function createBuiltinUniformValues(): BuiltinUniformValues {
  return {
    screenSize: new Vec2(),
    viewport: new Vec4(),
    pixelRatio: 1,
    modelWorldMatrix: new Mat4(),
    starsModelWorldMatrix: new Mat4(),
    // QuadMesh's OrthographicCamera(-1, 1, 1, -1, 0, 1) on WebGPU: the -0s of
    // its x and y offsets are kept
    quadProjectionMatrix: new Mat4().makeOrthographic(
      -1,
      1,
      1,
      -1,
      0,
      1,
      'webgpu'
    ),
    quadViewMatrix: new Mat4(),
    uvTransform: new Mat3().setUvTransform(0, 0, 1, 1, 0, 0, 0),
    screenResolution: new Vec2()
  }
}

const _position = /*#__PURE__*/ new Vec3()
const _identity = /*#__PURE__*/ new Mat4()

// The renderer's sizes: the drawing buffer in device pixels and the CSS
// size the app set, which is floor-rounded on the way, so neither derives
// the other exactly
export interface RendererSize {
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  pixelRatio: number
}

export function updateBuiltinUniformValues(
  u: BuiltinUniformValues,
  size: RendererSize,
  camera: CameraState
): BuiltinUniformValues {
  u.screenSize.set(size.width, size.height)
  u.viewport.set(0, 0, size.width, size.height)
  u.pixelRatio = size.pixelRatio
  u.screenResolution.set(size.cssWidth, size.cssHeight)
  // points.position.copy(camera.position), composed with no rotation
  u.starsModelWorldMatrix
    .copy(_identity)
    .setPosition(cameraWorldPosition(camera, _position))
  return u
}
