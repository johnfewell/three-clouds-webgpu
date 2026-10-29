// CPU reference for the two 2D generators
//
// Cite: reference/clouds/src/shaders/turbulence.frag,
//       reference/clouds/src/shaders/localWeather.frag
//
// Written from the GLSL, like the references it builds on

import {
  perlinFbmReference,
  worleyReference,
  type Vec3
} from './tileableNoiseReference'

const TURBULENCE_FREQUENCY: Vec3 = [12, 12, 12]
const TURBULENCE_OCTAVES = 3

const perlin = (p: Vec3): number =>
  perlinFbmReference(p, TURBULENCE_FREQUENCY, TURBULENCE_OCTAVES)

/**
 * Three decorrelated Perlin fields, one per output component.
 *
 * The swizzles and the offsets are what decorrelate them: sampling the SAME
 * field three times would give a curl of a gradient, which is identically zero.
 */
export function perlin3dReference(p: Vec3): Vec3 {
  return [
    perlin(p),
    perlin([p[1] - 19.1, p[2] + 33.4, p[0] + 47.2]),
    perlin([p[2] + 74.2, p[0] - 124.5, p[1] + 99.4])
  ]
}

/**
 * Curl of the vector field, by central differences with delta 0.1.
 *
 * Curl is divergence-free by construction, which is what makes it useful as a
 * turbulence field: advecting by it swirls without creating or destroying
 * density.
 */
export function curlReference(p: Vec3): Vec3 {
  const v = rawCurl(perlin3dReference, p)
  const len = Math.hypot(v[0], v[1], v[2])
  // GLSL `normalize` of a zero vector is undefined. Neither the reference nor
  // this guards it: a guard would hide a degenerate field rather than
  // reproduce the shader
  return [v[0] / len, v[1] / len, v[2] / len]
}

/**
 * The central-difference curl, before normalisation, over an arbitrary vector
 * field.
 *
 * Factored out so the component wiring can be tested against a field whose curl
 * is known analytically. It cannot be tested on the noise itself: `delta` is 0.1
 * while the Perlin runs at frequency 12, so a difference step spans more than a
 * whole period and the operator is not approximating a continuous curl at all.
 * Its divergence therefore does NOT vanish numerically (measured ~100), which
 * makes "div curl == 0" useless as a check here even when the wiring is right.
 * On a linear field central differences are exact, so that is what the test uses.
 */
export function rawCurl(field: (p: Vec3) => Vec3, p: Vec3, delta = 0.1): Vec3 {
  const at = (dx: number, dy: number, dz: number): Vec3 =>
    field([p[0] + dx, p[1] + dy, p[2] + dz])

  const px0 = at(-delta, 0, 0)
  const px1 = at(delta, 0, 0)
  const py0 = at(0, -delta, 0)
  const py1 = at(0, delta, 0)
  const pz0 = at(0, 0, -delta)
  const pz1 = at(0, 0, delta)

  const x = py1[2] - py0[2] - pz1[1] + pz0[1]
  const y = pz1[0] - pz0[0] - px1[2] + px0[2]
  const z = px1[1] - px0[1] - py1[0] + py0[0]

  const divisor = 1 / (2 * delta)
  return [x * divisor, y * divisor, z * divisor]
}

/** `turbulence.frag` main: curl packed into [0, 1] as `0.5 * curl + 0.5` */
export function turbulenceReference(uv: readonly [number, number]): Vec3 {
  const c = curlReference([uv[0], uv[1], 0])
  return [c[0] * 0.5 + 0.5, c[1] * 0.5 + 0.5, c[2] * 0.5 + 0.5]
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * localWeather's own Worley fbm, a DIFFERENT function from cloudShape's despite
 * sharing a name in the original. A standard amplitude/lacunarity/gain octave
 * sum over `1 - worley`, deliberately unbounded: the caller's smoothstep does
 * the ranging
 */
export function localWeatherWorleyFbmReference(
  point: Vec3,
  frequency: number,
  amplitude: number,
  lacunarity: number,
  gain: number,
  octaveCount: number
): number {
  let noise = 0
  let f = frequency
  let a = amplitude
  for (let i = 0; i < octaveCount; i++) {
    noise += a * (1 - worleyReference(point, f))
    f *= lacunarity
    a *= gain
  }
  return noise
}

export interface LocalWeather {
  r: number
  g: number
  b: number
  a: number
}

/**
 * `localWeather.frag` main: the 512² weather texture.
 *
 * Channel order matters: GREEN (mid clouds) is computed FIRST because RED (low
 * clouds) subtracts it. Evaluating red first would silently change the layer
 * relationship.
 *
 * Alpha is 1, not the "Extra" Perlin. See the note in the port
 */
export function localWeatherReference(
  uv: readonly [number, number]
): LocalWeather {
  const point: Vec3 = [uv[0], uv[1], 0]

  // Mid clouds, offset by 0.5 on every axis so it does not correlate with low
  const mid = smoothstep(
    1.0,
    1.4,
    localWeatherWorleyFbmReference(
      [point[0] + 0.5, point[1] + 0.5, point[2] + 0.5],
      8,
      0.4,
      2,
      0.95,
      4
    )
  )

  // Low clouds. The subtraction is what keeps low and mid from stacking
  const low = Math.min(
    1,
    Math.max(
      0,
      smoothstep(
        0.8,
        1.4,
        localWeatherWorleyFbmReference(point, 16, 0.4, 2, 0.95, 4)
      ) - mid
    )
  )

  // High clouds: anisotropic frequency (6, 12, 1), 8 octaves
  const high = smoothstep(-0.5, 0.5, perlinFbmReference(point, [6, 12, 1], 8))

  return { r: low, g: mid, b: high, a: 1 }
}

/**
 * The low-cloud term BEFORE mid is subtracted from it.
 *
 * Exposed so the channel relationship can be asserted as an identity rather than
 * inferred: `r === clamp(lowRaw - g, 0, 1)`. Mid never saturates in this texture
 * (measured max 0.948), so the tempting "where mid is 1, low must be 0" check
 * has no samples to run on.
 */
export function localWeatherLowRawReference(
  uv: readonly [number, number]
): number {
  const point: Vec3 = [uv[0], uv[1], 0]
  return smoothstep(
    0.8,
    1.4,
    localWeatherWorleyFbmReference(point, 16, 0.4, 2, 0.95, 4)
  )
}
