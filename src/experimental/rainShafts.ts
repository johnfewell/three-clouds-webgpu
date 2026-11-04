// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Storm shafts: a thin, low-albedo medium hanging from the cell base to the
// ground, placed by the SAME cell mask convectiveProfile thresholds
// Cost and trade-offs: docs/EXPERIMENTAL.md under `rainShafts`

import {
  clamp,
  float,
  Fn,
  max,
  mix,
  mx_noise_float,
  select,
  smoothstep,
  uniform,
  vec2
} from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

export interface RainShaftParams {
  // Global opacity multiplier on both the extinction and the in-scatter, so
  // zero is exactly off without touching the graph
  strength: number
  // Extinction per metre at strength 1, well inside a cell. 1.5e-4 is an
  // optical depth of 0.3 over a 2 km column, which reads as a grey curtain
  density: number
  // Horizontal lean from the base to the ground, in cell widths. 0 is vertical
  slant: number
}

export const rainShaftDefaults: Readonly<RainShaftParams> = Object.freeze({
  strength: 0.75,
  density: 1.5e-4,
  slant: 0.35
})

// How much of the base density survives at the ground. Rain evaporates on the
// way down, so a shaft thins rather than stops, and a hard cut at altitude 0
// would read as a floating slab
export const RAIN_SHAFT_GROUND_FADE = 0.35

// Fraction of the band over which the shaft fades in under the base, so the
// medium does not begin at a hard altitude plane
export const RAIN_SHAFT_TOP_SOFTNESS = 0.15

// How much of the cell noise shows through as ragged edge. cellSoftness is the
// cell's own edge, this is the finer structure inside one
export const RAIN_SHAFT_RAGGEDNESS = 0.55

// Single-scattering albedo, well below the cloud's. Measured on hardware: at 0.3
// the in-scatter lifted more of the sky behind a shaft than the shaft dimmed it,
// which is a haze, not rain. 0.12 dims every background it is tested against
export const RAIN_SHAFT_ALBEDO = 0.12

// Extinction per metre of CLOUD along the sun ray, applied to the marched
// shadow length: 0.01 leaves 10% of the sun through 230 m of cloud
export const RAIN_SHAFT_SUN_EXTINCTION = 0.01

// Fixed steps across the shaft band. Its density varies over kilometres, so
// four samples place the ragged edge without a sun march
export const RAIN_SHAFT_STEP_COUNT = 4

// Which way a slanted shaft leans, in the cell mask's own uv space. A constant
// because getGlobeUv is scale invariant, so no offset of the sample position
// can lean a 2D mask. See the trade-offs in docs/EXPERIMENTAL.md
export const RAIN_SHAFT_LEAN: readonly [number, number] = [0.928, 0.371]

