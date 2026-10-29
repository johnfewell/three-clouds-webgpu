// Types for flipFamily.mjs. Hand-written for the same reason freshBuild.d.ts is:
// examples/parity/tsconfig.json does not include scripts/, so nothing infers
// these, and the test in src/ needs them

export interface DecodedPng {
  width: number
  height: number
  /** 3 for RGB (colour type 2), 4 for RGBA (colour type 6) */
  channels: number
  data: Buffer
}

export function decodePng(buf: Buffer): DecodedPng
export function luminance(img: DecodedPng): Float64Array
export function correlation(x: Float64Array, y: Float64Array): number
export function flipY(a: Float64Array, w: number, h: number): Float64Array
export function mirrorX(a: Float64Array, w: number, h: number): Float64Array
export function perTileFlipY(
  a: Float64Array,
  w: number,
  h: number,
  n: number,
  axis: 'col' | 'row'
): Float64Array
export function main(argvIn?: string[]): number
