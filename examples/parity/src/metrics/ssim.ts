// SSIM (Wang et al. 2004), Gaussian σ = 1.5 on Rec.709 luminance. C1/C2 need
// L = the data's DYNAMIC RANGE: L = 1.0 on linear plates swamped the variance
//. Measured L is side A's 0.5-99.5 percentile span (A sets the scale,
// percentiles resist hot pixels), sRGB encoding was rejected. v4 (ADR-011 A3,
// Gates on the ladder L = 0.09. Uncorrelated plates (true SSIM 0):
// ```
//   σ       L = 1.0   display-encoded, L = 1.0   L = span(A)
//   0.002    0.9915            0.9767              0.0192
//   0.005    0.9494            0.8703              0.0192
//   0.010    0.8251            0.6276              0.0192
//   0.020    0.5445            0.2946              0.0192
//   0.050    0.1704            0.0515              0.0171
// ```

import { gaussianBlur } from './blur'
import { luminance } from './color'

const SIGMA = 1.5
const K1 = 0.01
const K2 = 0.03

// The ladder's reference dynamic range: phase-1 plates cluster at a percentile
// span of 0.09 (surface-up 0.056, coverage-070/090 0.12, coverage-020 0.024
// the outlier). The gated SSIM is defined against this L for every case.
export const REFERENCE_L = 0.09

// Percentile bounds for the span, and a floor that only keeps C1/C2 non-zero
// on a degenerate plate (which the plate check fails independently)
const SPAN_LO = 0.005
const SPAN_HI = 0.995
const MIN_RANGE = 1e-3

function extractLuminance(
  buf: Float32Array,
  width: number,
  height: number,
  channels: number
): Float32Array {
  const lum = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    lum[i] = luminance(
      buf[i * channels]!,
      buf[i * channels + 1]!,
      buf[i * channels + 2]!
    )
  }
  return lum
}

// The dynamic range SSIM's stabilisers are defined against
export function dynamicRange(lum: Float32Array): number {
  if (lum.length === 0) return MIN_RANGE
  const sorted = Float32Array.from(lum).sort()
  const last = sorted.length - 1
  const lo = sorted[Math.floor(SPAN_LO * last)]!
  const hi = sorted[Math.floor(SPAN_HI * last)]!
  return Math.max(hi - lo, MIN_RANGE)
}

// The gated SSIM: L defaults to the ladder reference (v4). Pass an explicit L
// to evaluate the metric against another dynamic range
export function computeSSIM(
  bufA: Float32Array,
  bufB: Float32Array,
  width: number,
  height: number,
  channels = 4,
  L: number = REFERENCE_L
): number {
  const lumA = extractLuminance(bufA, width, height, channels)
  const lumB = extractLuminance(bufB, width, height, channels)

  const C1 = (K1 * L) ** 2
  const C2 = (K2 * L) ** 2

  const muA = gaussianBlur(lumA, width, height, SIGMA)
  const muB = gaussianBlur(lumB, width, height, SIGMA)

  const lumA2 = new Float32Array(width * height)
  const lumB2 = new Float32Array(width * height)
  const lumAB = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    lumA2[i] = lumA[i]! * lumA[i]!
    lumB2[i] = lumB[i]! * lumB[i]!
    lumAB[i] = lumA[i]! * lumB[i]!
  }

  const sigmaA2 = gaussianBlur(lumA2, width, height, SIGMA)
  const sigmaB2 = gaussianBlur(lumB2, width, height, SIGMA)
  const sigmaAB = gaussianBlur(lumAB, width, height, SIGMA)

  let ssimSum = 0
  for (let i = 0; i < width * height; i++) {
    const muA2 = muA[i]! * muA[i]!
    const muB2 = muB[i]! * muB[i]!
    const muAmuB = muA[i]! * muB[i]!

    const sA2 = sigmaA2[i]! - muA2
    const sB2 = sigmaB2[i]! - muB2
    const sAB = sigmaAB[i]! - muAmuB

    const num = (2 * muAmuB + C1) * (2 * sAB + C2)
    const den = (muA2 + muB2 + C1) * (sA2 + sB2 + C2)
    ssimSum += num / den
  }

  return ssimSum / (width * height)
}

// The v3 form: L is side A's own percentile span. Diagnostic only since v4, it
// tells you HOW MUCH of a low score a near-empty frame explains, and is never
// the number a case is gated on
export function computeSSIMAtMeasuredL(
  bufA: Float32Array,
  bufB: Float32Array,
  width: number,
  height: number,
  channels = 4
): number {
  const lumA = extractLuminance(bufA, width, height, channels)
  return computeSSIM(bufA, bufB, width, height, channels, dynamicRange(lumA))
}
