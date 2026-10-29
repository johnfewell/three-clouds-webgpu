// Pixel-region helpers for the Phase 4 e2e clauses. An
// effect is asserted in its REGION, since a whole-plate statistic dilutes it
// Every helper refuses an empty region: a mean over zero pixels is NaN or 0,
// either of which passes or fails for a reason unrelated to the feature

import { luminance } from './color'

function requirePixels(pixels: readonly number[], what: string): void {
  if (pixels.length === 0) {
    throw new Error(
      `${what}: the region is empty, so there is nothing to measure`
    )
  }
}

/** Pixels (RGBA index / 4) whose max RGB channel differs by more than epsilon */
export function changedPixels(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  epsilon: number
): number[] {
  if (a.length !== b.length) {
    throw new Error(
      `changedPixels: lengths differ (${a.length} vs ${b.length})`
    )
  }
  const out: number[] = []
  for (let p = 0; p < a.length / 4; p++) {
    const o = p * 4
    const d = Math.max(
      Math.abs(a[o]! - b[o]!),
      Math.abs(a[o + 1]! - b[o + 1]!),
      Math.abs(a[o + 2]! - b[o + 2]!)
    )
    if (d > epsilon) out.push(p)
  }
  return out
}

/** Indices of the largest `fraction` of values (at least one), largest first */
export function topFraction(
  values: ArrayLike<number>,
  fraction: number
): number[] {
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(`topFraction: fraction must be in (0, 1], got ${fraction}`)
  }
  if (values.length === 0) throw new Error('topFraction: no values')
  const count = Math.max(1, Math.floor(values.length * fraction))
  return Array.from({ length: values.length }, (_, i) => i)
    .sort((i, j) => values[j]! - values[i]!)
    .slice(0, count)
}

function pixelLuminance(data: ArrayLike<number>, pixel: number): number {
  const o = pixel * 4
  return luminance(data[o]!, data[o + 1]!, data[o + 2]!)
}

export function meanLuminanceOver(
  data: ArrayLike<number>,
  pixels: readonly number[]
): number {
  requirePixels(pixels, 'meanLuminanceOver')
  let sum = 0
  for (const p of pixels) sum += pixelLuminance(data, p)
  return sum / pixels.length
}

export function meanAbsLuminanceDeltaOver(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  pixels: readonly number[]
): number {
  requirePixels(pixels, 'meanAbsLuminanceDeltaOver')
  let sum = 0
  for (const p of pixels) {
    sum += Math.abs(pixelLuminance(a, p) - pixelLuminance(b, p))
  }
  return sum / pixels.length
}

/** Mean and variance of 8-bit screenshot channel values */
export function byteStats(values: readonly number[]): {
  mean: number
  variance: number
} {
  requirePixels(values, 'byteStats')
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return { mean, variance }
}

/** Pixels whose centres lie inside |ndcX| < halfX and |ndcY| < halfY */
export function ndcBoxPixels(
  width: number,
  height: number,
  halfX: number,
  halfY: number
): number[] {
  const out: number[] = []
  for (let y = 0; y < height; y++) {
    const ny = Math.abs(((y + 0.5) / height) * 2 - 1)
    if (ny >= halfY) continue
    for (let x = 0; x < width; x++) {
      if (Math.abs(((x + 0.5) / width) * 2 - 1) < halfX) out.push(y * width + x)
    }
  }
  return out
}

type Vec3 = readonly [number, number, number]

/**
 * Lowest and highest altitude above a sphere of `radius` (centred at the
 * origin) that a ray reaches over [0, length]. `direction` must be unit length.
 * Altitude along a ray is |o + t d| - radius, which has one minimum (at
 * t = -o.d) and no interior maximum, so the extremes are that point clamped
 * to the segment and the two endpoints.
 */
export function rayAltitudeRange(
  origin: Vec3,
  direction: Vec3,
  length: number,
  radius: number
): { min: number; max: number } {
  const at = (t: number): number =>
    Math.hypot(
      origin[0] + t * direction[0],
      origin[1] + t * direction[1],
      origin[2] + t * direction[2]
    ) - radius
  const dot =
    origin[0] * direction[0] +
    origin[1] * direction[1] +
    origin[2] * direction[2]
  const closest = Math.min(Math.max(-dot, 0), length)
  return { min: at(closest), max: Math.max(at(0), at(length)) }
}
