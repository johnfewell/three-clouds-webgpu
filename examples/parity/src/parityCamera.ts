// Camera construction shared by both sides (case 53 ortho-camera), so
// the frustums cannot differ. The reference builds the ray
// DIRECTION from a view-space position (clouds.vert:69-76, mirrored at
// cloudsFragment.ts:208-212), valid only for a PERSPECTIVE camera: an ortho
// camera is a 0.04 deg pinhole on BOTH sides, so case 53 is not valid parity
// ```
//     vec3 viewPosition   = (inverseProjectionMatrix * vec4(position, 1.0)).xyz;
//     vec3 worldDirection = (inverseViewMatrix * vec4(viewPosition, 0.0)).xyz;
// ```

import { OrthographicCamera, PerspectiveCamera } from 'three'

export type ParityCameraKind = 'perspective' | 'orthographic'
export type ParityCamera = PerspectiveCamera | OrthographicCamera

export const CAMERA_FOV_DEG = 50
export const CAMERA_ASPECT = 16 / 9
export const CAMERA_NEAR = 100
export const CAMERA_FAR = 1e8

/**
 * Distance from eye to look-at for POSE_ORBIT_60KM, the pose every orthographic
 * case uses: |[0, ER+60000, 0] - [0, ER-20000, 0]| = 80 km.
 *
 * An orthographic frustum needs a size, and an arbitrary one frames empty sky
 * or bare ground. Sizing it to what the perspective camera sees AT THE LOOK-AT
 * PLANE frames the same content, so the case tests the camera branch, not
 * framing.
 */
export const ORTHO_TARGET_DISTANCE_M = 80_000

export function orthoHalfHeight(
  distance = ORTHO_TARGET_DISTANCE_M,
  fovDeg = CAMERA_FOV_DEG
): number {
  return Math.tan(((fovDeg / 2) * Math.PI) / 180) * distance
}

export function createParityCamera(kind: ParityCameraKind): ParityCamera {
  if (kind === 'orthographic') {
    const halfH = orthoHalfHeight()
    const halfW = halfH * CAMERA_ASPECT
    return new OrthographicCamera(
      -halfW,
      halfW,
      halfH,
      -halfH,
      CAMERA_NEAR,
      CAMERA_FAR
    )
  }
  return new PerspectiveCamera(
    CAMERA_FOV_DEG,
    CAMERA_ASPECT,
    CAMERA_NEAR,
    CAMERA_FAR
  )
}

/**
 * Applies a canvas aspect to either camera type.
 *
 * A PerspectiveCamera carries `aspect`. An OrthographicCamera does not: its
 * frustum bounds ARE the aspect, so the horizontal extent is rescaled against
 * the fixed vertical one. Both sides call this, because framing the ortho case
 * differently would turn case 53 into a loud false FAILURE like a port bug.
 */
export function applyCameraAspect(camera: ParityCamera, aspect: number): void {
  if ((camera as PerspectiveCamera).isPerspectiveCamera === true) {
    ;(camera as PerspectiveCamera).aspect = aspect
  } else {
    const ortho = camera as OrthographicCamera
    const halfH = orthoHalfHeight()
    const halfW = halfH * aspect
    ortho.top = halfH
    ortho.bottom = -halfH
    ortho.right = halfW
    ortho.left = -halfW
  }
  camera.updateProjectionMatrix()
}
