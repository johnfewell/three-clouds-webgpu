// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.glsl:63-103, the coverage modulation the cell mask extends
// Opt-in towering convection. What each term is for, and what it costs, is in
// docs/EXPERIMENTAL.md under `convectiveProfile`
import { float, Fn, max, mx_noise_float, smoothstep, uniform } from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

export interface ConvectiveProfileParams {
  // height fraction where the shoulder peaks, 0 to 1
  anvilCenter: number
  // shoulder width in height-fraction units, so 0.1 is a tenth of the layer
  anvilWidth: number
  // shoulder height above the existing profile, as a fraction of it. 0 is off,
  // and the rest is muted where the lane is already dense, because the density
  // saturates (docs/EXPERIMENTAL.md, convectiveProfile trade-offs)
  anvilStrength: number
  // Convective cells per tile of the weather map, so a cell is
  // 40075/cellsPerWeatherTile/localWeatherRepeat.x km. The globe uv covers the
  // whole planet, so an absolute uv scale would be a distance in its own units
  cellsPerWeatherTile: number
  // iso-contour level of the cell noise, 0 to 1
  cellThreshold: number
  // how wide that contour is, so a hard edge does not alias against the march
  cellSoftness: number
  // how far the coverage threshold drops inside a cell. Makes cells solid
  cellDensity: number
}

export const convectiveProfileDefaults: Readonly<ConvectiveProfileParams> =
  Object.freeze({
    anvilCenter: 0.86,
    anvilWidth: 0.11,
    anvilStrength: 0.6,
    cellsPerWeatherTile: 8,
    cellThreshold: 0.52,
    cellSoftness: 0.22,
    cellDensity: 0.12
  })

// The floor below which a layer gets no shoulder. Read from the packed
// minLayerHeights and maxLayerHeights as a uniform magnitude, never from
// CloudLayer.height at graph time, so a resize never needs a rebuild
export const CONVECTIVE_TOWER_MIN_HEIGHT = 4000

// A ramp rather than a step across that floor, so a layer dragged over the
// threshold does not pop
export const CONVECTIVE_TOWER_RAMP = 1000

// The shipped four-term family times a concave shoulder, as one lane per layer
// A replacement for getLayerDensity rather than a wrapper, so the existing call
// stays byte-for-byte when the flag is off
export const convectiveHeightProfile = Fn(
  ([
    heightFraction,
    expTerms,
    exponents,
    linearTerms,
    constantTerms,
    center,
    width,
    strength
  ]: [
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'vec4'>,
    Node<'float'>,
    Node<'float'>,
    Node<'vec4'>
  ]) => {
    // max() guards width = 0, which would divide by zero and hand the tower
    // an exp(-inf) shoulder of 0 instead of the one the caller asked for
    const t = heightFraction.sub(center).div(max(width, float(1e-3)))
    const shoulder = t.mul(t).negate().exp().mul(strength)
    const base = expTerms
      .mul(exponents.mul(heightFraction).exp())
      .add(linearTerms.mul(heightFraction))
      .add(constantTerms)
    return base.add(base.mul(shoulder))
  }
)

export function convectiveHeightProfileCPU(
  heightFraction: number,
  expTerm: number,
  exponent: number,
  linearTerm: number,
  constantTerm: number,
  center: number,
  width: number,
  strength: number
): number {
  const w = Math.max(width, 1e-3)
  const t = (heightFraction - center) / w
  const shoulder = Math.exp(-t * t) * strength
  const base =
    expTerm * Math.exp(exponent * heightFraction) +
    linearTerm * heightFraction +
    constantTerm
  return base * (1 + shoulder)
}

// How much of the shoulder a layer gets, per lane: 1 for a layer at least a
// kilometre over the floor, 0 for one under it, ramping in between
export const towerWeight = Fn(
  ([minHeights, maxHeights]: [Node<'vec4'>, Node<'vec4'>]) =>
    // An inactive lane has thickness 0, which this ramp already zeroes. The
    // two constants are uniforms, not float() literals, so towerWeightCPU can
    // guard them: a literal here would be invisible to every twin
    smoothstep(
      float(0),
      towerWeightUniforms.ramp,
      maxHeights.sub(minHeights).sub(towerWeightUniforms.minHeight)
    )
)

// The two constants towerWeight ramps on, uploaded so the CPU twin can
// compare the shader's values rather than assuming them
const towerWeightUniforms = {
  minHeight: uniform(CONVECTIVE_TOWER_MIN_HEIGHT).setName(
    'convective_minHeight'
  ),
  ramp: uniform(CONVECTIVE_TOWER_RAMP).setName('convective_ramp')
}

