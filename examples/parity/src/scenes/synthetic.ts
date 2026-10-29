// Synthetic parity scene: WGS84 ellipsoid ground, a lit sphere and an unlit
// plane at known ECEF positions, deterministic so a diff measures only the
// clouds renderer. The ground is an explicit EllipsoidGeometry mesh, because
// showGround differs between the WebGL and WebGPU atmospheres

import {
  Color,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'

import { SkyLightProbe, SunDirectionalLight } from '@takram/three-atmosphere'
import {
  Ellipsoid,
  EllipsoidGeometry,
  Geodetic
} from '@takram/three-geospatial'

export type LightingMode = 'post' | 'lights'

export interface SyntheticSceneOptions {
  nodeMaterials: boolean
  lighting?: LightingMode
}

export interface SyntheticSceneResult {
  scene: Scene
  ground: Mesh
  sphere: Mesh
  plane: Mesh
  anchorECEF: Vector3
  enuAtAnchor: Matrix4
  lighting: LightingMode
  needsAtmosphereLight: boolean
}

export const ANCHOR_LON = 139.7
export const ANCHOR_LAT = 35.7
export const SPHERE_RADIUS = 500
export const SPHERE_HEIGHT = 2000
export const PLANE_SIZE = 2000
export const SPHERE_ALBEDO = 0.5
export const PLANE_ALBEDO = 0.8

const DEG = Math.PI / 180

function makeBasicMaterial(color: Color, nodeMode: boolean): MeshBasicMaterial {
  if (nodeMode) {
    const m = new MeshBasicNodeMaterial()
    m.color.copy(color)
    return m as unknown as MeshBasicMaterial
  }
  return new MeshBasicMaterial({ color })
}

function makeStandardMaterial(
  color: Color,
  nodeMode: boolean
): MeshStandardMaterial {
  if (nodeMode) {
    const m = new MeshStandardNodeMaterial()
    m.color.copy(color)
    return m as unknown as MeshStandardMaterial
  }
  return new MeshStandardMaterial({ color })
}

export function createSyntheticScene(
  opts: SyntheticSceneOptions
): SyntheticSceneResult {
  const { nodeMaterials, lighting = 'post' } = opts
  const scene = new Scene()

  const anchorGeo = new Geodetic(ANCHOR_LON * DEG, ANCHOR_LAT * DEG, 0)
  const anchorECEF = anchorGeo.toECEF()
  const enuAtAnchor = Ellipsoid.WGS84.getEastNorthUpFrame(anchorECEF)

  // Ground: WGS84 ellipsoid mesh
  const groundGeom = new EllipsoidGeometry(Ellipsoid.WGS84.radii, 128, 64)
  const groundColor = new Color(0.3, 0.3, 0.3)
  const groundMat = makeBasicMaterial(groundColor, nodeMaterials)
  groundMat.name = 'ground'
  const ground = new Mesh(groundGeom, groundMat)
  ground.name = 'ground'
  scene.add(ground)

  // Sphere: 500m radius, 2km above deck at the anchor
  const sphereGeo = new Geodetic(
    ANCHOR_LON * DEG,
    ANCHOR_LAT * DEG,
    SPHERE_HEIGHT
  )
  const sphereECEF = sphereGeo.toECEF()
  const sphereGeom = new SphereGeometry(SPHERE_RADIUS, 32, 16)
  const sphereColor = new Color(SPHERE_ALBEDO, SPHERE_ALBEDO, SPHERE_ALBEDO)

  let sphereMat: MeshBasicMaterial | MeshStandardMaterial
  if (lighting === 'post') {
    sphereMat = makeBasicMaterial(sphereColor, nodeMaterials)
  } else {
    sphereMat = makeStandardMaterial(sphereColor, nodeMaterials)
  }
  sphereMat.name = 'sphere'

  const sphere = new Mesh(sphereGeom, sphereMat)
  sphere.name = 'sphere'
  sphere.position.copy(sphereECEF)
  scene.add(sphere)

  // Plane: 2km × 2km, on the ground at the anchor
  const planeGeom = new PlaneGeometry(PLANE_SIZE, PLANE_SIZE)
  const planeColor = new Color(PLANE_ALBEDO, PLANE_ALBEDO, PLANE_ALBEDO)
  const planeMat = makeBasicMaterial(planeColor, nodeMaterials)
  planeMat.name = 'plane'

  const plane = new Mesh(planeGeom, planeMat)
  plane.name = 'plane'
  plane.position.copy(anchorECEF)
  plane.quaternion.setFromRotationMatrix(enuAtAnchor)
  scene.add(plane)

  // Lighting (only in 'lights' mode). Side B's AtmosphereLight needs a live
  // TSL context, so the caller adds it when wiring up the WebGPU side
  let needsAtmosphereLight = false
  if (lighting === 'lights') {
    if (nodeMaterials) {
      needsAtmosphereLight = true
    } else {
      const sunLight = new SunDirectionalLight()
      sunLight.name = 'sunLight'
      // Both WebGL atmosphere lights sample their LUTs at an object position
      // Their defaults are the ECEF origin, where radius and zenith are
      // undefined, and the old offscreen receiver hid the resulting NaN light
      sunLight.target.position.copy(sphereECEF)
      scene.add(sunLight.target)
      scene.add(sunLight)

      const skyProbe = new SkyLightProbe()
      skyProbe.name = 'skyProbe'
      skyProbe.position.copy(sphereECEF)
      scene.add(skyProbe)
    }
  }

  return {
    scene,
    ground,
    sphere,
    plane,
    anchorECEF,
    enuAtAnchor,
    lighting,
    needsAtmosphereLight
  }
}

export function sunDirectionFromElevationAzimuth(
  elevation: number,
  azimuth: number,
  enuFrame: Matrix4
): Vector3 {
  const cosEl = Math.cos(elevation)
  const sinEl = Math.sin(elevation)
  const cosAz = Math.cos(azimuth)
  const sinAz = Math.sin(azimuth)
  // ENU local: east = +x, north = +y, up = +z;  azimuth 0 = north, clockwise
  const localDir = new Vector3(sinAz * cosEl, cosAz * cosEl, sinEl)
  return localDir.applyMatrix4(new Matrix4().extractRotation(enuFrame))
}
