// Depth-buffer precision arithmetic for the p4 log-depth e2e. Mirrors
// src/march/logDepthPrecision.test.ts's encoders and sceneDepth.ts's decoders
// (held together by test/depthPrecision.test.ts), so the e2e states before any
// GPU runs what each encoding must do to an occluder

/**
 * One depth-buffer step: a 24-bit unorm step (2^-24 to within 6e-15), and also
 * the float32 spacing on [0.5, 1), where a far-away surface's depth lives
 */
export const DEPTH_STEP = 1 / ((1 << 24) - 1)

export function quantizeDepth(d: number): number {
  return Math.round(Math.min(1, Math.max(0, d)) / DEPTH_STEP) * DEPTH_STEP
}

/** Standard perspective depth of a surface `distance` in front of the camera */
export function perspectiveDepthOf(
  distance: number,
  near: number,
  far: number
): number {
  const viewZ = -distance
  return ((near + viewZ) * far) / ((far - near) * viewZ)
}

/** Logarithmic depth as the WebGPU path writes it: log(z/near)/log(far/near) */
export function logDepthOf(
  distance: number,
  near: number,
  far: number
): number {
  return Math.log(distance / near) / Math.log(far / near)
}

/**
 * The distance a depth consumer recovers after the buffer quantises the
 * surface's depth. A depth that rounds to 1 is the cleared value: the surface
 * is indistinguishable from "no geometry", reported as Infinity.
 */
export function decodedDistance(
  encoding: 'linear' | 'log',
  distance: number,
  near: number,
  far: number
): number {
  const d = quantizeDepth(
    encoding === 'log'
      ? logDepthOf(distance, near, far)
      : perspectiveDepthOf(distance, near, far)
  )
  if (d >= 1) return Infinity
  if (encoding === 'log') return Math.exp(d * Math.log(far / near)) * near
  // -perspectiveDepthToViewZ: viewZ = near*far / ((far - near)*d - far)
  return (near * far) / (far - (far - near) * d)
}

export type DepthEncoding = 'linear' | 'log' | 'webglLog'

/**
 * The depth each renderer writes. 'log' is WebGPURenderer's
 * (ViewportDepthNode: log2(z/near)/log2(far/near)); 'webglLog' is
 * WebGLRenderer's (logdepthbuf: log2(1 + w) * logDepthBufFC * 0.5 with
 * logDepthBufFC = 2 / log2(far + 1)), which does not depend on near.
 */
export function depthOf(
  encoding: DepthEncoding,
  distance: number,
  near: number,
  far: number
): number {
  if (encoding === 'linear') return perspectiveDepthOf(distance, near, far)
  if (encoding === 'log') return logDepthOf(distance, near, far)
  return Math.log2(1 + distance) / Math.log2(1 + far)
}

/**
 * Which of two surfaces a LessEqual depth test keeps when the farther one is
 * drawn second: a tie after quantisation goes to the later (farther) surface
 */
export function depthTestWinner(
  encoding: DepthEncoding,
  nearDistance: number,
  farDistance: number,
  near: number,
  far: number
): 'near' | 'far' {
  const a = quantizeDepth(depthOf(encoding, nearDistance, near, far))
  const b = quantizeDepth(depthOf(encoding, farDistance, near, far))
  return b <= a ? 'far' : 'near'
}

/**
 * Reads the depth-test contest target: a size x size RGBA image whose centre
 * (|ndc| < 0.25) is covered by the red near quad and the green far quad, and
 * whose ring (|ndc| > 0.75 on either axis) by the far quad only. Symmetric, so
 * readback row order does not matter.
 */
export function classifyContest(
  rgba: ArrayLike<number>,
  size: number
): {
  centerNear: number
  ringFar: number
  centerPixels: number
  ringPixels: number
} {
  let centerPixels = 0
  let centerNear = 0
  let ringPixels = 0
  let ringFar = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = Math.abs(((x + 0.5) / size) * 2 - 1)
      const ny = Math.abs(((y + 0.5) / size) * 2 - 1)
      const o = (y * size + x) * 4
      const red = rgba[o]! > rgba[o + 1]!
      if (nx < 0.25 && ny < 0.25) {
        centerPixels++
        if (red) centerNear++
      } else if (nx > 0.75 || ny > 0.75) {
        ringPixels++
        if (!red && rgba[o + 1]! > 0) ringFar++
      }
    }
  }
  if (centerPixels === 0 || ringPixels === 0) {
    throw new Error('classifyContest: the target has no centre or ring pixels')
  }
  return {
    centerNear: centerNear / centerPixels,
    ringFar: ringFar / ringPixels,
    centerPixels,
    ringPixels
  }
}

/** Worst-case relative distance error of the log encoding: one step's worth */
export function logRelativeErrorBound(near: number, far: number): number {
  return DEPTH_STEP * Math.log(far / near)
}
