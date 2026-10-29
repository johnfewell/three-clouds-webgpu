// Cite: @takram/three-atmosphere build/shared.js:326-355 (getShadowRadius)
import { Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { Ellipsoid } from '@takram/three-geospatial'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { qualityPresets } from '../qualityPresets'
import { CascadedShadowMaps, getSunDistanceFudge } from './CascadedShadowMaps'
import {
  DEFAULT_SHADOW_RADIUS,
  MAX_FOOTPRINT_PX,
  shadowRadiusFromCascadeCPU,
  shadowRadiusFromFootprintCPU
} from './shadowRadius'

describe('getShadowRadius', () => {
  setCurrentSpec('shadowRadius')

  it('remaps a 10-50px shadow-texel footprint onto 0..shadowRadius', () => {
    const rows = [2, 10, 20, 30, 50, 120].map(px => ({
      footprintPx: px,
      radius: Number(shadowRadiusFromFootprintCPU(px).toFixed(4))
    }))
    log('shadowRadius-remap', rows)
    // Below the band: no filtering needed, the texel is sub-pixel on screen
    expect(shadowRadiusFromFootprintCPU(2)).toBe(0)
    expect(shadowRadiusFromFootprintCPU(10)).toBe(0)
    // Above the band: clamped at the full disk
    expect(shadowRadiusFromFootprintCPU(50)).toBe(DEFAULT_SHADOW_RADIUS)
    expect(shadowRadiusFromFootprintCPU(120)).toBe(DEFAULT_SHADOW_RADIUS)
    // Midpoint is half the radius
    expect(shadowRadiusFromFootprintCPU(30)).toBeCloseTo(
      DEFAULT_SHADOW_RADIUS / 2,
      6
    )
  })

  it('is monotonic in the footprint', () => {
    let prev = -1
    for (let px = 0; px <= 60; px += 5) {
      const r = shadowRadiusFromFootprintCPU(px)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })

  it('default shadowRadius is 3, matching the upstream uniform', () => {
    // shared.js:730 `new Uniform(3)`, the clouds reference never overrides it
    expect(DEFAULT_SHADOW_RADIUS).toBe(3)
  })

  it('scales with a caller-supplied radius', () => {
    expect(shadowRadiusFromFootprintCPU(50, 6)).toBe(6)
    expect(shadowRadiusFromFootprintCPU(30, 6)).toBeCloseTo(3, 6)
  })
})

// the footprint is one CASCADE TEXEL, so the shadow RANGE decides
// whether the site-2 PCF arms at all. A 5e4 cap shrank cascade 0 ~1700x and
// every radius lane then read 0. Table: the dispatch DIAGNOSIS for this task
describe('the ground PCF radius, from the cascade the port hands it', () => {
  setCurrentSpec('shadowRadius-cascade')

  const ER = 6378137
  const DEG = Math.PI / 180

  /** The parity harness's own camera, from parityCamera.ts CAMERA_* */
  const harnessCamera = (): PerspectiveCamera => {
    const camera = new PerspectiveCamera(50, 16 / 9, 100, 1e8)
    camera.position.set(0, ER + 60000, 0)
    camera.lookAt(0, ER - 20000, 0)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    return camera
  }

  /**
   * What CloudsContext.syncShadowMaps builds from the port's own preset. The
   * preset is the argument rather than a literal, so this follows the preset
   * and not a restatement of it.
   */
  const buildFromPreset = (
    preset: {
      cascadeCount: number
      mapSize: Vector2
      splitLambda: number
      maxFar: number | null
    },
    camera: PerspectiveCamera
  ): CascadedShadowMaps => {
    const maps = new CascadedShadowMaps({
      cascadeCount: preset.cascadeCount,
      mapSize: preset.mapSize,
      splitLambda: preset.splitLambda,
      maxFar: preset.maxFar
    })
    const sun = new Vector3(
      Math.cos(10 * DEG) * Math.sin(180 * DEG),
      Math.sin(10 * DEG),
      Math.cos(10 * DEG) * Math.cos(180 * DEG)
    )
    maps.update(
      camera,
      sun,
      getSunDistanceFudge(
        sun,
        Ellipsoid.WGS84.getSurfaceNormal(camera.position)
      )
    )
    return maps
  }

  const readRadius = (maps: CascadedShadowMaps, camera: PerspectiveCamera) => {
    const cascade = maps.cascades[0]!
    return shadowRadiusFromCascadeCPU(
      new Vector3(0, ER, 0),
      cascade.matrix,
      cascade.inverseMatrix,
      maps.mapSize,
      new Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      ),
      new Vector2(960, 540)
    )
  }

  it('the ladder preset arms the ground PCF, on the range the reference uses', () => {
    const camera = harnessCamera()
    const maps = buildFromPreset(qualityPresets.medium.shadow, camera)
    const reading = readRadius(maps, camera)

    log('ground-pcf-radius', [
      {
        field: 'shadowFar',
        expected: camera.far,
        actual: maps.far
      },
      {
        field: 'cascade0 texel (m)',
        expected: '> 1e4',
        actual: +reading.worldSizeMetres.toFixed(1)
      },
      {
        field: 'footprint (px)',
        expected: `> ${MAX_FOOTPRINT_PX}`,
        actual: +reading.sizePx.toFixed(2)
      },
      {
        field: 'pcf radius',
        expected: DEFAULT_SHADOW_RADIUS,
        actual: +reading.radius.toFixed(4)
      }
    ])

    // The reference's rule, stated as a fact about the range rather than as a
    // pinned constant: the cascades reach the camera's far plane
    expect(maps.far).toBeCloseTo(camera.far, -3)
    // Past the top of the 10..50 px band, so the remap saturates and the
    // sampler runs its Vogel disk instead of its point-sample early-out
    expect(reading.sizePx).toBeGreaterThan(MAX_FOOTPRINT_PX)
    expect(reading.radius).toBeCloseTo(DEFAULT_SHADOW_RADIUS, 6)
  })

  it('a capped range disarms it, which is the defect: 5e4 vs the reference', () => {
    // The positive control for the assertion above. Same code, same camera,
    // one field different: this is what a port-only cap does, and it is why a
    // radius receipt could read 0 with 100% of pixels classified
    const camera = harnessCamera()
    const reference = readRadius(
      buildFromPreset(
        { ...qualityPresets.medium.shadow, maxFar: null },
        camera
      ),
      camera
    )
    const capped = readRadius(
      buildFromPreset({ ...qualityPresets.medium.shadow, maxFar: 5e4 }, camera),
      camera
    )

    log('pcf-radius:cap-table', [
      {
        field: 'maxFar null (the reference)',
        expected: 'arms the PCF',
        actual:
          `texel ${reference.worldSizeMetres.toFixed(0)} m, ` +
          `${reference.sizePx.toFixed(2)} px, r ${reference.radius.toFixed(3)}`
      },
      {
        field: 'maxFar 5e4 (the defect)',
        expected: 'smaller than null',
        actual:
          `texel ${capped.worldSizeMetres.toFixed(0)} m, ` +
          `${capped.sizePx.toFixed(2)} px, r ${capped.radius.toFixed(3)}`
      }
    ])

    // A cap can only shrink the cascade, so the radius is monotone in maxFar
    // Asserting the DIRECTION is what gives the test teeth: it fails for any
    // cap small enough to push the footprint below the band
    expect(capped.worldSizeMetres).toBeLessThan(reference.worldSizeMetres)
    expect(capped.radius).toBe(0)
    expect(reference.radius).toBeGreaterThan(0)

    // The MAGNITUDE, not just the sign: a band assertion (`sizePx >
    // MAX_FOOTPRINT_PX`) stays green if the projection's scale is off by 2x
    expect(reference.worldSizeMetres / capped.worldSizeMetres).toBeGreaterThan(
      1000
    )
    expect(reference.sizePx / capped.sizePx).toBeGreaterThan(1000)
    // And the twins' absolute values, because the commit body's table quotes
    // them and a logged number is not a pinned one
    expect(reference.worldSizeMetres).toBeCloseTo(100860, -1)
    expect(capped.worldSizeMetres).toBeCloseTo(55, -1)
    expect(reference.sizePx).toBeCloseTo(973.33, 1)
    expect(capped.sizePx).toBeCloseTo(0.53, 1)
  })
})
