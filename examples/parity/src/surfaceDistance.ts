// Camera→ground distance per pixel for a case pose, cast against the SAME mesh
// the synthetic scene draws (EllipsoidGeometry(WGS84, 128, 64)): near the pole
// its facets sit kilometres inside the analytic ellipsoid. Row 0 is
// the TOP, pixel centres, the harness camera (fov 50, 16:9)
import {
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
  type PerspectiveCamera
} from 'three'

import { Ellipsoid, EllipsoidGeometry } from '@takram/three-geospatial'

import type { CasePose } from '../cases/index'
import { createParityCamera } from './parityCamera'

export interface SurfaceDistanceSample {
  col: number
  row: number
  // Metres along the ray to the ground mesh; null when the ray misses (sky)
  distance: number | null
}

export function groundDistances(
  pose: CasePose,
  width: number,
  height: number,
  step: number
): SurfaceDistanceSample[] {
  const camera = createParityCamera('perspective') as PerspectiveCamera
  camera.position.fromArray(pose.position)
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2])
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  const ground = new Mesh(
    new EllipsoidGeometry(Ellipsoid.WGS84.radii, 128, 64),
    new MeshBasicMaterial()
  )
  ground.updateMatrixWorld()
  const raycaster = new Raycaster()
  const ndc = new Vector2()
  const samples: SurfaceDistanceSample[] = []
  for (let row = Math.floor(step / 2); row < height; row += step) {
    for (let col = Math.floor(step / 2); col < width; col += step) {
      ndc.set(((col + 0.5) / width) * 2 - 1, 1 - ((row + 0.5) / height) * 2)
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObject(ground, false)[0]
      samples.push({ col, row, distance: hit?.distance ?? null })
    }
  }
  ground.geometry.dispose()
  ground.material.dispose()
  return samples
}
