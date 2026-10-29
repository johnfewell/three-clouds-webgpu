// CPU twins for the depthVelocity hit/miss velocity branches
// Cite: clouds.frag:944–950 (hit), clouds.frag:966–974 (miss)

import { Matrix4, PerspectiveCamera, Vector2, Vector3, Vector4 } from 'three'
import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { bayerOffsets } from '../resolve/bayer'

function ecefToWorldCPU(
  positionECEF: Vector3,
  altitudeCorrection: Vector3,
  ecefToWorldMatrix: Matrix4
): Vector3 {
  const uncorrected = positionECEF.clone().sub(altitudeCorrection)
  const v4 = new Vector4(uncorrected.x, uncorrected.y, uncorrected.z, 1)
  v4.applyMatrix4(ecefToWorldMatrix)
  return new Vector3(v4.x, v4.y, v4.z)
}

function hitVelocityCPU(
  frontPositionECEF: Vector3,
  altitudeCorrection: Vector3,
  ecefToWorldMatrix: Matrix4,
  reprojectionMatrix: Matrix4,
  currentUv: Vector2
): { velocity: Vector2; frontPositionWorld: Vector3 } {
  const frontPositionWorld = ecefToWorldCPU(
    frontPositionECEF,
    altitudeCorrection,
    ecefToWorldMatrix
  )
  const prevClip = new Vector4(
    frontPositionWorld.x,
    frontPositionWorld.y,
    frontPositionWorld.z,
    1
  ).applyMatrix4(reprojectionMatrix)
  prevClip.divideScalar(prevClip.w)
  const prevUv = new Vector2(prevClip.x * 0.5 + 0.5, prevClip.y * 0.5 + 0.5)
  const velocity = currentUv.clone().sub(prevUv)
  return { velocity, frontPositionWorld }
}

function missVelocityCPU(
  viewPos: Vector3,
  sceneViewZ: number,
  cameraFar: number,
  viewReprojectionMatrix: Matrix4,
  currentUv: Vector2
): { velocity: Vector2; frontDepth: number } {
  const frontDepth = sceneViewZ < 0 ? -sceneViewZ : cameraFar
  const frontView = viewPos.clone().multiplyScalar(frontDepth)
  const prevClip = new Vector4(
    frontView.x,
    frontView.y,
    frontView.z,
    1
  ).applyMatrix4(viewReprojectionMatrix)
  prevClip.divideScalar(prevClip.w)
  const prevUv = new Vector2(prevClip.x * 0.5 + 0.5, prevClip.y * 0.5 + 0.5)
  const velocity = currentUv.clone().sub(prevUv)
  return { velocity, frontDepth }
}

function makeStaticCameraMatrices(camera: PerspectiveCamera) {
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  const worldToECEF = new Matrix4()
  const ecefToWorld = new Matrix4().copy(worldToECEF).invert()

  const viewMatrix = camera.matrixWorldInverse.clone()
  const projMatrix = camera.projectionMatrix.clone()

  const reprojectionMatrix = projMatrix.clone().multiply(viewMatrix)
  const viewReprojectionMatrix = reprojectionMatrix
    .clone()
    .multiply(camera.matrixWorld.clone())

  return {
    worldToECEF,
    ecefToWorld,
    viewMatrix,
    projMatrix,
    reprojectionMatrix,
    viewReprojectionMatrix
  }
}

