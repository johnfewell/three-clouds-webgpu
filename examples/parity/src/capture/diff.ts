// Diff image: |A − B| amplified ×8, mapped through turbo heat colormap
// Pure function: works in Node (vitest) and browser (capture script)

import { turboRgb } from './turbo'

export interface DiffResult {
  data: Uint8ClampedArray
  width: number
  height: number
  maxDelta: number
  /** Pixels where either side was NaN or Infinite, painted NON_FINITE_RGB */
  nonFiniteCount: number
}

// Deliberately NOT a turbo colour: mapping a NaN into the ramp (or clamping it
// to 0) would render "broken" as "perfect match". Magenta appears nowhere in
// turbo, so a NaN region is unmistakable in diff.png
const NON_FINITE_RGB: readonly [number, number, number] = [255, 0, 255]

export function computeDiffImage(
  bufA: ArrayLike<number>,
  bufB: ArrayLike<number>,
  width: number,
  height: number,
  channels = 4,
  amplify = 8
): DiffResult {
  const n = width * height
  const out = new Uint8ClampedArray(n * 4)
  let maxDelta = 0
  let nonFiniteCount = 0

  for (let i = 0; i < n; i++) {
    const rA = bufA[i * channels]!
    const gA = bufA[i * channels + 1]!
    const bA = bufA[i * channels + 2]!

    const rB = bufB[i * channels]!
    const gB = bufB[i * channels + 1]!
    const bB = bufB[i * channels + 2]!

    const dr = Math.abs(rA - rB)
    const dg = Math.abs(gA - gB)
    const db = Math.abs(bA - bB)

    const magnitude = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3)

    if (!Number.isFinite(magnitude)) {
      // Painted, counted, and excluded from maxDelta: a NaN must not silently
      // become the maximum, and must not silently become zero either
      nonFiniteCount++
      out[i * 4] = NON_FINITE_RGB[0]
      out[i * 4 + 1] = NON_FINITE_RGB[1]
      out[i * 4 + 2] = NON_FINITE_RGB[2]
      out[i * 4 + 3] = 255
      continue
    }

    if (magnitude > maxDelta) maxDelta = magnitude

    const heat = Math.min(magnitude * amplify, 1)
    const [r, g, b] = turboRgb(heat)

    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  }

  return { data: out, width, height, maxDelta, nonFiniteCount }
}
