// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// The cirrus deck's default texture: tileable fibrous streaks, generated on the
// CPU once, so the library ships no extra asset and the shader reads one texel

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType
} from 'three'

// Texels per side. At the default 40 km tile that is 78 m a texel, finer than
// the softest edge a 10 km deck shows from the ground
export const CIRRUS_STREAKS_SIZE = 512

// Lattice cells across the tile for the patch mask, and along and across the
// streaks. The 1:12 ratio is what makes a filament rather than a blob
const PATCH_FREQUENCY = 3
const STREAK_FREQUENCY_ALONG = 2
const STREAK_FREQUENCY_ACROSS = 24
const WARP_FREQUENCY = 2
// How far the streaks bend, in tile units. Enough for the hooked ends of mares'
// tails without folding a filament back over itself
const WARP_AMOUNT = 0.06

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed * 144665
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

// Value noise with an integer period on each axis, so a tile repeats with no
// seam: lattice indices wrap at the period before they are hashed
export function periodicValueNoise(
  x: number,
  y: number,
  periodX: number,
  periodY: number,
  seed: number
): number {
  const fx = x * periodX
  const fy = y * periodY
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = quintic(fx - ix)
  const ty = quintic(fy - iy)
  const x0 = ((ix % periodX) + periodX) % periodX
  const y0 = ((iy % periodY) + periodY) % periodY
  const x1 = (x0 + 1) % periodX
  const y1 = (y0 + 1) % periodY
  const a = hash(x0, y0, seed)
  const b = hash(x1, y0, seed)
  const c = hash(x0, y1, seed)
  const d = hash(x1, y1, seed)
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
}

function fbm(
  x: number,
  y: number,
  periodX: number,
  periodY: number,
  octaves: number,
  seed: number
): number {
  let sum = 0
  let weight = 0.5
  let total = 0
  for (let i = 0; i < octaves; ++i) {
    const scale = 1 << i
    sum +=
      weight *
      periodicValueNoise(x, y, periodX * scale, periodY * scale, seed + i)
    total += weight
    weight *= 0.5
  }
  return sum / total
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// Opacity at one point of the tile, 0..1. Streaks run along x
export function cirrusStreakValue(u: number, v: number, seed: number): number {
  const patch = fbm(u, v, PATCH_FREQUENCY, PATCH_FREQUENCY, 4, seed)
  const warp = fbm(u, v, WARP_FREQUENCY, WARP_FREQUENCY, 2, seed + 17) - 0.5
  const streak = fbm(
    u,
    v + warp * WARP_AMOUNT * 2,
    STREAK_FREQUENCY_ALONG,
    STREAK_FREQUENCY_ACROSS,
    4,
    seed + 31
  )
  const mask = smoothstep(0.38, 0.72, patch)
  const fibres = smoothstep(0.42, 0.78, streak)
  // A faint veil under the fibres, so a patch reads as a sheet with strands in
  // it and not as strands on clear sky
  const veil = 0.18 * smoothstep(0.45, 0.8, patch)
  return Math.min(1, mask * fibres + veil)
}

// The tile as 8-bit opacity, row-major from v = 0
export function generateCirrusStreaks(
  size = CIRRUS_STREAKS_SIZE,
  seed = 1
): Uint8Array {
  const data = new Uint8Array(size * size)
  for (let y = 0; y < size; ++y) {
    for (let x = 0; x < size; ++x) {
      const value = cirrusStreakValue(x / size, y / size, seed)
      data[y * size + x] = Math.round(value * 255)
    }
  }
  return data
}

// Box-filtered mip chain down to 1x1. Built here rather than on the GPU so the
// chain is the same on every device and a test can read it
export function cirrusStreakMips(
  level0: Uint8Array,
  size: number
): Array<{ data: Uint8Array; width: number; height: number }> {
  const mips = [{ data: level0, width: size, height: size }]
  let previous = level0
  for (let s = size >> 1; s >= 1; s >>= 1) {
    const next = new Uint8Array(s * s)
    const ps = s * 2
    for (let y = 0; y < s; ++y) {
      for (let x = 0; x < s; ++x) {
        const i = y * 2 * ps + x * 2
        const sum =
          previous[i]! +
          previous[i + 1]! +
          previous[i + ps]! +
          previous[i + ps + 1]!
        next[y * s + x] = Math.round(sum / 4)
      }
    }
    mips.push({ data: next, width: s, height: s })
    previous = next
  }
  return mips
}

// The default texture the deck samples when none is set: one red channel,
// repeating, mipmapped. The caller owns it and disposes it
export function createCirrusStreaksTexture(
  size = CIRRUS_STREAKS_SIZE,
  seed = 1
): DataTexture {
  const level0 = generateCirrusStreaks(size, seed)
  const texture = new DataTexture(
    level0,
    size,
    size,
    RedFormat,
    UnsignedByteType
  )
  texture.mipmaps = cirrusStreakMips(level0, size)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = false
  texture.name = 'cirrusStreaks'
  texture.needsUpdate = true
  return texture
}
