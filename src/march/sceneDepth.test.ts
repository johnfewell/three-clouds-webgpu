// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { beforeEach, describe, expect, it } from 'vitest'

import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  getRayDistanceToSceneCPU,
  logarithmicToPerspectiveDepthCPU,
  perspectiveDepthToViewZCPU
} from './sceneDepth'

// CPU twin tests

describe('sceneDepth — CPU twin', () => {
  beforeEach(() => setCurrentSpec('sceneDepth'))

  it.each([1, 10, 8000, 17_000, 59_000])(
    'decodes physical view depth %s identically from both projection conventions',
    async distance => {
      const { Matrix4, Vector3, WebGPUCoordinateSystem } = await import('three')
      for (const reversed of [false, true]) {
        const projection = new Matrix4().makePerspective(
          -1,
          1,
          1,
          -1,
          1,
          60_000,
          WebGPUCoordinateSystem,
          reversed
        )
        const depth = new Vector3(0, 0, -distance).applyMatrix4(projection).z
        const actual = getRayDistanceToSceneCPU(
          depth,
          1,
          60_000,
          true,
          reversed,
          1
        )
        expectClose(actual.viewZ, -distance, {
          abs: 1e-5,
          rel: 1e-10,
          label: `view-depth:${reversed}:${distance}`
        })
        expectClose(actual.rayDistance, distance, {
          abs: 1e-5,
          rel: 1e-10,
          label: `ray-distance:${reversed}:${distance}`
        })
      }
    }
  )

  it('perspective: depth=0.5, near=1, far=1e6, straight-ahead ray', () => {
    const near = 1
    const far = 1e6
    const depth = 0.5
    // Straight ahead: rayDir·camDir = 1
    const dot = 1

    const result = getRayDistanceToSceneCPU(depth, near, far, true, false, dot)

    const expectedViewZ = perspectiveDepthToViewZCPU(depth, near, far)
    const expectedRayDist = -expectedViewZ

    expectClose(result.viewZ, expectedViewZ, { label: 'viewZ-perspective' })
    expectClose(result.rayDistance, expectedRayDist, {
      label: 'rayDist-perspective'
    })
    expect(result.rayDistance).toBeGreaterThan(0)

    log('sceneDepth-perspective', {
      depth,
      near,
      far,
      viewZ: result.viewZ,
      rayDistance: result.rayDistance
    })
  })

  it('perspective: off-axis ray increases ray distance', () => {
    const near = 1
    const far = 1e6
    const depth = 0.5
    const cos45 = Math.SQRT1_2

    const straight = getRayDistanceToSceneCPU(depth, near, far, true, false, 1)
    const angled = getRayDistanceToSceneCPU(
      depth,
      near,
      far,
      true,
      false,
      cos45
    )

    expect(angled.rayDistance).toBeGreaterThan(straight.rayDistance)
    expectClose(angled.rayDistance, straight.rayDistance / cos45, {
      label: 'rayDist-off-axis',
      rel: 1e-10
    })

    log('sceneDepth-off-axis', {
      straightDist: straight.rayDistance,
      angledDist: angled.rayDistance,
      ratio: angled.rayDistance / straight.rayDistance,
      expectedRatio: 1 / cos45
    })
  })

  it('no geometry: depth >= 1-1e-7 → rayDistance=0, viewZ=0', () => {
    const atOne = getRayDistanceToSceneCPU(1.0, 1, 1e6, true, false, 1)
    expect(atOne.rayDistance).toBe(0)
    expect(atOne.viewZ).toBe(0)

    const nearOne = getRayDistanceToSceneCPU(1.0 - 1e-8, 1, 1e6, true, false, 1)
    expect(nearOne.rayDistance).toBe(0)
    expect(nearOne.viewZ).toBe(0)
  })

  it('reversed depth buffer: depth <= 0 → no geometry', () => {
    const atZero = getRayDistanceToSceneCPU(0, 1, 1e6, true, true, 1)
    expect(atZero.rayDistance).toBe(0)
    expect(atZero.viewZ).toBe(0)

    const hasGeo = getRayDistanceToSceneCPU(0.5, 1, 1e6, true, true, 1)
    expect(hasGeo.rayDistance).toBeGreaterThan(0)
  })

  it('depth at near plane → rayDistance ≈ near', () => {
    const near = 1
    const far = 1e6

    const result = getRayDistanceToSceneCPU(0, near, far, true, false, 1)

    expectClose(result.rayDistance, near, {
      label: 'rayDist-near-plane',
      rel: 1e-6
    })
    expectClose(result.viewZ, -near, {
      label: 'viewZ-near-plane',
      rel: 1e-6
    })
  })

  it('depth sweep: monotonic rayDistance for increasing depth', () => {
    const near = 1
    const far = 1000
    const depths = [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]

    const rows = depths.map(d => {
      const r = getRayDistanceToSceneCPU(d, near, far, true, false, 1)
      return { depth: d, rayDistance: r.rayDistance, viewZ: r.viewZ }
    })

    table('sceneDepth-depth-sweep', rows)

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.rayDistance).toBeGreaterThan(rows[i - 1]!.rayDistance)
    }
  })

  it('orthographic: viewZ linear in depth', () => {
    const near = 1
    const far = 100

    const r1 = getRayDistanceToSceneCPU(0.25, near, far, false, false, 1)
    const r2 = getRayDistanceToSceneCPU(0.5, near, far, false, false, 1)
    const r3 = getRayDistanceToSceneCPU(0.75, near, far, false, false, 1)

    const step = r2.viewZ - r1.viewZ
    expectClose(r3.viewZ - r2.viewZ, step, {
      label: 'ortho-linear-viewZ',
      abs: 1e-10
    })
  })
})

