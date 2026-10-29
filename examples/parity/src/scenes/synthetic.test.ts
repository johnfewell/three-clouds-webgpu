import {
  MeshBasicMaterial,
  MeshStandardMaterial,
  type PlaneGeometry,
  type SphereGeometry
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { SkyLightProbe, SunDirectionalLight } from '@takram/three-atmosphere'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

import { log } from '../../../../test/helpers/log'
import {
  ANCHOR_LAT,
  ANCHOR_LON,
  createSyntheticScene,
  PLANE_SIZE,
  SPHERE_HEIGHT,
  SPHERE_RADIUS,
  sunDirectionFromElevationAzimuth
} from './synthetic'

const DEG = Math.PI / 180

function closeTo(a: number, b: number, tol = 1): boolean {
  return Math.abs(a - b) < tol
}

describe('createSyntheticScene', () => {
  describe('ECEF positions', () => {
    it('anchor ECEF matches Geodetic.toECEF for (139.7°, 35.7°)', () => {
      const result = createSyntheticScene({ nodeMaterials: false })
      const expected = new Geodetic(
        ANCHOR_LON * DEG,
        ANCHOR_LAT * DEG,
        0
      ).toECEF()

      log('anchor-ecef', {
        x: result.anchorECEF.x,
        y: result.anchorECEF.y,
        z: result.anchorECEF.z,
        ex: expected.x,
        ey: expected.y,
        ez: expected.z
      })

      expect(result.anchorECEF.x).toBeCloseTo(expected.x, 0)
      expect(result.anchorECEF.y).toBeCloseTo(expected.y, 0)
      expect(result.anchorECEF.z).toBeCloseTo(expected.z, 0)

      const r = result.anchorECEF.length()
      expect(r).toBeGreaterThan(6.35e6)
      expect(r).toBeLessThan(6.39e6)
    })

    it('sphere is SPHERE_HEIGHT above the deck at the anchor', () => {
      const result = createSyntheticScene({ nodeMaterials: false })
      const groundGeo = new Geodetic(ANCHOR_LON * DEG, ANCHOR_LAT * DEG, 0)
      const groundECEF = groundGeo.toECEF()
      const sphereGeo = new Geodetic(
        ANCHOR_LON * DEG,
        ANCHOR_LAT * DEG,
        SPHERE_HEIGHT
      )
      const sphereECEF = sphereGeo.toECEF()

      const spherePos = result.sphere.position
      expect(spherePos.x).toBeCloseTo(sphereECEF.x, 0)
      expect(spherePos.y).toBeCloseTo(sphereECEF.y, 0)
      expect(spherePos.z).toBeCloseTo(sphereECEF.z, 0)

      const heightDiff = spherePos.length() - groundECEF.length()

      log('sphere-height', {
        sphereR: spherePos.length(),
        groundR: groundECEF.length(),
        delta: heightDiff,
        expected: SPHERE_HEIGHT
      })

      expect(closeTo(heightDiff, SPHERE_HEIGHT, 10)).toBe(true)
    })

    it('plane is on the ground at the anchor', () => {
      const result = createSyntheticScene({ nodeMaterials: false })
      const planePos = result.plane.position

      log('plane-pos', {
        px: planePos.x,
        py: planePos.y,
        pz: planePos.z,
        ax: result.anchorECEF.x,
        ay: result.anchorECEF.y,
        az: result.anchorECEF.z
      })

      expect(planePos.x).toBeCloseTo(result.anchorECEF.x, 0)
      expect(planePos.y).toBeCloseTo(result.anchorECEF.y, 0)
      expect(planePos.z).toBeCloseTo(result.anchorECEF.z, 0)
    })
  })

  describe('material classes — nodeMaterials=false', () => {
    it('post mode: sphere and plane are MeshBasicMaterial', () => {
      const r = createSyntheticScene({ nodeMaterials: false, lighting: 'post' })
      expect(r.sphere.material).toBeInstanceOf(MeshBasicMaterial)
      expect(r.plane.material).toBeInstanceOf(MeshBasicMaterial)
      expect(r.ground.material).toBeInstanceOf(MeshBasicMaterial)

      log('materials-false-post', {
        sphere: (r.sphere.material as MeshBasicMaterial).constructor.name,
        plane: (r.plane.material as MeshBasicMaterial).constructor.name,
        ground: (r.ground.material as MeshBasicMaterial).constructor.name
      })
    })

    it('lights mode: sphere is MeshStandardMaterial, plane is MeshBasicMaterial', () => {
      const r = createSyntheticScene({
        nodeMaterials: false,
        lighting: 'lights'
      })
      expect(r.sphere.material).toBeInstanceOf(MeshStandardMaterial)
      expect(r.plane.material).toBeInstanceOf(MeshBasicMaterial)
      expect(r.ground.material).toBeInstanceOf(MeshBasicMaterial)

      log('materials-false-lights', {
        sphere: (r.sphere.material as MeshStandardMaterial).constructor.name,
        plane: (r.plane.material as MeshBasicMaterial).constructor.name
      })
    })
  })

  describe('material classes — nodeMaterials=true', () => {
    it('post mode: sphere and plane are MeshBasicNodeMaterial', () => {
      const r = createSyntheticScene({ nodeMaterials: true, lighting: 'post' })
      expect(r.sphere.material).toBeInstanceOf(MeshBasicNodeMaterial)
      expect(r.plane.material).toBeInstanceOf(MeshBasicNodeMaterial)
      expect(r.ground.material).toBeInstanceOf(MeshBasicNodeMaterial)

      log('materials-true-post', {
        sphere: (r.sphere.material as MeshBasicMaterial).constructor.name,
        plane: (r.plane.material as MeshBasicMaterial).constructor.name,
        ground: (r.ground.material as MeshBasicMaterial).constructor.name
      })
    })

    it('lights mode: sphere is MeshStandardNodeMaterial, plane is MeshBasicNodeMaterial', () => {
      const r = createSyntheticScene({
        nodeMaterials: true,
        lighting: 'lights'
      })
      expect(r.sphere.material).toBeInstanceOf(MeshStandardNodeMaterial)
      expect(r.plane.material).toBeInstanceOf(MeshBasicNodeMaterial)
      expect(r.ground.material).toBeInstanceOf(MeshBasicNodeMaterial)

      log('materials-true-lights', {
        sphere: (r.sphere.material as MeshStandardMaterial).constructor.name,
        plane: (r.plane.material as MeshBasicMaterial).constructor.name
      })
    })
  })

  describe('lighting objects', () => {
    it('nodeMaterials=false, lights: scene has SunDirectionalLight + SkyLightProbe', () => {
      const r = createSyntheticScene({
        nodeMaterials: false,
        lighting: 'lights'
      })
      const sun = r.scene.getObjectByName('sunLight')
      const sky = r.scene.getObjectByName('skyProbe')

      expect(sun).toBeDefined()
      expect(sky).toBeDefined()
      expect(sun).toBeInstanceOf(SunDirectionalLight)
      expect(sky).toBeInstanceOf(SkyLightProbe)
      expect(r.needsAtmosphereLight).toBe(false)

      log('lights-webgl', {
        sunName: sun?.name,
        skyName: sky?.name,
        needsAtmLight: r.needsAtmosphereLight
      })
    })

    it('nodeMaterials=true, lights: needsAtmosphereLight is true', () => {
      const r = createSyntheticScene({
        nodeMaterials: true,
        lighting: 'lights'
      })
      expect(r.needsAtmosphereLight).toBe(true)

      const sun = r.scene.getObjectByName('sunLight')
      const sky = r.scene.getObjectByName('skyProbe')
      expect(sun).toBeUndefined()
      expect(sky).toBeUndefined()

      log('lights-webgpu', { needsAtmLight: r.needsAtmosphereLight })
    })

    it('post mode: no lights added', () => {
      const r = createSyntheticScene({ nodeMaterials: false, lighting: 'post' })
      expect(r.scene.getObjectByName('sunLight')).toBeUndefined()
      expect(r.scene.getObjectByName('skyProbe')).toBeUndefined()
      expect(r.needsAtmosphereLight).toBe(false)
    })
  })

  describe('ENU frame and sun direction', () => {
    it('ENU frame at anchor is a valid rotation matrix', () => {
      const r = createSyntheticScene({ nodeMaterials: false })
      const det = r.enuAtAnchor.determinant()

      log('enu-frame', { determinant: det })

      expect(det).toBeCloseTo(1, 4)
    })

    it('elevation 90° (zenith) sun direction aligns with surface normal', () => {
      const r = createSyntheticScene({ nodeMaterials: false })
      const sunDir = sunDirectionFromElevationAzimuth(
        Math.PI / 2,
        0,
        r.enuAtAnchor
      )
      const surfaceNormal = Ellipsoid.WGS84.getSurfaceNormal(r.anchorECEF)

      const dot = sunDir.dot(surfaceNormal)

      log('sun-zenith', {
        dotWithNormal: dot,
        sunX: sunDir.x,
        sunY: sunDir.y,
        sunZ: sunDir.z,
        normalX: surfaceNormal.x,
        normalY: surfaceNormal.y,
        normalZ: surfaceNormal.z
      })

      expect(dot).toBeCloseTo(1, 4)
    })

    it('elevation 0° (horizon) sun direction is perpendicular to surface normal', () => {
      const r = createSyntheticScene({ nodeMaterials: false })
      const sunDir = sunDirectionFromElevationAzimuth(0, 0, r.enuAtAnchor)
      const surfaceNormal = Ellipsoid.WGS84.getSurfaceNormal(r.anchorECEF)

      const dot = sunDir.dot(surfaceNormal)

      log('sun-horizon', {
        dotWithNormal: dot,
        sunX: sunDir.x,
        sunY: sunDir.y,
        sunZ: sunDir.z
      })

      expect(Math.abs(dot)).toBeLessThan(0.01)
    })
  })

  describe('geometry dimensions', () => {
    it('sphere geometry has correct radius', () => {
      const r = createSyntheticScene({ nodeMaterials: false })
      const params = (r.sphere.geometry as SphereGeometry).parameters
      expect(params.radius).toBe(SPHERE_RADIUS)
    })

    it('plane geometry has correct dimensions', () => {
      const r = createSyntheticScene({ nodeMaterials: false })
      const params = (r.plane.geometry as PlaneGeometry).parameters
      expect(params.width).toBe(PLANE_SIZE)
      expect(params.height).toBe(PLANE_SIZE)
    })
  })
})
