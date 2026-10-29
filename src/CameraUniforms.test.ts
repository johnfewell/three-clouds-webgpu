import {
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem
} from 'three'
import { describe, expect, it } from 'vitest'

import { expectClose } from '../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../test/helpers/log'
import { CameraUniforms } from './CameraUniforms'

class ReversedPerspectiveCamera extends PerspectiveCamera {
  override get reversedDepth(): boolean {
    return true
  }
}

describe('CameraUniforms', () => {
  setCurrentSpec('CameraUniforms')

  it('reversed projection preserves jittered perspective rays and temporal UV reprojection', () => {
    const cameras = [
      new PerspectiveCamera(60, 16 / 9, 1, 60_000),
      new ReversedPerspectiveCamera(60, 16 / 9, 1, 60_000)
    ]
    const uniforms = cameras.map(camera => {
      camera.coordinateSystem = WebGPUCoordinateSystem
      camera.position.set(0, 100, 500)
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
      const result = new CameraUniforms()
      result.update(camera, new Matrix4())
      result.copyReprojectionMatrix(camera)
      return result
    })
    const rows = []
    for (let frame = 0; frame < 16; frame++) {
      const samples = cameras.map((camera, index) => {
        camera.position.x += 0.25
        camera.lookAt(0, 0, 0)
        camera.updateMatrixWorld(true)
        const values = uniforms[index]!
        values.update(camera, new Matrix4(), {
          frame,
          resolution: new Vector2(640, 360),
          jitterOut: new Vector2()
        })
        const view = new Vector4(0.3, -0.2, 1, 1).applyMatrix4(
          values.inverseProjectionMatrix.value
        )
        const ray = new Vector3(view.x, view.y, view.z).transformDirection(
          values.inverseViewMatrix.value
        )
        const hit = new Vector4(20, 10, -5000, 1).applyMatrix4(
          values.reprojectionMatrix.value
        )
        hit.divideScalar(hit.w)
        const miss = new Vector4(
          view.x * camera.far,
          view.y * camera.far,
          view.z * camera.far,
          1
        ).applyMatrix4(values.viewReprojectionMatrix.value)
        miss.divideScalar(miss.w)
        values.copyReprojectionMatrix(camera)
        return { ray, hit: [hit.x, hit.y], miss: [miss.x, miss.y] }
      })
      expectClose(samples[1]!.ray, samples[0]!.ray, {
        abs: 1e-12,
        label: `ray:${frame}`
      })
      expectClose(samples[1]!.hit, samples[0]!.hit, {
        abs: 1e-12,
        label: `hit-reprojection:${frame}`
      })
      expectClose(samples[1]!.miss, samples[0]!.miss, {
        abs: 1e-12,
        label: `miss-reprojection:${frame}`
      })
      rows.push({
        frame,
        rayDifference: samples[1]!.ray.distanceTo(samples[0]!.ray)
      })
    }
    log('CameraUniforms:reversedDepth', rows)
  })

  function setupCamera(
    pos: Vector3 = new Vector3(0, 100, 500),
    lookAt: Vector3 = new Vector3(0, 0, 0)
  ): PerspectiveCamera {
    const cam = new PerspectiveCamera(60, 16 / 9, 0.5, 5000)
    cam.position.copy(pos)
    cam.lookAt(lookAt)
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    return cam
  }

  it('viewMatrix equals camera.matrixWorldInverse', () => {
    const cam = setupCamera()
    const cu = new CameraUniforms()
    cu.update(cam, new Matrix4())

    expectClose(
      Array.from(cu.viewMatrix.value.elements),
      Array.from(cam.matrixWorldInverse.elements),
      { abs: 1e-10, label: 'viewMatrix' }
    )

    log('CameraUniforms', {
      test: 'viewMatrix',
      actual: cu.viewMatrix.value.elements.slice(0, 4),
      expected: cam.matrixWorldInverse.elements.slice(0, 4)
    })
  })

  it('inverseViewMatrix equals camera.matrixWorld', () => {
    const cam = setupCamera()
    const cu = new CameraUniforms()
    cu.update(cam, new Matrix4())

    expectClose(
      Array.from(cu.inverseViewMatrix.value.elements),
      Array.from(cam.matrixWorld.elements),
      { abs: 1e-10, label: 'inverseViewMatrix' }
    )
  })

  it('inverseProjectionMatrix equals camera.projectionMatrixInverse', () => {
    const cam = setupCamera()
    const cu = new CameraUniforms()
    cu.update(cam, new Matrix4())

    expectClose(
      Array.from(cu.inverseProjectionMatrix.value.elements),
      Array.from(cam.projectionMatrixInverse.elements),
      { abs: 1e-10, label: 'inverseProjectionMatrix' }
    )
  })

  it('cameraNear and cameraFar match camera', () => {
    const cam = setupCamera()
    const cu = new CameraUniforms()
    cu.update(cam, new Matrix4())

    expect(cu.cameraNear.value).toBe(cam.near)
    expect(cu.cameraFar.value).toBe(cam.far)

    log('CameraUniforms', {
      test: 'near/far',
      near: cu.cameraNear.value,
      far: cu.cameraFar.value
    })
  })

  it('cameraPosition equals world position', () => {
    const pos = new Vector3(100, 200, 300)
    const cam = setupCamera(pos)
    const cu = new CameraUniforms()
    cu.update(cam, new Matrix4())

    expectClose(cu.cameraPosition.value, pos, {
      abs: 1e-10,
      label: 'cameraPosition'
    })
  })

  it('cameraPositionECEF matches CPU computation under non-identity worldToECEF', () => {
    const pos = new Vector3(100, 200, 300)
    const cam = setupCamera(pos)
    const cu = new CameraUniforms()

    const worldToECEF = new Matrix4()
      .makeRotationY(Math.PI / 2)
      .setPosition(1000, 2000, 3000)

    cu.update(cam, worldToECEF)

    const expected = pos.clone().applyMatrix4(worldToECEF)
    expectClose(cu.cameraPositionECEF.value, expected, {
      abs: 1e-6,
      label: 'cameraPositionECEF'
    })

    log('CameraUniforms', {
      test: 'cameraPositionECEF',
      actual: [
        cu.cameraPositionECEF.value.x,
        cu.cameraPositionECEF.value.y,
        cu.cameraPositionECEF.value.z
      ],
      expected: [expected.x, expected.y, expected.z]
    })
  })

  it('cameraDirectionECEF matches CPU computation under non-identity worldToECEF', () => {
    const cam = setupCamera(new Vector3(0, 100, 500), new Vector3(0, 0, 0))
    const cu = new CameraUniforms()

    const worldToECEF = new Matrix4()
      .makeRotationY(Math.PI / 2)
      .setPosition(1000, 2000, 3000)

    cu.update(cam, worldToECEF)

    // cameraDirection = normalize((inverseView * vec4(0,0,-1,0)).xyz)
    const v4 = new Vector4(0, 0, -1, 0).applyMatrix4(cam.matrixWorld)
    const dir = new Vector3(v4.x, v4.y, v4.z).normalize()
    // dirECEF = normalize((worldToECEF * vec4(dir, 0)).xyz)
    const v4e = new Vector4(dir.x, dir.y, dir.z, 0).applyMatrix4(worldToECEF)
    const expected = new Vector3(v4e.x, v4e.y, v4e.z).normalize()

    expectClose(cu.cameraDirectionECEF.value, expected, {
      abs: 1e-6,
      label: 'cameraDirectionECEF'
    })

    log('CameraUniforms', {
      test: 'cameraDirectionECEF',
      actual: [
        cu.cameraDirectionECEF.value.x,
        cu.cameraDirectionECEF.value.y,
        cu.cameraDirectionECEF.value.z
      ],
      expected: [expected.x, expected.y, expected.z]
    })
  })

  it('viewReprojectionMatrix maps view-space to same NDC for a static camera', () => {
    const cam = setupCamera()
    const cu = new CameraUniforms()

    cu.update(cam, new Matrix4())
    cu.copyReprojectionMatrix(cam)
    cu.update(cam, new Matrix4())

    // viewReproj = prevProj * prevView * inverseView = proj (for static camera)
    const ndc = new Vector4(0.5, 0.3, 0.5, 1)
    const viewPos = ndc.clone().applyMatrix4(cam.projectionMatrixInverse)
    const result = viewPos.clone().applyMatrix4(cu.viewReprojectionMatrix.value)
    result.divideScalar(result.w)

    expectClose(result.x, ndc.x, { abs: 1e-6, label: 'viewReproj x' })
    expectClose(result.y, ndc.y, { abs: 1e-6, label: 'viewReproj y' })
    expectClose(result.z, ndc.z, { abs: 1e-6, label: 'viewReproj z' })

    log('CameraUniforms', {
      test: 'viewReprojection static',
      inputNDC: [ndc.x, ndc.y, ndc.z],
      outputNDC: [result.x, result.y, result.z]
    })
  })

  it('isPerspectiveCamera selects the correct branch', () => {
    const cu = new CameraUniforms()

    const persp = setupCamera()
    cu.update(persp, new Matrix4())
    expect(cu.isPerspectiveCamera).toBe(true)

    const ortho = new OrthographicCamera(-10, 10, 10, -10, 0.1, 1000)
    ortho.updateMatrixWorld(true)
    cu.update(ortho, new Matrix4())
    expect(cu.isPerspectiveCamera).toBe(false)

    log('CameraUniforms', {
      test: 'isPerspectiveCamera',
      perspective: true,
      orthographic: false
    })
  })

  it('previous matrices after one update equal the current ones', () => {
    const cam = setupCamera()
    const cu = new CameraUniforms()

    cu.update(cam, new Matrix4())
    cu.copyReprojectionMatrix(cam)
    cu.update(cam, new Matrix4())

    const expected = new Matrix4()
      .copy(cam.projectionMatrix)
      .multiply(cam.matrixWorldInverse)

    expectClose(
      Array.from(cu.reprojectionMatrix.value.elements),
      Array.from(expected.elements),
      { abs: 1e-10, label: 'reprojectionMatrix' }
    )
  })
})