describe('logarithmicToPerspectiveDepthCPU', () => {
  beforeEach(() => setCurrentSpec('sceneDepth_logDepth'))

  it('depth=0 round-trips to perspective depth=0 (near plane)', () => {
    const near = 0.1
    const far = 1000
    const result = logarithmicToPerspectiveDepthCPU(0, near, far)
    expectClose(result, 0, { label: 'logDepth-0-near', abs: 1e-10 })
  })

  it('depth=1 round-trips to perspective depth=1 (far plane)', () => {
    const near = 0.1
    const far = 1000
    const result = logarithmicToPerspectiveDepthCPU(1, near, far)
    expectClose(result, 1, { label: 'logDepth-1-far', abs: 1e-10 })
  })

  it('viewZ round-trips through log→perspective→viewZ for mid-range', () => {
    const near = 1
    const far = 1e6
    for (const logDepth of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const perspDepth = logarithmicToPerspectiveDepthCPU(logDepth, near, far)
      const viewZ = perspectiveDepthToViewZCPU(perspDepth, near, far)
      const expectedViewZ = -Math.exp(logDepth * Math.log(far / near)) * near
      expectClose(viewZ, expectedViewZ, {
        label: `logDepth-roundtrip-${logDepth}`,
        rel: 1e-8
      })
    }
  })

  it('output is monotonically increasing with input', () => {
    const near = 0.1
    const far = 1000
    let prev = -Infinity
    for (let d = 0; d <= 1; d += 0.1) {
      const result = logarithmicToPerspectiveDepthCPU(d, near, far)
      expect(result).toBeGreaterThanOrEqual(prev)
      prev = result
    }
  })
})

// WGSL compilation

