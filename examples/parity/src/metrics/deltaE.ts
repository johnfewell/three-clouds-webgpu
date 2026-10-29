// Per-pixel ΔE2000 statistics between two linear RGB buffers

import { deltaE2000, linearRgbToLab } from './color'

export interface DeltaEResult {
  deMean: number
  deP95: number
  deMax: number
  perPixel: Float32Array
}

export function computeDeltaE(
  bufA: Float32Array,
  bufB: Float32Array,
  width: number,
  height: number,
  channels = 4
): DeltaEResult {
  const n = width * height
  const perPixel = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const rA = bufA[i * channels]!
    const gA = bufA[i * channels + 1]!
    const bA = bufA[i * channels + 2]!
    const rB = bufB[i * channels]!
    const gB = bufB[i * channels + 1]!
    const bB = bufB[i * channels + 2]!

    const [L1, a1, b1] = linearRgbToLab(rA, gA, bA)
    const [L2, a2, b2] = linearRgbToLab(rB, gB, bB)
    perPixel[i] = deltaE2000(L1, a1, b1, L2, a2, b2)
  }

  let sum = 0
  let max = 0
  for (let i = 0; i < n; i++) {
    sum += perPixel[i]!
    if (perPixel[i]! > max) max = perPixel[i]!
  }

  const sorted = Float32Array.from(perPixel).sort()
  const p95Index = Math.min(Math.floor(n * 0.95), n - 1)

  return {
    deMean: sum / n,
    deP95: sorted[p95Index]!,
    deMax: max,
    perPixel
  }
}
