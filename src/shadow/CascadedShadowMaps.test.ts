import {
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem
} from 'three'
import { beforeEach, describe, expect, it } from 'vitest'

import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  CascadedShadowMaps,
  FrustumCorners,
  getSunDistanceFudge,
  splitFrustum
} from './CascadedShadowMaps'

class ReversedPerspectiveCamera extends PerspectiveCamera {
  override get reversedDepth(): boolean {
    return true
  }
}

describe('splitFrustum', () => {
  beforeEach(() => {
    setCurrentSpec('CascadedShadowMaps')
  })

  it('uniform mode produces evenly spaced splits', () => {
    const near = 0.1
    const far = 100
    const result = splitFrustum('uniform', 4, near, far)
    expect(result).toHaveLength(4)

    const rows = result.map((s, i) => ({
      cascade: i,
      split: s,
      expected: (near + ((far - near) * (i + 1)) / 4) / far,
      actual: s
    }))
    table('splitFrustum:uniform', rows)

    for (let i = 0; i < 4; i++) {
      const expected = (near + ((far - near) * (i + 1)) / 4) / far
      expectClose(result[i]!, expected, { label: `uniform[${i}]` })
    }
    expect(result[3]).toBeCloseTo(1, 10)
  })

  it('logarithmic mode produces geometrically spaced splits', () => {
    const near = 0.1
    const far = 100
    const result = splitFrustum('logarithmic', 4, near, far)
    expect(result).toHaveLength(4)

    const rows = result.map((s, i) => ({
      cascade: i,
      split: s,
      expected: (near * (far / near) ** ((i + 1) / 4)) / far,
      actual: s
    }))
    table('splitFrustum:logarithmic', rows)

    for (let i = 0; i < 4; i++) {
      const expected = (near * (far / near) ** ((i + 1) / 4)) / far
      expectClose(result[i]!, expected, { label: `logarithmic[${i}]` })
    }
    expect(result[3]).toBeCloseTo(1, 10)
  })

  it('practical mode interpolates between uniform and logarithmic', () => {
    const near = 0.1
    const far = 100
    const lambda = 0.5
    const result = splitFrustum('practical', 4, near, far, lambda)
    const uniform = splitFrustum('uniform', 4, near, far)
    const logarithmic = splitFrustum('logarithmic', 4, near, far)
    expect(result).toHaveLength(4)

    const rows = result.map((s, i) => ({
      cascade: i,
      split: s,
      uniform: uniform[i]!,
      logarithmic: logarithmic[i]!,
      expected: uniform[i]! * (1 - lambda) + logarithmic[i]! * lambda,
      actual: s
    }))
    table('splitFrustum:practical', rows)

    for (let i = 0; i < 4; i++) {
      const expected = uniform[i]! * (1 - lambda) + logarithmic[i]! * lambda
      expectClose(result[i]!, expected, {
        abs: 1e-10,
        label: `practical[${i}]`
      })
    }
  })

  it('splits are monotonically increasing', () => {
    for (const mode of ['uniform', 'logarithmic', 'practical'] as const) {
      const result = splitFrustum(mode, 4, 0.1, 100, 0.5)
      for (let i = 1; i < result.length; i++) {
        expect(result[i]).toBeGreaterThan(result[i - 1]!)
      }
    }
  })

  it('reuses result array', () => {
    const buf: number[] = []
    const out = splitFrustum('uniform', 3, 1, 100, undefined, buf)
    expect(out).toBe(buf)
    expect(buf).toHaveLength(3)
  })
})

