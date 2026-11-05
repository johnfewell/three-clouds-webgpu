// The path-traced reference image
//
// The camera and the sun come from the GPU run, so the reference looks at
// exactly the rays the GPU marched. The scene state is read out of the page
// rather than recomputed, so a mismatch between the two arms cannot hide
//
// Cite: src/march/cloudsFragment.ts (the ray construction this mirrors)

/** A three.js Matrix4 as elements, applied to a vector with the given w */
export function applyMatrix(elements, x, y, z, w) {
  return [
    elements[0] * x + elements[4] * y + elements[8] * z + elements[12] * w,
    elements[1] * x + elements[5] * y + elements[9] * z + elements[13] * w,
    elements[2] * x + elements[6] * y + elements[10] * z + elements[14] * w
  ]
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}

/**
 * The ray through a pixel, built the way the march builds it
 *
 * Cite: src/march/cloudsFragment.ts (clipXY, viewPosition, worldDirection,
 *   ecefDirection, cameraPosition)
 */
export function rayForPixel(state, px, py) {
  const u = (px + 0.5) / state.width
  const v = (py + 0.5) / state.height
  const clipX = u * 2 - 1
  const clipY = 1 - v * 2
  const view = applyMatrix(state.inverseProjectionMatrix, clipX, clipY, 1, 1)
  const world = applyMatrix(
    state.inverseViewMatrix,
    view[0],
    view[1],
    view[2],
    0
  )
  const ecef = applyMatrix(state.worldToECEF, world[0], world[1], world[2], 0)
  const origin = [
    state.cameraPositionECEF[0] + state.altitudeCorrection[0],
    state.cameraPositionECEF[1] + state.altitudeCorrection[1],
    state.cameraPositionECEF[2] + state.altitudeCorrection[2]
  ]
  return { origin, direction: normalize(ecef) }
}
