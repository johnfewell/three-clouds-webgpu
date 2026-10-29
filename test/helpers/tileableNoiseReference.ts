// CPU reference for tileableNoise.glsl, after
// Sébastien Hillaire's TileableVolumeNoise (MIT):
// https://github.com/sebh/TileableVolumeNoise
// Cite: reference/clouds/src/shaders/tileableNoise.glsl. fp64 vs the shader's
// fp32 decorrelates `hash`, so everything downstream is checked by property

import {
  glslFract,
  glslMod,
  perlinReference,
  type Vec4
} from './perlinReference'

export type Vec3 = readonly [number, number, number]

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** `fract(sin(n + 1.951) * 43758.5453)`, the classic sine hash */
export const hashReference = (n: number): number =>
  glslFract(Math.sin(n + 1.951) * 43758.5453)

/**
 * Value noise on the integer lattice, trilinearly interpolated with a
 * smoothstep fade.
 *
 * The lattice offsets 1, 57, 113 (and their sums 58, 114, 170, 171) encode the
 * eight cube corners into a single hash argument `n = x + 57y + 113z`. They are
 * the reference's own magic numbers, not a re-derivation.
 */
export function noiseReference(x: Vec3): number {
  const p: Vec3 = [Math.floor(x[0]), Math.floor(x[1]), Math.floor(x[2])]
  const f0: Vec3 = [glslFract(x[0]), glslFract(x[1]), glslFract(x[2])]
  // smoothstep fade, not the quintic one perlin uses
  const f: Vec3 = [
    f0[0] * f0[0] * (3 - 2 * f0[0]),
    f0[1] * f0[1] * (3 - 2 * f0[1]),
    f0[2] * f0[2] * (3 - 2 * f0[2])
  ]
  const n = p[0] + p[1] * 57 + 113 * p[2]
  const h = (o: number): number => hashReference(n + o)

  return mix(
    mix(mix(h(0), h(1), f[0]), mix(h(57), h(58), f[0]), f[1]),
    mix(mix(h(113), h(114), f[0]), mix(h(170), h(171), f[0]), f[1]),
    f[2]
  )
}

/**
 * Worley (cellular) noise, tileable over the unit cube.
 *
 * The feature points are jittered by `noise(mod(tp, cellCount))`, and it is that
 * `mod` which makes the field wrap: a cell just past the far edge hashes to the
 * same jitter as its counterpart at the near edge. Returns squared distance
 * clamped to [0, 1].
 */
export function worleyReference(p: Vec3, cellCount: number): number {
  const cell: Vec3 = [p[0] * cellCount, p[1] * cellCount, p[2] * cellCount]
  const base: Vec3 = [
    Math.floor(cell[0]),
    Math.floor(cell[1]),
    Math.floor(cell[2])
  ]
  let d = 1e10
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const tp: Vec3 = [base[0] + x, base[1] + y, base[2] + z]
        const wrapped: Vec3 = [
          glslMod(tp[0], cellCount),
          glslMod(tp[1], cellCount),
          glslMod(tp[2], cellCount)
        ]
        const jitter = noiseReference(wrapped)
        const delta: Vec3 = [
          cell[0] - tp[0] - jitter,
          cell[1] - tp[1] - jitter,
          cell[2] - tp[2] - jitter
        ]
        d = Math.min(
          d,
          delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]
        )
      }
    }
  }
  return Math.min(1, Math.max(0, d))
}

/**
 * Fractal Brownian motion over the periodic Perlin, tileable over the unit
 * cube.
 *
 * Each octave evaluates `perlin(point * frequency, (frequency, 1))`, so the
 * period in `point` is exactly 1, which is what makes the 3D textures wrap.
 * Frequency factor 2 and roughness 0.5 as in the reference, sum NOT clamped
 */
export function perlinFbmReference(
  point: Vec3,
  frequency: Vec3,
  octaveCount: number
): number {
  const octaveFrequencyFactor = 2
  let sum = 0
  let weight = 1
  let weightSum = 0
  const roughness = 0.5
  let next: Vec3 = frequency

  for (let i = 0; i < octaveCount; i++) {
    const p: Vec4 = [
      point[0] * next[0],
      point[1] * next[1],
      point[2] * next[2],
      0
    ]
    const rep: Vec4 = [next[0], next[1], next[2], 1]
    sum += perlinReference(p, rep) * weight
    weightSum += weight
    weight *= roughness
    next = [
      next[0] * octaveFrequencyFactor,
      next[1] * octaveFrequencyFactor,
      next[2] * octaveFrequencyFactor
    ]
  }

  return sum / weightSum
}
