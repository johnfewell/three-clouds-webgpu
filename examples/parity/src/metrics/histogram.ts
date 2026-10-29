// Luminance-distribution distance: Wasserstein-1 between the two luminance
// distributions over side A's mean (W1 = mean |sortedA - sortedB|). It replaced
// a 256-bin L1 that saturated once supports stopped overlapping, reading
// exposure rather than shape. An exposure error ×k scores |k - 1|, so the
// 0.1 floor means a 10 % exposure-equivalent mismatch (ugt)

import { luminance } from './color'

// A plate dimmer than this already fails the plate check (minStd 0.002); the
// guard exists only to keep the ratio finite
const MIN_MEAN = 1e-4

function sortedLuminance(
  buf: Float32Array,
  width: number,
  height: number,
  channels: number
): Float32Array {
  const n = width * height
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] = luminance(
      buf[i * channels]!,
      buf[i * channels + 1]!,
      buf[i * channels + 2]!
    )
  }
  // TypedArray.prototype.sort is numeric ascending by default
  lum.sort()
  return lum
}

export function computeHistogramDistance(
  bufA: Float32Array,
  bufB: Float32Array,
  width: number,
  height: number,
  channels = 4
): number {
  const n = width * height
  if (n === 0) return 0

  const a = sortedLuminance(bufA, width, height, channels)
  const b = sortedLuminance(bufB, width, height, channels)

  let transport = 0
  let sumA = 0
  for (let i = 0; i < n; i++) {
    transport += Math.abs(a[i]! - b[i]!)
    sumA += a[i]!
  }

  return transport / n / Math.max(sumA / n, MIN_MEAN)
}
