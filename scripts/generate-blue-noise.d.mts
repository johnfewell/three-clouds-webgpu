// Types for generate-blue-noise.mjs, in the shape receipt-key.d.mts uses: the
// module is plain .mjs so node runs it as a CLI, and this declares it for its
// own test

export const WIDTH: number
export const HEIGHT: number
export const DEPTH: number
export const SEED: number
export const RANK_MAP_MODULE_PATH: string

export function generateRankMap(seed?: number): Uint8Array
export function goldenVolume(map: Uint8Array, depth?: number): Uint8Array
export function lowbias32Volume(): Uint8Array
export function rankMapModule(map: Uint8Array): string
export function jitterStatistics(bytes: Uint8Array): {
  blurVarianceMin: number
  blurVarianceMax: number
  pixelMeanVariance: number
}
