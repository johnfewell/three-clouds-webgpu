// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  Matrix4,
  Vector3,
  Vector4,
  type Camera,
  type PerspectiveCamera,
  type Vector2
} from 'three'
import { uniform } from 'three/tsl'

import { bayerOffsets } from './resolve/bayer'

const _vec3 = new Vector3()
const _vec4 = new Vector4()
const _projScratch = new Matrix4()

export class CameraUniforms {
  // clouds.vert: inverseViewMatrix, viewMatrix
  readonly viewMatrix = uniform(new Matrix4()).setName('camera_viewMatrix')
  readonly inverseViewMatrix = uniform(new Matrix4()).setName(
    'camera_inverseViewMatrix'
  )

  // clouds.vert: inverseProjectionMatrix
  // Phase 2 jitters this, Phase 0 copies projectionMatrixInverse directly
  readonly inverseProjectionMatrix = uniform(new Matrix4()).setName(
    'camera_inverseProjectionMatrix'
  )

  readonly cameraNear = uniform(0).setName('camera_cameraNear')
  readonly cameraFar = uniform(0).setName('camera_cameraFar')

  // clouds.vert: cameraPosition (world space)
  readonly cameraPosition = uniform(new Vector3()).setName(
    'camera_cameraPosition'
  )

  // clouds.vert:73: vCameraPosition = (worldToECEFMatrix * vec4(cameraPosition, 1.0)).xyz
  readonly cameraPositionECEF = uniform(new Vector3()).setName(
    'camera_cameraPositionECEF'
  )

  // clouds.vert:74: normalize((worldToECEFMatrix * vec4(cameraDirection, 0.0)).xyz)
  // where cameraDirection = normalize((inverseViewMatrix * vec4(0,0,-1,0)).xyz)
  readonly cameraDirectionECEF = uniform(new Vector3()).setName(
    'camera_cameraDirectionECEF'
  )

  // CloudsMaterial.ts:363–369, temporal reprojection (non-jittered in Phase 0)
  readonly reprojectionMatrix = uniform(new Matrix4()).setName(
    'camera_reprojectionMatrix'
  )
  readonly viewReprojectionMatrix = uniform(new Matrix4()).setName(
    'camera_viewReprojectionMatrix'
  )

  // CloudsMaterial.ts:393–398, stored after each render
  private previousProjectionMatrix: Matrix4 | null = null
  private previousViewMatrix: Matrix4 | null = null

  isPerspectiveCamera = true

  update(
    camera: Camera,
    worldToECEFMatrix: Matrix4,
    temporal?: { frame: number; resolution: Vector2; jitterOut: Vector2 }
  ): void {
    // CloudsMaterial.ts:314–324, perspective vs orthographic
    this.isPerspectiveCamera =
      (camera as PerspectiveCamera).isPerspectiveCamera === true

    // CloudsMaterial.ts:326–328
    this.viewMatrix.value.copy(camera.matrixWorldInverse)
    this.inverseViewMatrix.value.copy(camera.matrixWorld)

    // CloudsMaterial.ts:372–374
    const pc = camera as PerspectiveCamera
    this.cameraNear.value = pc.near ?? 0.1
    this.cameraFar.value = pc.far ?? 2000

    // CloudsMaterial.ts:376–378
    camera.getWorldPosition(this.cameraPosition.value)

    // clouds.vert:73: cameraPositionECEF = (worldToECEFMatrix * vec4(cameraPosition, 1.0)).xyz
    this.cameraPositionECEF.value
      .copy(this.cameraPosition.value)
      .applyMatrix4(worldToECEFMatrix)

    // clouds.vert:72–74: cameraDirection = normalize((inverseView * vec4(0,0,-1,0)).xyz)
    // then cameraDirectionECEF = (worldToECEFMatrix * vec4(cameraDirection, 0.0)).xyz
    _vec4.set(0, 0, -1, 0).applyMatrix4(camera.matrixWorld)
    _vec3.set(_vec4.x, _vec4.y, _vec4.z).normalize()
    _vec4.set(_vec3.x, _vec3.y, _vec3.z, 0).applyMatrix4(worldToECEFMatrix)
    this.cameraDirectionECEF.value.set(_vec4.x, _vec4.y, _vec4.z).normalize()

    const prevProj = this.previousProjectionMatrix ?? camera.projectionMatrix
    const prevView = this.previousViewMatrix ?? camera.matrixWorldInverse
    const inverseView = this.inverseViewMatrix.value

    // Cite: CloudsMaterial.ts:338–370
    if (temporal != null) {
      const frame16 = temporal.frame % 16
      const offset = bayerOffsets[frame16]!
      const dx = ((offset.x - 0.5) / temporal.resolution.x) * 4
      const dy = ((offset.y - 0.5) / temporal.resolution.y) * 4
      temporal.jitterOut.set(dx, dy)

      // Jittered inverse projection
      _projScratch.copy(camera.projectionMatrix)
      _projScratch.elements[8] += dx * 2
      _projScratch.elements[9] += dy * 2
      this.inverseProjectionMatrix.value.copy(_projScratch).invert()

      // Jittered reprojection from previous frame
      this.reprojectionMatrix.value.copy(prevProj)
      this.reprojectionMatrix.value.elements[8] += dx * 2
      this.reprojectionMatrix.value.elements[9] += dy * 2
      this.reprojectionMatrix.value.multiply(prevView)
      this.viewReprojectionMatrix.value
        .copy(this.reprojectionMatrix.value)
        .multiply(inverseView)
    } else {
      this.inverseProjectionMatrix.value.copy(camera.projectionMatrixInverse)
      this.reprojectionMatrix.value.copy(prevProj).multiply(prevView)
      this.viewReprojectionMatrix.value
        .copy(this.reprojectionMatrix.value)
        .multiply(inverseView)
    }
  }

  // CloudsMaterial.ts:391–398, called after each render by CloudsPassNode
  copyReprojectionMatrix(camera: Camera): void {
    this.previousProjectionMatrix ??= new Matrix4()
    this.previousViewMatrix ??= new Matrix4()
    this.previousProjectionMatrix.copy(camera.projectionMatrix)
    this.previousViewMatrix.copy(camera.matrixWorldInverse)
  }

  // Cite: CloudsPass.ts:203–224 (setSize invalidates history)
  resetPreviousMatrices(): void {
    this.previousProjectionMatrix = null
    this.previousViewMatrix = null
  }
}