describe('sceneDepth — WGSL compilation', () => {
  it.each([false, true])(
    'preserves an explicit clear-depth override (reversed=%s)',
    async reversedDepthBuffer => {
      const { compileWGSL } = await import('../../test/helpers/compileWGSL')
      const { vec3, texture } = await import('three/tsl')
      const { PerspectiveCamera, DataTexture } = await import('three')
      const getDepth = (
        await import('./sceneDepth')
      ).createGetRayDistanceToScene({
        camera: new PerspectiveCamera(50, 1, 1, 60_000),
        sceneDepthTexture: texture(new DataTexture()),
        reversedDepthBuffer
      })
      const result = getDepth(vec3(0, 0, -1), vec3(0, 0, -1))
      const { fragment } = compileWGSL(result.get('rayDistance'), {
        reversedDepthBuffer: !reversedDepthBuffer
      })
      expect(fragment).toMatch(
        reversedDepthBuffer ? /\.x > 0\.0/ : /\.x < 0\.9999999/
      )
    }
  )

  it.each([false, true])(
    'inherits the renderer clear-depth convention (reversed=%s)',
    async reversedDepthBuffer => {
      const { compileWGSL } = await import('../../test/helpers/compileWGSL')
      const { vec3, texture } = await import('three/tsl')
      const { PerspectiveCamera, DataTexture } = await import('three')
      const getDepth = (
        await import('./sceneDepth')
      ).createGetRayDistanceToScene({
        camera: new PerspectiveCamera(50, 1, 1, 60_000),
        sceneDepthTexture: texture(new DataTexture())
      })
      const result = getDepth(vec3(0, 0, -1), vec3(0, 0, -1))
      const { fragment } = compileWGSL(result.get('rayDistance'), {
        reversedDepthBuffer
      })
      expect(fragment).toMatch(
        reversedDepthBuffer ? /\.x > 0\.0/ : /\.x < 0\.9999999/
      )
      log('sceneDepth:rendererConvention', {
        reversedDepthBuffer,
        expectsClearDepth: reversedDepthBuffer ? 0 : 1
      })
    }
  )

  it('decodes logarithmic scene depth exactly once', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { vec3, texture } = await import('three/tsl')
    const { PerspectiveCamera, DataTexture } = await import('three')
    const { createGetRayDistanceToScene } = await import('./sceneDepth')
    const camera = new PerspectiveCamera(50, 1, 1, 200000)
    const getDepth = createGetRayDistanceToScene({
      camera,
      sceneDepthTexture: texture(new DataTexture()),
      logarithmicDepthBuffer: true
    })
    const result = getDepth(vec3(0, 0, -1), vec3(0, 0, -1))
    const { fragment } = compileWGSL(result.get('rayDistance'), {
      logarithmicDepthBuffer: true
    })
    // Both struct members inline viewZ, and each must decode only once
    expect(fragment.match(/pow\(/g)).toHaveLength(2)
  })

  it('samples terrain at the top-down UV targeted by the jittered cloud ray', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn, vec3, texture, uniform } = await import('three/tsl')
    const { PerspectiveCamera, DataTexture, Vector2, Vector3, Matrix4 } =
      await import('three')
    const { CameraUniforms } = await import('../CameraUniforms')
    const { createGetRayDistanceToScene } = await import('./sceneDepth')

    const camera = new PerspectiveCamera(60, 1.5, 1, 200000)
    camera.updateMatrixWorld(true)
    const cameraUniforms = new CameraUniforms()
    const jitter = new Vector2()
    const resolution = new Vector2(1200, 800)
    const errors = []
    for (let frame = 0; frame < 16; frame++) {
      cameraUniforms.update(camera, new Matrix4(), {
        frame,
        resolution,
        jitterOut: jitter
      })
      // Trace the actual jittered ray back through the unjittered camera,
      // then convert NDC to the depth attachment's top-down UV convention
      const clip = new Vector3(0, 0, 1)
        .applyMatrix4(cameraUniforms.inverseProjectionMatrix.value)
        .applyMatrix4(camera.projectionMatrix)
      const rayUv = new Vector2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5)
      errors.push(rayUv.distanceTo(new Vector2(0.5 + jitter.x, 0.5 - jitter.y)))
    }
    expect(Math.max(...errors)).toBeLessThan(1e-12)

    const getRayDistance = createGetRayDistanceToScene({
      camera,
      sceneDepthTexture: texture(new DataTexture()),
      temporalJitter: uniform(jitter).setName('bayerJitter')
    })
    const node = Fn(() =>
      getRayDistance(vec3(0, 0, -1), vec3(0, 0, -1)).get('rayDistance')
    )()
    const { fragment } = compileWGSL(node)
    expect(fragment).toMatch(
      /vec2<f32>\( \w+\.bayerJitter\.x, \( - \w+\.bayerJitter\.y \) \)/
    )
    log('depth sample agrees with jittered ray', {
      phases: errors.length,
      maxUvError: Math.max(...errors)
    })
  })

  it('compiles createGetRayDistanceToScene to WGSL', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn: tslFn, vec3: tslVec3 } = await import('three/tsl')
    const { PerspectiveCamera, DataTexture, FloatType } = await import('three')
    const { texture } = await import('three/tsl')

    const { createGetRayDistanceToScene } = await import('./sceneDepth')

    const camera = new PerspectiveCamera(75, 1, 0.1, 1000)
    const depthData = new Float32Array([0.5, 0.5, 0.5, 1.0])
    const depthTex = new DataTexture(depthData, 1, 1, undefined, FloatType)
    const depthTextureNode = texture(depthTex)

    const getRayDist = createGetRayDistanceToScene({
      sceneDepthTexture: depthTextureNode,
      camera
    })

    const node = tslFn(() => {
      const result = getRayDist(tslVec3(0, 0, -1), tslVec3(0, 0, -1))
      return result.get('rayDistance')
    })()

    const { fragment } = compileWGSL(node)
    expect(fragment.length).toBeGreaterThan(0)
    expect(fragment).toContain('vec4')
  })
})