describe('FrustumCorners', () => {
  beforeEach(() => {
    setCurrentSpec('CascadedShadowMaps')
  })

  it.each([
    ['WebGL', WebGLCoordinateSystem],
    ['WebGPU', WebGPUCoordinateSystem]
  ])(
    'reversed %s projection preserves physical near/far corners',
    (_, coordinateSystem) => {
      const ordinary = new PerspectiveCamera(60, 16 / 9, 1, 60_000)
      const reversed = new ReversedPerspectiveCamera(60, 16 / 9, 1, 60_000)
      for (const camera of [ordinary, reversed]) {
        camera.coordinateSystem = coordinateSystem
        camera.updateProjectionMatrix()
      }
      expect(reversed.reversedDepth).toBe(true)
      expect(
        new Vector3(0, 0, -reversed.near).applyMatrix4(
          reversed.projectionMatrix
        ).z
      ).toBeCloseTo(1, 12)
      expect(
        new Vector3(0, 0, -reversed.far).applyMatrix4(reversed.projectionMatrix)
          .z
      ).toBeCloseTo(0, 12)
      const expected = new FrustumCorners(ordinary, 40_000)
      const actual = new FrustumCorners(reversed, 40_000)
      for (const plane of ['near', 'far'] as const) {
        for (let corner = 0; corner < 4; corner++) {
          expectClose(actual[plane][corner]!, expected[plane][corner]!, {
            abs: 1e-6,
            label: `${coordinateSystem}:${plane}[${corner}]`
          })
        }
      }
      log('FrustumCorners:reversedDepth', {
        coordinateSystem,
        nearZ: actual.near[0].z,
        farZ: actual.far[0].z,
        expectedNearZ: -1,
        expectedFarZ: -40_000
      })
    }
  )

  it('split produces the correct number of sub-frusta', () => {
    const camera = new PerspectiveCamera(75, 1.5, 0.1, 1000)
    camera.updateProjectionMatrix()
    const frustum = new FrustumCorners()
    frustum.setFromCamera(camera, 500)

    const splits = splitFrustum('practical', 3, 0.1, 500, 0.5)
    const frusta = frustum.split(splits)
    expect(frusta).toHaveLength(3)

    log('FrustumCorners:split', {
      cascades: 3,
      splits: splits.map(s => s.toFixed(4)).join(', ')
    })
  })

  // the reference's near-plane NDC z = -1 is WebGL's. Under WebGPU it
  // unprojects to half the near distance and shifted each cascade. Asserted as
  // an invariant: a near corner lies on the near plane in either convention
  it.each([
    ['WebGL', WebGLCoordinateSystem],
    ['WebGPU', WebGPUCoordinateSystem]
  ])('near corners land on the near plane under %s clip space', (_, cs) => {
    const near = 100
    const camera = new PerspectiveCamera(50, 16 / 9, near, 1e8)
    camera.coordinateSystem = cs
    camera.updateProjectionMatrix()

    const frustum = new FrustumCorners()
    frustum.setFromCamera(camera, 5e4)

    for (let i = 0; i < 4; i++) {
      // View space looks down -z, so the near plane sits at z = -near
      expect(frustum.near[i]!.z).toBeCloseTo(-near, 6)
    }
    log('FrustumCorners:nearPlane', {
      coordinateSystem: cs === WebGPUCoordinateSystem ? 'WebGPU' : 'WebGL',
      expectedZ: -near,
      actualZ: +frustum.near[0].z.toFixed(6)
    })
  })

  it('first sub-frustum near matches camera near plane', () => {
    const camera = new PerspectiveCamera(75, 1.5, 0.1, 1000)
    camera.updateProjectionMatrix()
    const frustum = new FrustumCorners()
    frustum.setFromCamera(camera, 500)

    const splits = splitFrustum('practical', 3, 0.1, 500, 0.5)
    const frusta = frustum.split(splits)

    for (let i = 0; i < 4; i++) {
      expectClose(frusta[0]!.near[i]!, frustum.near[i]!, {
        abs: 1e-6,
        label: `near[${i}]`
      })
    }
  })

  it('last sub-frustum far matches camera far plane', () => {
    const camera = new PerspectiveCamera(75, 1.5, 0.1, 1000)
    camera.updateProjectionMatrix()
    const frustum = new FrustumCorners()
    frustum.setFromCamera(camera, 500)

    const splits = splitFrustum('practical', 3, 0.1, 500, 0.5)
    const frusta = frustum.split(splits)

    for (let i = 0; i < 4; i++) {
      expectClose(frusta[2]!.far[i]!, frustum.far[i]!, {
        abs: 1e-6,
        label: `far[${i}]`
      })
    }
  })

  it('clone produces an independent copy', () => {
    const camera = new PerspectiveCamera(75, 1.5, 0.1, 1000)
    camera.updateProjectionMatrix()
    const frustum = new FrustumCorners(camera, 500)
    const clone = frustum.clone()

    frustum.near[0].set(999, 999, 999)
    expect(clone.near[0].x).not.toBe(999)
  })
})

