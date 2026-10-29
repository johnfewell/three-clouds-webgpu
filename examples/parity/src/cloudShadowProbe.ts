// A ground patch whose colour IS the public cloud shadow. Proves a
// material of the consumer's own takes the shadow: the patch is lit by nothing
// but `cloudsPass.cloudShadowAt(positionWorld)`

// Nothing here enters the parity scene. The mesh is built on demand and drawn
// into its own target, so no capture can see it and the ladder cannot move

import {
  DataUtils,
  HalfFloatType,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector3
} from 'three'
import type { CloudsPassNode } from 'three-clouds-webgpu'
import { positionWorld, vec3 } from 'three/tsl'
import {
  MeshBasicNodeMaterial,
  RenderTarget,
  type WebGPURenderer
} from 'three/webgpu'

export interface CloudShadowProbeOptions {
  renderer: WebGPURenderer
  pass: CloudsPassNode
  /** The patch's centre in ECEF metres, as the parity scene positions its meshes */
  anchorECEF: Vector3
  /** East-north-up frame at the anchor: the patch's local +z is up */
  enuAtAnchor: Matrix4
  /** Patch edge length in metres */
  spanMetres?: number
  /** Target resolution, square */
  size?: number
}

export interface CloudShadowProbePixels {
  width: number
  height: number
  /** Row-major, top-first, one channel: the transmittance at each texel */
  data: number[]
  min: number
  max: number
  mean: number
  /** Fraction of texels below 0.5, i.e. standing under a cloud */
  shadowedFraction: number
}

const ALTITUDE_METRES = 4000

export function createCloudShadowProbe(opts: CloudShadowProbeOptions): {
  render: () => Promise<CloudShadowProbePixels>
  spanMetres: number
  dispose: () => void
} {
  const {
    renderer,
    pass,
    anchorECEF,
    enuAtAnchor,
    spanMetres = 30_000,
    size = 96
  } = opts

  // The patch is a horizontal square, so the ENU up is its normal and the ENU
  // north its +y, as the parity scene's plane. 30 km: at 6 km this pose measured
  // 99.8 % of the texels shadowed, one cloud and no gap to see
  const rotation = new Matrix4().extractRotation(enuAtAnchor)
  const up = new Vector3(0, 0, 1).applyMatrix4(rotation).normalize()
  const north = new Vector3(0, 1, 0).applyMatrix4(rotation).normalize()

  const scene = new Scene()
  const camera = new OrthographicCamera(
    -spanMetres / 2,
    spanMetres / 2,
    spanMetres / 2,
    -spanMetres / 2,
    1,
    4 * ALTITUDE_METRES
  )
  camera.up.copy(north)
  camera.position.copy(anchorECEF).addScaledVector(up, ALTITUDE_METRES)
  camera.lookAt(anchorECEF)
  camera.updateMatrixWorld()

  // The whole claim in one line: a material multiplied by the public shadow
  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec3(pass.cloudShadowAt(positionWorld))
  // A probe value, not a picture: no tone curve, so a texel IS the 0..1
  material.toneMapped = false

  const mesh = new Mesh(new PlaneGeometry(spanMetres, spanMetres), material)
  mesh.position.copy(anchorECEF)
  mesh.quaternion.setFromRotationMatrix(enuAtAnchor)
  mesh.updateMatrixWorld()
  scene.add(mesh)

  const rt = new RenderTarget(size, size, { type: HalfFloatType })

  async function render(): Promise<CloudShadowProbePixels> {
    renderer.setRenderTarget(rt)
    await renderer.renderAsync(scene, camera)
    renderer.setRenderTarget(null)
    // A half-float target reads back as raw 16-bit patterns, so each channel is
    // expanded here rather than by three: the probe's unit is transmittance
    const raw = (await renderer.readRenderTargetPixelsAsync(
      rt,
      0,
      0,
      size,
      size
    )) as Uint16Array
    const data: number[] = []
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let shadowed = 0
    for (let i = 0; i < size * size; i++) {
      const v = DataUtils.fromHalfFloat(raw[i * 4] ?? 0)
      data.push(v)
      if (v < min) min = v
      if (v > max) max = v
      sum += v
      if (v < 0.5) shadowed++
    }
    return {
      width: size,
      height: size,
      data,
      min,
      max,
      mean: sum / (size * size),
      shadowedFraction: shadowed / (size * size)
    }
  }

  return {
    render,
    spanMetres,
    dispose: () => {
      rt.dispose()
      material.dispose()
      mesh.geometry.dispose()
    }
  }
}