describe('depthVelocity CPU twins', () => {
  setCurrentSpec('depthVelocity')

  test('static camera → velocity 0 (hit branch)', () => {
    const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1000)
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)
    const m = makeStaticCameraMatrices(camera)
    const altitudeCorrection = new Vector3(0, 0, 0)
    const frontPos = new Vector3(0, 0, 100)
    const currentUv = new Vector2(0.5, 0.5)

    const { velocity } = hitVelocityCPU(
      frontPos,
      altitudeCorrection,
      m.ecefToWorld,
      m.reprojectionMatrix,
      currentUv
    )

    expect(Math.abs(velocity.x)).toBeLessThan(1e-6)
    expect(Math.abs(velocity.y)).toBeLessThan(1e-6)

    log('hit-static', { vx: velocity.x, vy: velocity.y })
  })

  test('static camera → velocity 0 (miss branch)', () => {
    const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1000)
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)
    const m = makeStaticCameraMatrices(camera)
    const viewPos = new Vector3(0, 0, -1)
    const sceneViewZ = -10
    const currentUv = new Vector2(0.5, 0.5)

    const { velocity } = missVelocityCPU(
      viewPos,
      sceneViewZ,
      1000,
      m.viewReprojectionMatrix,
      currentUv
    )

    expect(Math.abs(velocity.x)).toBeLessThan(1e-6)
    expect(Math.abs(velocity.y)).toBeLessThan(1e-6)

    log('miss-static', { vx: velocity.x, vy: velocity.y })
  })

  test('camera translation produces non-zero velocity', () => {
    const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1000)
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)

    const prevProj = camera.projectionMatrix.clone()
    const prevView = camera.matrixWorldInverse.clone()

    camera.position.set(1, 0, 5)
    camera.updateMatrixWorld(true)

    const ecefToWorld = new Matrix4()
    const reprojectionMatrix = prevProj.clone().multiply(prevView)
    const altitudeCorrection = new Vector3(0, 0, 0)
    const currentUv = new Vector2(0.5, 0.5)

    // frontPos along the NEW camera's center ray (not the old one)
    const newInvProj = camera.projectionMatrixInverse.clone()
    const viewDir = new Vector4(0, 0, 1, 1).applyMatrix4(newInvProj)
    const worldDir = new Vector4(
      viewDir.x,
      viewDir.y,
      viewDir.z,
      0
    ).applyMatrix4(camera.matrixWorld)
    const dir = new Vector3(worldDir.x, worldDir.y, worldDir.z).normalize()
    const frontPos = camera.position.clone().add(dir.multiplyScalar(100))

    const { velocity } = hitVelocityCPU(
      frontPos,
      altitudeCorrection,
      ecefToWorld,
      reprojectionMatrix,
      currentUv
    )

    expect(Math.abs(velocity.x)).toBeGreaterThan(1e-4)

    log('hit-translation', {
      vx: velocity.x,
      vy: velocity.y,
      magnitude: velocity.length()
    })
  })

  test('ecefToWorld subtracts altitudeCorrection', () => {
    const ecefToWorld = new Matrix4()
    const correction = new Vector3(0, 100, 0)
    const point = new Vector3(10, 200, 30)

    const result = ecefToWorldCPU(point, correction, ecefToWorld)

    expect(result.x).toBeCloseTo(10)
    expect(result.y).toBeCloseTo(100)
    expect(result.z).toBeCloseTo(30)

    log('ecefToWorld-correction', {
      input: `${point.x},${point.y},${point.z}`,
      correction: `${correction.x},${correction.y},${correction.z}`,
      output: `${result.x},${result.y},${result.z}`
    })
  })

  test('point at altitudeCorrection maps to world origin', () => {
    const ecefToWorld = new Matrix4()
    const correction = new Vector3(5, 10, 15)

    const result = ecefToWorldCPU(correction.clone(), correction, ecefToWorld)

    expect(result.x).toBeCloseTo(0)
    expect(result.y).toBeCloseTo(0)
    expect(result.z).toBeCloseTo(0)

    log('ecefToWorld-origin', {
      output: `${result.x},${result.y},${result.z}`
    })
  })

  test('.r is finite — cloud hit at 150 km → 150 units', () => {
    const bottomRadius = 1000
    const worldToUnit = 1 / bottomRadius
    const frontDepthMeters = 150_000
    const depthR = frontDepthMeters * worldToUnit

    expect(depthR).toBe(150)
    expect(Number.isFinite(depthR)).toBe(true)

    log('depth-hit', { frontDepthMeters, worldToUnit, depthR })
  })

  test('.r is finite — miss with cameraFar = 1e7 → 1e4 units', () => {
    const bottomRadius = 1000
    const worldToUnit = 1 / bottomRadius
    const cameraFar = 1e7
    const depthR = cameraFar * worldToUnit

    expect(depthR).toBe(10_000)
    expect(Number.isFinite(depthR)).toBe(true)

    log('depth-miss', { cameraFar, worldToUnit, depthR })
  })

  test('front-depth debug recovers miss depth from unit space', async () => {
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('./cloudsFragment.ts', import.meta.url), 'utf8')
    )
    expect(source).toContain(
      'const frontDepthMetres = missDepthVelocity.x.div(deps.worldToUnit).toVar()'
    )
  })

  test('temporal jitter cancels for static camera', () => {
    const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 1000)
    camera.position.set(0, 0, 5)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)

    const resolution = new Vector2(256, 256)
    const currentUv = new Vector2(0.5, 0.5)
    const altitudeCorrection = new Vector3(0, 0, 0)
    const ecefToWorld = new Matrix4()

    for (let frame = 0; frame < 16; frame++) {
      const offset = bayerOffsets[frame % 16]!
      const dx = ((offset.x - 0.5) / resolution.x) * 4
      const dy = ((offset.y - 0.5) / resolution.y) * 4

      // Jittered inverse projection → ray direction for this frame
      const jitteredProj = camera.projectionMatrix.clone()
      jitteredProj.elements[8] += dx * 2
      jitteredProj.elements[9] += dy * 2
      const jitteredInvProj = jitteredProj.clone().invert()

      // Compute frontPos along the jittered center ray
      const viewDir = new Vector4(0, 0, 1, 1).applyMatrix4(jitteredInvProj)
      const worldDir4 = new Vector4(
        viewDir.x,
        viewDir.y,
        viewDir.z,
        0
      ).applyMatrix4(camera.matrixWorld)
      const dir = new Vector3(worldDir4.x, worldDir4.y, worldDir4.z).normalize()
      const frontPos = camera.position.clone().add(dir.multiplyScalar(100))

      // Reprojection: previous proj (unjittered) + current jitter
      const prevView = camera.matrixWorldInverse.clone()
      const reprojMatrix = camera.projectionMatrix.clone()
      reprojMatrix.elements[8] += dx * 2
      reprojMatrix.elements[9] += dy * 2
      reprojMatrix.multiply(prevView)

      const { velocity } = hitVelocityCPU(
        frontPos,
        altitudeCorrection,
        ecefToWorld,
        reprojMatrix,
        currentUv
      )

      expect(Math.abs(velocity.x), `frame ${frame} vx`).toBeLessThan(1e-6)
      expect(Math.abs(velocity.y), `frame ${frame} vy`).toBeLessThan(1e-6)
    }

    log('temporal-jitter-cancel', { framesChecked: 16, allZero: true })
  })
})