describe('CascadedShadowMaps', () => {
  beforeEach(() => {
    setCurrentSpec('CascadedShadowMaps')
  })

  it.each(['uniform', 'logarithmic', 'practical'] as const)(
    'reversed depth preserves %s cascade bounds, matrices and split depths',
    splitMode => {
      const ordinary = new PerspectiveCamera(60, 16 / 9, 1, 60_000)
      const reversed = new ReversedPerspectiveCamera(60, 16 / 9, 1, 60_000)
      for (const camera of [ordinary, reversed]) {
        camera.coordinateSystem = WebGPUCoordinateSystem
        camera.position.set(6_380_637, 300, -800)
        camera.lookAt(6_380_337, 2000, -600)
        camera.updateMatrixWorld(true)
        camera.updateProjectionMatrix()
      }
      for (const fade of [false, true]) {
        const options = {
          cascadeCount: 3,
          mapSize: new Vector2(256, 256),
          maxFar: 60_000,
          splitMode,
          splitLambda: 0.6,
          fade
        }
        const expected = new CascadedShadowMaps(options)
        const actual = new CascadedShadowMaps(options)
        const sun = new Vector3(0.02, 1, 0.1).normalize()
        expected.update(ordinary, sun)
        actual.update(reversed, sun)
        const rows = actual.cascades.map((cascade, index) => ({
          cascade: index,
          fade,
          start: cascade.interval.x * actual.far,
          end: cascade.interval.y * actual.far,
          texel: 2 / cascade.projectionMatrix.elements[0] / 256,
          expectedTexel:
            2 / expected.cascades[index]!.projectionMatrix.elements[0] / 256
        }))
        log(`CascadedShadowMaps:reversedDepth:${splitMode}`, rows)
        expect(actual.far).toBe(expected.far)
        for (let index = 0; index < actual.cascades.length; index++) {
          const cascade = actual.cascades[index]!
          const reference = expected.cascades[index]!
          expect(cascade.interval.toArray()).toEqual(
            reference.interval.toArray()
          )
          for (const key of [
            'matrix',
            'inverseMatrix',
            'projectionMatrix',
            'inverseProjectionMatrix',
            'viewMatrix',
            'inverseViewMatrix'
          ] as const) {
            expectClose(cascade[key], reference[key], {
              abs: 1e-6,
              rel: 1e-10,
              label: `${splitMode}:${fade}:${index}:${key}`
            })
          }
        }
      }
    }
  )

  it('creates the correct number of cascades', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 4,
      mapSize: new Vector2(2048, 2048)
    })
    expect(csm.cascadeCount).toBe(4)
    expect(csm.cascades).toHaveLength(4)
  })

  it('update produces valid cascade matrices', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 3,
      mapSize: new Vector2(1024, 1024)
    })
    const camera = new PerspectiveCamera(75, 1.5, 0.5, 500)
    camera.position.set(0, 10, 0)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    const sunDirection = new Vector3(0.5, 0.8, 0.3).normalize()
    csm.update(camera, sunDirection)

    expect(csm.far).toBeGreaterThan(0)
    expect(csm.far).toBeLessThanOrEqual(500)

    const rows: Array<{
      cascade: number
      intervalX: number
      intervalY: number
      matDet: number
    }> = []

    for (let i = 0; i < 3; i++) {
      const c = csm.cascades[i]!
      expect(c.interval.x).toBeLessThan(c.interval.y)
      const det = c.matrix.determinant()
      expect(det).not.toBe(0)
      rows.push({
        cascade: i,
        intervalX: c.interval.x,
        intervalY: c.interval.y,
        matDet: det
      })
    }

    log('CascadedShadowMaps:update', rows)
  })

  it('cascade intervals are contiguous and ordered', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 4,
      mapSize: new Vector2(2048, 2048)
    })
    const camera = new PerspectiveCamera(60, 1, 1, 1000)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    csm.update(camera, new Vector3(0, 1, 0))

    expect(csm.cascades[0]!.interval.x).toBe(0)
    for (let i = 1; i < 4; i++) {
      expectClose(
        csm.cascades[i]!.interval.x,
        csm.cascades[i - 1]!.interval.y,
        {
          abs: 1e-10,
          label: `interval contiguity[${i}]`
        }
      )
    }
  })

  it('maxFar clamps effective far', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 2,
      mapSize: new Vector2(512, 512),
      maxFar: 100
    })
    const camera = new PerspectiveCamera(60, 1, 1, 1000)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    csm.update(camera, new Vector3(0, 1, 0))
    expect(csm.far).toBe(100)
  })

  it('farScale scales effective far', () => {
    const csm = new CascadedShadowMaps({
      cascadeCount: 2,
      mapSize: new Vector2(512, 512),
      farScale: 0.5
    })
    const camera = new PerspectiveCamera(60, 1, 1, 1000)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    csm.update(camera, new Vector3(0, 1, 0))
    expect(csm.far).toBeCloseTo(500, 5)
  })

  it('defaults match cascadedShadowMapsDefaults', async () => {
    const { cascadedShadowMapsDefaults } = await import('./CascadedShadowMaps')
    expect(cascadedShadowMapsDefaults.splitMode).toBe('practical')
    expect(cascadedShadowMapsDefaults.splitLambda).toBe(0.5)
    expect(cascadedShadowMapsDefaults.maxFar).toBeNull()
    expect(cascadedShadowMapsDefaults.farScale).toBe(1)
    expect(cascadedShadowMapsDefaults.margin).toBe(0)
    expect(cascadedShadowMapsDefaults.fade).toBe(true)
  })
})

