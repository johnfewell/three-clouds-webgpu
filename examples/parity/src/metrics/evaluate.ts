// Evaluate parity metrics against phase thresholds

import type { PlateStats } from './evaluator.mjs'

export {
  checkMetricsVersion,
  checkPlate,
  evaluate,
  METRICS_VERSION
} from './evaluator.mjs'
export type {
  AcceptedDifference,
  EvalDetail,
  EvalResult,
  Metrics,
  PhaseThresholds,
  PlateCheck,
  PlateStats,
  Thresholds
} from './evaluator.mjs'

export function computeCloudFraction(
  layer: ArrayLike<number>,
  channels = 4
): number {
  const n = Math.floor(layer.length / channels)
  if (n === 0) return 0
  let count = 0
  for (let i = 0; i < n; i++) {
    if (Number(layer[i * channels + 3]) > 0.01) count++
  }
  return count / n
}

/**
 * The threshold computeCloudFraction counts at. Single-sourced so the mask and
 * the fraction cannot drift apart.
 */
export const CLOUD_ALPHA_THRESHOLD = 0.01

/**
 * The cloud mask as committed RGBA bytes.
 *
 * Two channels because neither does both jobs:
 *   R = BINARY at CLOUD_ALPHA_THRESHOLD. mean(R)/255 reproduces
 *       computeCloudFraction EXACTLY, so the artifact self-validates.
 *   G = quantised alpha, for an explicit AMBIGUOUS band in consumer splits.
 *       It shows the veil (the overlay composites over ground pixels too),
 *       which no image-derived mask can see.
 */
export function buildCloudMaskRGBA(
  layer: ArrayLike<number>,
  channels = 4
): Uint8ClampedArray {
  const n = Math.floor(layer.length / channels)
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const a = Number(layer[i * channels + 3])
    out[i * 4] = a > CLOUD_ALPHA_THRESHOLD ? 255 : 0
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(a * 255)))
    out[i * 4 + 2] = 0
    out[i * 4 + 3] = 255
  }
  return out
}

/**
 * mean(R)/255 of a mask built by buildCloudMaskRGBA. The identity this must
 * satisfy is `cloudMaskFraction(buildCloudMaskRGBA(l)) === computeCloudFraction(l)`.
 */
export function cloudMaskFraction(mask: ArrayLike<number>): number {
  const n = Math.floor(mask.length / 4)
  if (n === 0) return 0
  let count = 0
  for (let i = 0; i < n; i++) if (Number(mask[i * 4]) === 255) count++
  return count / n
}

export function computePlateStats(
  data: ArrayLike<number>,
  channels = 4
): PlateStats {
  const n = Math.floor(data.length / channels)
  if (n === 0) return { mean: 0, std: 0 }
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const o = i * channels
    const l =
      0.2126 * Number(data[o]) +
      0.7152 * Number(data[o + 1]) +
      0.0722 * Number(data[o + 2])
    sum += l
    sumSq += l * l
  }
  const mean = sum / n
  const variance = Math.max(0, sumSq / n - mean * mean)
  return { mean, std: Math.sqrt(variance) }
}