// The shaft's extinction per metre at one sample, 0 outside every cell
// `maskUv` arrives scaled into cell units, so `slant` is in cell widths
// The cell term is cellMask's smoothstep over cellMask's own noise
export const rainShaftDensity = Fn(
  ([maskUv, threshold, softness, heightFraction, strength, density]: [
    Node<'vec2'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const noise = mx_noise_float(maskUv, 1, 0.5)
    // max() for the same reason as convectiveProfile's cellMask: smoothstep's
    // two edges have to differ or it divides by zero
    const cell = smoothstep(
      threshold,
      threshold.add(max(softness, float(1e-3))),
      noise
    )
    // The mask's own field, remapped to 0..1 and clamped because three's Perlin
    // is nearer 0.7 than 1, so an unclamped term could leave [0,1]
    const ragged = mix(
      float(1),
      clamp(noise.mul(0.5).add(0.5), float(0), float(1)),
      float(RAIN_SHAFT_RAGGEDNESS)
    )
    // 0 at the ground, 1 at the base. Outside this band there is no rain
    const vertical = mix(
      float(RAIN_SHAFT_GROUND_FADE),
      float(1),
      smoothstep(float(0), float(RAIN_SHAFT_TOP_SOFTNESS), heightFraction)
    )
    return select(
      heightFraction.greaterThanEqual(0).and(heightFraction.lessThanEqual(1)),
      cell.mul(ragged).mul(vertical).mul(strength).mul(density),
      float(0)
    )
  }
)

// The cell term alone, as the shader emits it: one smoothstep over one noise,
// exactly `cellMask`. Exported so a test can read the shape without a copy
export function rainShaftCellCPU(
  noise: number,
  threshold: number,
  softness: number
): number {
  const t = (noise - threshold) / Math.max(softness, 1e-3)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

// The density from one noise value, the half a test can pin exactly
// `rainShaftDensityCPU` below composes this with the Perlin reference, whose
// gradients differ from three's, so it pins the SHAPE and not the value
export function rainShaftDensityFromNoiseCPU(
  noise: number,
  threshold: number,
  softness: number,
  heightFraction: number,
  strength: number,
  density: number
): number {
  if (heightFraction < 0 || heightFraction > 1) return 0
  const cell = rainShaftCellCPU(noise, threshold, softness)
  const field = Math.min(1, Math.max(0, noise * 0.5 + 0.5))
  const ragged = 1 + (field - 1) * RAIN_SHAFT_RAGGEDNESS
  const h = Math.min(1, Math.max(0, heightFraction))
  const raw = Math.min(1, Math.max(0, h / RAIN_SHAFT_TOP_SOFTNESS))
  const ramp = raw * raw * (3 - 2 * raw)
  const vertical = RAIN_SHAFT_GROUND_FADE + (1 - RAIN_SHAFT_GROUND_FADE) * ramp
  return cell * ragged * vertical * strength * density
}

// The density at a uv, the way the march calls it
export function rainShaftDensityCPU(
  u: number,
  v: number,
  cellScale: number,
  threshold: number,
  softness: number,
  heightFraction: number,
  strength: number,
  density: number
): number {
  return rainShaftDensityFromNoiseCPU(
    rainShaftNoiseCPU(u, v, cellScale),
    threshold,
    softness,
    heightFraction,
    strength,
    density
  )
}

// The mask's own field at a uv. The Perlin reference is one layer down
export function rainShaftNoiseCPU(
  u: number,
  v: number,
  cellScale: number
): number {
  return cpuPerlin2D(u * cellScale, v * cellScale)
}

// The reference for the cell term above, in the spirit of mx_perlin_noise_float's
// gradient table. Its gradients differ from three's, so this pins the SHAPE of
// the mask, and the WGSL snapshot is what pins the shader
function cpuPerlin2D(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const grad = (ix: number, iy: number, dx: number, dy: number): number => {
    const h = cpuHash2(ix, iy) & 7
    const u = h < 4 ? dx : dy
    const v = h < 4 ? dy : dx
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
  }
  const lerp = (a: number, b: number, t: number) => a + t * (b - a)
  const u = fade(fx)
  const v = fade(fy)
  const n00 = grad(xi, yi, fx, fy)
  const n10 = grad(xi + 1, yi, fx - 1, fy)
  const n01 = grad(xi, yi + 1, fx, fy - 1)
  const n11 = grad(xi + 1, yi + 1, fx - 1, fy - 1)
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v)
}

function cpuHash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

export interface RainShaftUniforms {
  strength: UniformNode<'float', number>
  density: UniformNode<'float', number>
  slant: UniformNode<'float', number>
}

export function createRainShaftUniforms(
  params: RainShaftParams
): RainShaftUniforms {
  return {
    strength: uniform(params.strength).setName('rainShafts_strength'),
    density: uniform(params.density).setName('rainShafts_density'),
    slant: uniform(params.slant).setName('rainShafts_slant')
  }
}

export function updateRainShaftUniforms(
  uniforms: RainShaftUniforms,
  params: RainShaftParams
): void {
  uniforms.strength.value = params.strength
  uniforms.density.value = params.density
  uniforms.slant.value = params.slant
}

export interface RainShaftDeps {
  // Extinction per metre at one sample. `uv` and `height` are arguments the
  // caller already has, so neither is derived again here
  //
  density: (height: Node<'float'>, uv: Node<'vec2'>) => Node<'float'>
  // Read back by the per-frame write, and by the bookkeeping test that a knob
  // actually reaches the shader
  uniforms: RainShaftUniforms
}

// The sampler seam. Callers get null when the flag is off, and null emits no
// nodes at all, which is the byte-identity argument. The cell numbers come from
// `ConvectiveProfileParams`, so the two features cannot drift apart
export function buildRainShaftDeps(
  uniforms: RainShaftUniforms,
  localWeatherRepeat: Node<'vec2'>,
  // The band is the lowest layer's altitude: a uniform magnitude, so a taller
  // deck moves the shaft's top with no graph rebuild
  baseHeight: Node<'float'>,
  cell: {
    cellsPerWeatherTile: number
    cellThreshold: number
    cellSoftness: number
  }
): RainShaftDeps {
  const cellScale = localWeatherRepeat.x.mul(
    uniform(cell.cellsPerWeatherTile).setName('rainShafts_cellsPerWeatherTile')
  )
  const threshold = uniform(cell.cellThreshold).setName(
    'rainShafts_cellThreshold'
  )
  const softness = uniform(cell.cellSoftness).setName('rainShafts_cellSoftness')
  const [leanX, leanY] = normalizeLean(RAIN_SHAFT_LEAN)
  const lean = vec2(leanX, leanY)

  return {
    density: (height, uv) => {
      const heightFraction = height.div(max(baseHeight, float(1e-3)))
      // Scaled first, so a slant of 0.35 is 35% of a cell whatever the tiling
      // The lean grows as the sample falls, so the base stays under the tower and
      // the ground is the part that drifts downwind
      const maskUv = uv.mul(cellScale)
      const offset = clamp(heightFraction, 0, 1)
        .oneMinus()
        .mul(uniforms.slant)
        .mul(lean)
      return rainShaftDensity(
        maskUv.add(offset),
        threshold,
        softness,
        heightFraction,
        uniforms.strength,
        uniforms.density
      )
    },
    uniforms
  }
}

function normalizeLean([x, y]: readonly [number, number]): [number, number] {
  const length = Math.hypot(x, y)
  return [x / length, y / length]
}
