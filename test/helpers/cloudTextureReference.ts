// CPU reference for the two 3D cloud texture generators, written from the GLSL
//. Cite: cloudShape.frag, cloudShapeDetail.frag
// in reference/clouds/src/shaders. Based on Sébastien Hillaire's
// TileableVolumeNoise (MIT): https://github.com/sebh/TileableVolumeNoise

import {
  perlinFbmReference,
  worleyReference,
  type Vec3
} from './tileableNoiseReference'

/** GLSL `remap(x, min1, max1, min2, max2)`, unclamped as in math.glsl */
export const remapReference = (
  x: number,
  min1: number,
  max1: number,
  min2 = 0,
  max2 = 1
): number => min2 + ((x - min1) / (max1 - min1)) * (max2 - min2)

const dot3 = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// The octave weights, which appear four times across the two generators. They
// sum to 1, which is what keeps the fbm in the same range as its inputs
const W: Vec3 = [0.625, 0.25, 0.125]

/**
 * The four-band Worley fbm both generators share, differing only in the base
 * cell count and the band multipliers.
 *
 * `noise[i] = 1 - worley(point, cellCount * multiplier[i])`, then three
 * overlapping weighted sums, then one more weighted sum of those. The third
 * band's two-component dot (weights 0.75/0.25) is the reference's asymmetry,
 * not a simplification
 */
function worleyBandFbm(
  point: Vec3,
  cellCount: number,
  multipliers: readonly [number, number, number, number]
): number {
  const n = multipliers.map(
    m => 1 - worleyReference(point, cellCount * m)
  ) as unknown as [number, number, number, number]

  const fbm: Vec3 = [
    dot3([n[0], n[1], n[2]], W),
    dot3([n[1], n[2], n[3]], W),
    n[2] * 0.75 + n[3] * 0.25
  ]
  return dot3(fbm, W)
}

/**
 * `cloudShape.frag`'s Perlin-Worley term: a 3-octave Perlin at frequency 8,
 * clamped to [0, 1], remapped so its low end lands on a three-band Worley fbm
 */
export function perlinWorleyReference(point: Vec3): number {
  const perlin = Math.min(
    1,
    Math.max(0, perlinFbmReference(point, [8, 8, 8], 3))
  )
  const cellCount = 4
  const noise: Vec3 = [
    1 - worleyReference(point, cellCount * 2),
    1 - worleyReference(point, cellCount * 8),
    1 - worleyReference(point, cellCount * 14)
  ]
  const fbm = dot3(noise, W)
  return remapReference(perlin, 0, 1, fbm, 1)
}

/** `cloudShape.frag`'s Worley fbm term: base cell count 4, bands 2/4/8/16 */
export const worleyFbmReference = (point: Vec3): number =>
  worleyBandFbm(point, 4, [2, 4, 8, 16])

/**
 * `cloudShape.frag` main: the 128³ base shape.
 *
 * The final remap is deliberately unclamped in the reference: the R8 target it
 * renders into clamps on write
 */
export function cloudShapeReference(point: Vec3): number {
  const perlinWorley = perlinWorleyReference(point)
  const worleyFbm = worleyFbmReference(point)
  return remapReference(perlinWorley, worleyFbm - 1, 1)
}

/** `cloudShapeDetail.frag` main: the 32³ detail. Base cell count 2, bands 1/2/4/8. */
export const cloudShapeDetailReference = (point: Vec3): number =>
  worleyBandFbm(point, 2, [1, 2, 4, 8])