export function towerWeightCPU(minHeight: number, maxHeight: number): number {
  const thickness = maxHeight - minHeight
  if (thickness <= 1e-3) return 0
  const t = (thickness - CONVECTIVE_TOWER_MIN_HEIGHT) / CONVECTIVE_TOWER_RAMP
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

// The cell mask: 0 outside every cell, 1 well inside one. Perlin's range is
// nearer 0.7 than 1, so the pivot lands it in roughly [0.15, 0.85]. Pure ALU,
// so it is legal in the march loop where an implicit-LOD sample is not
export const cellMask = Fn(
  ([uv, scale, threshold, softness]: [
    Node<'vec2'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const noise = mx_noise_float(uv.mul(scale), 1, 0.5)
    // max() for the same reason as in convectiveHeightProfile, because
    // smoothstep's two edges have to differ or it divides by zero
    return smoothstep(
      threshold,
      threshold.add(max(softness, float(1e-3))),
      noise
    )
  }
)

export function cellMaskCPU(
  u: number,
  v: number,
  scale: number,
  threshold: number,
  softness: number
): number {
  const t = Math.max(softness, 1e-3)
  const noise = cpuPerlin2D(u * scale, v * scale) + 0.5
  const x = (noise - threshold) / t
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x * x * (3 - 2 * x)
}

// The reference for cellMaskCPU, in the spirit of mx_perlin_noise_float's
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

export interface ConvectiveUniforms {
  anvilCenter: UniformNode<'float', number>
  anvilWidth: UniformNode<'float', number>
  anvilStrength: UniformNode<'float', number>
  cellsPerWeatherTile: UniformNode<'float', number>
  cellThreshold: UniformNode<'float', number>
  cellSoftness: UniformNode<'float', number>
  cellDensity: UniformNode<'float', number>
}

export function createConvectiveUniforms(
  params: ConvectiveProfileParams
): ConvectiveUniforms {
  return {
    anvilCenter: uniform(params.anvilCenter).setName('convective_anvilCenter'),
    anvilWidth: uniform(params.anvilWidth).setName('convective_anvilWidth'),
    anvilStrength: uniform(params.anvilStrength).setName(
      'convective_anvilStrength'
    ),
    cellsPerWeatherTile: uniform(params.cellsPerWeatherTile).setName(
      'convective_cellsPerWeatherTile'
    ),
    cellThreshold: uniform(params.cellThreshold).setName(
      'convective_cellThreshold'
    ),
    cellSoftness: uniform(params.cellSoftness).setName(
      'convective_cellSoftness'
    ),
    cellDensity: uniform(params.cellDensity).setName('convective_cellDensity')
  }
}

export function updateConvectiveUniforms(
  uniforms: ConvectiveUniforms,
  params: ConvectiveProfileParams
): void {
  uniforms.anvilCenter.value = params.anvilCenter
  uniforms.anvilWidth.value = params.anvilWidth
  uniforms.anvilStrength.value = params.anvilStrength
  uniforms.cellsPerWeatherTile.value = params.cellsPerWeatherTile
  uniforms.cellThreshold.value = params.cellThreshold
  uniforms.cellSoftness.value = params.cellSoftness
  uniforms.cellDensity.value = params.cellDensity
}

// The four packed profile vec4s layerUniforms.ts already builds
export interface ConvectiveProfileTerms {
  expTerms: Node<'vec4'>
  exponents: Node<'vec4'>
  linearTerms: Node<'vec4'>
  constantTerms: Node<'vec4'>
}

export interface ConvectiveDeps {
  // sampleShape.ts: replaces getLayerDensity. One lane per layer. The four
  // packed terms are an argument and not captured, because the cloud-type morph
  // blends them per sample and a captured copy drops the morph's deltas
  heightProfile: (
    heightFraction: Node<'vec4'>,
    terms?: ConvectiveProfileTerms
  ) => Node<'vec4'>
  // sampleWeather.ts: the coverage threshold. A scalar, since the mask is 2D
  // on purpose, so one cell runs the full depth of every lane
  cellMask: (uv: Node<'vec2'>) => Node<'float'>
  cellDensity: Node<'float'>
}

// The two sampler seams. Callers get null when the flag is off, and null emits
// no nodes at all, which is the whole of the byte-identity argument
export function buildConvectiveDeps(
  terms: ConvectiveProfileTerms,
  minLayerHeights: Node<'vec4'>,
  maxLayerHeights: Node<'vec4'>,
  localWeatherRepeat: Node<'vec2'>,
  uniforms: ConvectiveUniforms
): ConvectiveDeps {
  const weight = towerWeight(minLayerHeights, maxLayerHeights)
  return {
    heightProfile: (heightFraction, blended) => {
      const t = blended ?? terms
      return convectiveHeightProfile(
        heightFraction,
        t.expTerms,
        t.exponents,
        t.linearTerms,
        t.constantTerms,
        uniforms.anvilCenter,
        uniforms.anvilWidth,
        uniforms.anvilStrength.mul(weight)
      )
    },
    // The scale follows the weather map's own tiling, so a cell is a fixed
    // fraction of a weather feature rather than a distance in its own right
    cellMask: uv =>
      cellMask(
        uv.mul(localWeatherRepeat.x.mul(uniforms.cellsPerWeatherTile)),
        1,
        uniforms.cellThreshold,
        uniforms.cellSoftness
      ),
    cellDensity: uniforms.cellDensity
  }
}
