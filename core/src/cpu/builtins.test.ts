// three's built-in uniform values against three's own objects. Several carry
// a -0 that a runtime writing literal identities would lose, so the
// comparison is Object.is per element

import {
  Matrix3,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  Texture,
  WebGPUCoordinateSystem
} from 'three'

import { expectBitExact, mat4From, seededRandom } from '../../test/twin'
import {
  createBuiltinUniformValues,
  updateBuiltinUniformValues
} from './builtins'
import { createCamera, setCameraWorld, setPerspective } from './camera'
import { Mat3 } from './math'

const rand = seededRandom(5)

describe('built-in uniforms match three bit for bit', () => {
  it("QuadMesh's camera, as three builds it on WebGPU", () => {
    // three/src/renderers/common/QuadMesh.js: OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
    camera.coordinateSystem = WebGPUCoordinateSystem
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    const u = createBuiltinUniformValues()
    expectBitExact(
      'quad-camera',
      [...u.quadProjectionMatrix.elements, ...u.quadViewMatrix.elements],
      [
        ...camera.projectionMatrix.elements,
        ...camera.matrixWorldInverse.elements
      ]
    )
    // The -0s are what makes this more than an identity check
    expect(Object.is(u.quadProjectionMatrix.elements[12], -0)).toBe(true)
  })

  it('a default texture UV transform and random ones', () => {
    const texture = new Texture()
    texture.updateMatrix()
    expectBitExact(
      'uv-default',
      createBuiltinUniformValues().uvTransform.elements,
      texture.matrix.elements
    )
    expect(Object.is(texture.matrix.elements[1], -0)).toBe(true)
    for (let i = 0; i < 32; ++i) {
      const args = Array.from({ length: 7 }, () => rand() * 4 - 2) as [
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
      expectBitExact(
        `uv-${i}`,
        new Mat3().setUvTransform(...args).elements,
        new Matrix3().setUvTransform(...args).elements
      )
    }
  })

  it("StarsNode's points follow the camera", () => {
    const camera = new PerspectiveCamera(50, 16 / 9, 100, 1e8)
    camera.coordinateSystem = WebGPUCoordinateSystem
    camera.updateProjectionMatrix()
    camera.position.set(-1274794.25, 1081104.5, -6196721.125)
    camera.lookAt(-1259003, 1067712, -6119447)
    camera.updateMatrixWorld()
    const points = new Points()
    // StarsNode.updateBefore
    points.position.copy(camera.position)
    points.updateMatrixWorld()
    const core = setCameraWorld(
      setPerspective(createCamera(), {
        fov: 50,
        aspect: 16 / 9,
        near: 100,
        far: 1e8
      }),
      mat4From(camera.matrixWorld)
    )
    const u = updateBuiltinUniformValues(
      createBuiltinUniformValues(),
      {
        width: 2874,
        height: 1794,
        cssWidth: 1437,
        cssHeight: 897,
        pixelRatio: 2
      },
      core
    )
    expectBitExact(
      'stars-model',
      u.starsModelWorldMatrix.elements,
      points.matrixWorld.elements
    )
    expectBitExact(
      'sizes',
      [
        u.screenSize.x,
        u.screenSize.y,
        u.viewport.x,
        u.viewport.y,
        u.viewport.z,
        u.viewport.w,
        u.pixelRatio,
        u.screenResolution.x,
        u.screenResolution.y
      ],
      [2874, 1794, 0, 0, 2874, 1794, 2, 1437, 897]
    )
  })
})