describe('getSunDistanceFudge', () => {
  beforeEach(() => {
    setCurrentSpec('CascadedShadowMaps')
  })

  it('returns 1e6 when sun is at zenith (dot=0)', () => {
    const sunDirection = new Vector3(1, 0, 0)
    const surfaceNormal = new Vector3(0, 1, 0)
    const result = getSunDistanceFudge(sunDirection, surfaceNormal)
    expectClose(result, 1e6, { abs: 1, label: 'zenith=0' })

    log('getSunDistanceFudge:zenith0', { zenithAngle: 0, distance: result })
  })

  it('returns 1e3 when sun is directly overhead (dot=1)', () => {
    const sunDirection = new Vector3(0, 1, 0)
    const surfaceNormal = new Vector3(0, 1, 0)
    const result = getSunDistanceFudge(sunDirection, surfaceNormal)
    expectClose(result, 1e3, { abs: 1, label: 'zenith=1' })

    log('getSunDistanceFudge:zenith1', { zenithAngle: 1, distance: result })
  })

  it('interpolates linearly between extremes', () => {
    const surfaceNormal = new Vector3(0, 1, 0)
    const angles = [0, 0.25, 0.5, 0.75, 1.0]

    const rows = angles.map(a => {
      const sun = new Vector3(Math.sqrt(1 - a * a), a, 0)
      const result = getSunDistanceFudge(sun, surfaceNormal)
      const expected = 1e6 + (1e3 - 1e6) * a
      return { zenithAngle: a, expected, actual: result }
    })
    table('getSunDistanceFudge:interpolation', rows)

    for (const row of rows) {
      expectClose(row.actual, row.expected, {
        abs: 1,
        label: `zenith=${row.zenithAngle}`
      })
    }
  })
})
