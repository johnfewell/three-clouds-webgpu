// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-clouds
// Cite: localWeather.frag:12–83 (the base fields, read as a parameterised
// form), tileableNoise.glsl:28–88 (the noise family, re-seeded here)
// Beyond the reference: the seed, the patterns, the gap mask, the warp

import {
  clamp,
  float,
  Fn,
  mix,
  smoothstep,
  uniform,
  vec3,
  vec4
} from 'three/tsl'
import {
  LinearFilter,
  Vector4,
  type Node,
  type UniformNode
} from 'three/webgpu'

import { LOCAL_WEATHER_SIZE } from '../textures/generators'
import { ProceduralTexture2D } from '../textures/ProceduralTexture'
import { hash } from '../textures/tileableNoise'

// How one channel's coverage field is shaped. Chosen at graph time, so each is
// a different compute shader rather than a branch inside one
export type WeatherPattern = 'clumps' | 'bands' | 'scattered'

export type WeatherChannel = 'low' | 'mid' | 'high'

export interface WeatherChannelParameters {
  // Default: low and mid 'clumps', high 'bands'
  pattern?: WeatherPattern
  // Multiplier on the reference's cells per coverage 1: 16 (low), 8 (mid) and
  // the anisotropic (6, 12) of its high channel
  scale?: number
  // Remaps the smoothstep window over the field, 0.5 being the reference's
  coverage?: number
  // Domain-warp strength, 0 being none
  clumpiness?: number
  // Bands across the band axis. Read by 'bands' only, and the cell count has
  // to stay a multiple of 4 there: the band's 0.75 / 1.5 stretch has to land on
  // the lattice or the field seams at the texture repeat
  bands?: number
  // Fraction of the map forced clear, as contiguous regions rather than cells
  gap?: number
  // fbm octaves. Graph time: the sum unrolls
  octaves?: number
}

export interface ProceduralWeatherParameters {
  // Two seeds give two different weather maps and one seed always gives the
  // same one. Read at fill time, so it is not a graph-time fact: changing it
  // costs one dispatch, not a rebuild
  seed?: number
  size?: number
  low?: WeatherChannelParameters
  mid?: WeatherChannelParameters
  high?: WeatherChannelParameters
}

// The reference's frequencies, so the defaults read like the baked texture
const BASE_SCALE: Record<WeatherChannel, number> = {
  low: 16,
  mid: 8,
  high: 8
}

const DEFAULT_PATTERN: Record<WeatherChannel, WeatherPattern> = {
  low: 'clumps',
  mid: 'clumps',
  high: 'bands'
}

const DEFAULT_CLUMPINESS = 0.15

// Each octave's crest is raised to a power, which narrows it: at 1 the crests
// are as wide as the cells and the sum reads as sheets, at 3 only the cell
// boundaries cross the threshold and the sum reads as filaments
const BAND_CREST_POWER = 3

// GLSL `mod` floors, WGSL `%` truncates. The Worley wrap below uses negative
// indices on every edge cell, where the two disagree, and it shows as a seam
// rather than as an error. Same note as tileableNoise.ts:12-17, kept local
const glslMod = (x: Node<'vec3'>, y: Node<'float'>): Node<'vec3'> =>
  x.sub(y.mul(x.div(y).floor()))

// Value noise with the reference's smoothstep fade (tileableNoise.glsl:39-56),
// its hash argument shifted by an integer salt, which is a bijection over the
// wrapped cells, so a different salt tiles to a different field
function seededValueNoise(
  x: Node<'vec3'>,
  salt: Node<'float'>,
  // Wraps the lattice the way Worley does. Without it the noise is continuous
  // only INSIDE one period, so uv and uv + 1 read different cells and seam
  period?: Node<'vec3'>
): Node<'float'> {
  if (period != null) {
    x = x.sub(period.mul(x.div(period).floor()))
  }
  const p = x.floor()
  const f0 = x.fract()
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)))

  const n = p.x.add(p.y.mul(57)).add(p.z.mul(113))
  const h = (offset: number): Node<'float'> =>
    hash(n.add(float(offset).add(salt)))

  return mix(
    mix(mix(h(0), h(1), f.x), mix(h(57), h(58), f.x), f.y),
    mix(mix(h(113), h(114), f.x), mix(h(170), h(171), f.x), f.y),
    f.z
  )
}

// `mod(cell, cellCount)` on the feature-cell index is what makes the field
// tile (tileableNoise.glsl:61). The 3x3x3 neighbourhood unrolls at graph time
function seededWorley(
  p: Node<'vec3'>,
  cellCount: Node<'float'>,
  salt: Node<'float'>
): Node<'float'> {
  const cell = p.mul(cellCount)
  const base = cell.floor()

  let d: Node<'float'> = float(1e10)
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const tp = base.add(vec3(x, y, z))
        const jitter = seededValueNoise(glslMod(tp, cellCount), salt)
        const delta = cell.sub(tp).sub(jitter)
        d = d.min(delta.dot(delta))
      }
    }
  }
  return d.clamp(0, 1)
}

// An octave sum over `1 - worley`, the reference's own localWeather fbm
// (localWeather.frag:23-33), so the coverage window below matches the baked
// texture's statistics at the defaults
function worleyFbm(
  point: Node<'vec3'>,
  salt: Node<'float'>,
  cellCount: Node<'float'>,
  octaves: number
): Node<'float'> {
  let noise: Node<'float'> = float(0)
  let f = cellCount
  let a = 0.4
  for (let i = 0; i < octaves; i++) {
    noise = noise.add(
      float(1)
        .sub(seededWorley(point, f, salt))
        .mul(a)
    )
    f = f.mul(2)
    a *= 0.95
  }
  return noise
}

// Value-noise fbm at an integer frequency per axis, normalised to 0..1. Only
// the warp, the ridge and the gap gate use it, since they modulate another
// field. Integer frequencies keep it tileable, so a fractional knob is floored
function valueFbm(
  point: Node<'vec3'>,
  salt: Node<'float'>,
  frequency: Node<'vec3'>,
  octaves: number
): Node<'float'> {
  let sum: Node<'float'> = float(0)
  let weightSum = 0
  let weight = 1
  let f = frequency
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(seededValueNoise(point.mul(f), salt.add(i), f).mul(weight))
    weightSum += weight
    weight *= 0.5
    f = f.mul(2)
  }
  return sum.div(weightSum)
}

// Perlin's own tiling comes from a permutation table and value noise has none,
// so every caller wraps the lattice. `period` is the octave's frequency
const ISO_FREQUENCY = 6

// The reference's high channel is anisotropic (6, 12, 1), and the stretch is
// what makes filaments run in bands rather than blobs
const BAND_FREQUENCY = { x: 0.75, y: 1.5, z: 1 }

// Everything one channel reads. Patterns and octaves are plain numbers because
// they unroll at graph time, the rest are uniform components a control can
// write without a graph rebuild
export interface WeatherChannelNodes {
  salt: Node<'float'>
  // Whether the salt is even, which picks the band axis. A graph-time fact,
  // since it is the channel index and not the seed
  saltIsEven: boolean
  pattern: WeatherPattern
  octaves: number
  scale: Node<'float'>
  coverage: Node<'float'>
  clumpiness: Node<'float'>
  bands: Node<'float'>
  gap: Node<'float'>
}

// Offsets the sample point by a low-frequency vector field. Worley cells are
// convex blobs, and warping their centres is what turns them into clumps with
// drawn-out edges, for two cheap value-noise fbm
function warpedPoint(
  point: Node<'vec3'>,
  salt: Node<'float'>,
  clumpiness: Node<'float'>
): Node<'vec3'> {
  const frequency = vec3(ISO_FREQUENCY)
  const wx = valueFbm(point, salt.add(101), frequency, 3).sub(0.5)
  const wy = valueFbm(
    point.add(vec3(0.31, 0.17, 0)),
    salt.add(211),
    frequency,
    3
  ).sub(0.5)
  return point.add(vec3(wx, wy, 0).mul(clumpiness).mul(0.4))
}

// Ridged fbm: `1 - |2n - 1|` per octave, each raised to the crest power
// Never over the sum, which holds its mean near 0.5 and so keeps the ridge
// near 1 everywhere, saturating the field into sheets
function ridgedFbm(
  point: Node<'vec3'>,
  salt: Node<'float'>,
  frequency: Node<'vec3'>,
  octaves: number
): Node<'float'> {
  let sum: Node<'float'> = float(0)
  let weightSum = 0
  let weight = 1
  let f = frequency
  for (let i = 0; i < octaves; i++) {
    const crest = seededValueNoise(point.mul(f), salt.add(i), f)
      .mul(2)
      .sub(1)
      .abs()
      .oneMinus()
      .pow(BAND_CREST_POWER)
    sum = sum.add(crest.mul(weight))
    weightSum += weight
    weight *= 0.5
    f = f.mul(2)
  }
  return sum.div(weightSum)
}

// Frontal bands: a ridged, stretched fbm gated into lanes across the band axis,
// whose axis follows the salt's parity. The gate spans 0.05 to 0.6 of the
// triangle wave, so a lane is half a band period wide
function bandField(
  point: Node<'vec3'>,
  salt: Node<'float'>,
  saltIsEven: boolean,
  cellCount: Node<'float'>,
  octaves: number,
  bands: Node<'float'>
): Node<'float'> {
  const across = saltIsEven ? point.y : point.x
  const tri = across.mul(bands.floor()).fract().mul(2).sub(1).abs()
  const gate = smoothstep(float(0.05), float(0.6), tri).oneMinus()

  const frequency = vec3(
    cellCount.mul(BAND_FREQUENCY.x),
    cellCount.mul(BAND_FREQUENCY.y),
    cellCount.mul(BAND_FREQUENCY.z)
  )

  return ridgedFbm(point, salt, frequency, octaves).mul(gate)
}

// Fair-weather speckle: one Worley octave thresholded near the cell centres,
// so the map is isolated puffs on clear ground rather than a deck
function scatteredField(
  point: Node<'vec3'>,
  salt: Node<'float'>,
  cellCount: Node<'float'>
): Node<'float'> {
  const d = seededWorley(point, cellCount.mul(2).floor(), salt)
  return smoothstep(float(0.05), float(0.4), d).oneMinus()
}

// Each pattern's field has its own range, so each gets its own window. The
// clumps window at coverage 0.5 is the reference's mid (localWeather.frag:62),
// [1.0, 1.4]: more coverage lowers the edge, so the knob reads as coverage
const WINDOW: Record<WeatherPattern, [number, number, number]> = {
  clumps: [1.2, 0.8, 0.4],
  // The ridged field spans 0..1 but sits high, so its window opens near 0.6
  // Opening lower is what filled the lanes to the map edge
  bands: [0.6, 0.1, 0.2],
  scattered: [0.8, 0.35, 0.15]
}

function channelField(
  point: Node<'vec3'>,
  channel: WeatherChannelNodes
): Node<'float'> {
  const warped = warpedPoint(point, channel.salt, channel.clumpiness)
  const cells = channel.scale.floor()

  let field: Node<'float'>
  if (channel.pattern === 'scattered') {
    field = scatteredField(warped, channel.salt, cells)
  } else if (channel.pattern === 'bands') {
    field = bandField(
      warped,
      channel.salt,
      channel.saltIsEven,
      cells,
      channel.octaves,
      channel.bands
    )
  } else {
    field = worleyFbm(warped, channel.salt, cells, channel.octaves)
  }

  const [open, shut, width] = WINDOW[channel.pattern]
  const edge = mix(float(open), float(shut), channel.coverage)
  let value = smoothstep(edge, edge.add(width), field)

  // Contiguous clear regions, from a large-scale field. Raising coverage only
  // punches cell-sized holes, which is a different thing
  const gapMask = smoothstep(
    float(0.38),
    float(0.6),
    valueFbm(point, channel.salt.add(7), vec3(3), 1)
  )
  value = value.mul(gapMask.mul(channel.gap).oneMinus())

  return clamp(value, 0, 1)
}

// Red (low) is computed after green (mid) because it subtracts it, which stops
// the two stacking into a solid deck (localWeather.frag:46-60). Alpha is 1, as
// the reference leaves it after overwriting its Perlin (localWeather.frag:77-82)
function weatherChannels(
  uv: Node<'vec2'>,
  low: WeatherChannelNodes,
  mid: WeatherChannelNodes,
  high: WeatherChannelNodes
): Node<'vec4'> {
  const point = vec3(uv.x, uv.y, 0)

  const midValue = channelField(point, mid)
  const lowValue = channelField(point, low).sub(midValue)
  const highValue = channelField(point, high)

  return vec4(lowValue, midValue, highValue, 1)
}

export type ProceduralWeatherGenerator = (uv: Node<'vec2'>) => Node<'vec4'>

// The generator for one set of channels, ready for ProceduralTexture2D. The
// channels are captured rather than passed as shader arguments because they
// hold plain numbers (patterns, octaves) that unroll at graph time
export function createProceduralWeather(
  low: WeatherChannelNodes,
  mid: WeatherChannelNodes,
  high: WeatherChannelNodes
): ProceduralWeatherGenerator {
  return uv => Fn(() => weatherChannels(uv, low, mid, high))()
}

// One scalar per channel, carried as a vector4 uniform so the whole parameter
// set is five uniforms rather than fifteen
const COMPONENT = { low: 'x', mid: 'y', high: 'z' } as const

// One salt per channel, and the stride that keeps them apart for every seed
const SALT: Record<WeatherChannel, number> = { low: 0, mid: 1, high: 2 }
const SALT_SCALE = 16

type ChannelUniforms = Record<
  'scale' | 'coverage' | 'clumpiness' | 'bands' | 'gap',
  UniformNode<'vec4', Vector4>
>

function channelNodes(
  channel: WeatherChannel,
  salt: Node<'float'>,
  parameters: WeatherChannelParameters,
  uniforms: ChannelUniforms
): WeatherChannelNodes {
  const component = (key: keyof ChannelUniforms): Node<'float'> =>
    uniforms[key][COMPONENT[channel]]
  return {
    salt,
    saltIsEven: SALT[channel] % 2 === 0,
    pattern: parameters.pattern ?? DEFAULT_PATTERN[channel],
    octaves: parameters.octaves ?? 4,
    scale: component('scale').mul(BASE_SCALE[channel]),
    coverage: component('coverage'),
    clumpiness: component('clumpiness'),
    bands: component('bands'),
    gap: component('gap')
  }
}

// A 512² local weather map generated from a seed: coverage scale, clumpiness,
// per-channel pattern, frontal banding and clear gaps. Drop-in for
// `CloudsContext.localWeatherTexture`, and nothing constructs one unless asked
export class ProceduralWeather extends ProceduralTexture2D {
  // The generator this texture was built from, so a caller can wrap or
  // recompile the same field somewhere else
  readonly generate: ProceduralWeatherGenerator

  private readonly seedU: UniformNode<'float', number>

  private readonly scaleU: UniformNode<'vec4', Vector4>
  private readonly coverageU: UniformNode<'vec4', Vector4>
  private readonly clumpinessU: UniformNode<'vec4', Vector4>
  private readonly bandsU: UniformNode<'vec4', Vector4>
  private readonly gapU: UniformNode<'vec4', Vector4>

  // Two seeds give two different maps, one seed always gives the same one
  get seed(): number {
    return this.seedU.value
  }
  set seed(value: number) {
    this.seedU.value = Math.floor(value)
  }

  // [low, mid, high] multiplier on the reference's 16 / 8 / 8 cells
  get scale(): Vector4 {
    return this.scaleU.value
  }
  set scale(value: Vector4) {
    this.scaleU.value.copy(value)
  }

  // [low, mid, high] remapped threshold window, 0.5 being the reference's
  get coverage(): Vector4 {
    return this.coverageU.value
  }
  set coverage(value: Vector4) {
    this.coverageU.value.copy(value)
  }

  // [low, mid, high] domain-warp strength
  get clumpiness(): Vector4 {
    return this.clumpinessU.value
  }
  set clumpiness(value: Vector4) {
    this.clumpinessU.value.copy(value)
  }

  // [low, mid, high] bands across the band axis, 'bands' channels only
  get bands(): Vector4 {
    return this.bandsU.value
  }
  set bands(value: Vector4) {
    this.bandsU.value.copy(value)
  }

  // [low, mid, high] fraction of the map forced clear
  get gap(): Vector4 {
    return this.gapU.value
  }
  set gap(value: Vector4) {
    this.gapU.value.copy(value)
  }

  constructor(parameters: ProceduralWeatherParameters = {}) {
    const seedUniform = uniform(Math.floor(parameters.seed ?? 0)).setName(
      'proceduralWeather_seed'
    )
    const low = parameters.low ?? {}
    const mid = parameters.mid ?? {}
    const high = parameters.high ?? {}

    const pick = (
      read: (p: WeatherChannelParameters) => number | undefined,
      fallbacks: [number, number, number]
    ): UniformNode<'vec4', Vector4> =>
      uniform(
        new Vector4(
          read(low) ?? fallbacks[0],
          read(mid) ?? fallbacks[1],
          read(high) ?? fallbacks[2],
          0
        )
      )

    const uniforms: ChannelUniforms = {
      scale: pick(p => p.scale, [1, 1, 1]),
      // The reference's low window is 0.8 and its mid window 1.0
      // (localWeather.frag:48-60), so the channels do not share one default
      coverage: pick(p => p.coverage, [0.8, 0.5, 0.5]),
      clumpiness: pick(
        p => p.clumpiness,
        [DEFAULT_CLUMPINESS, DEFAULT_CLUMPINESS, 0]
      ),
      bands: pick(p => p.bands, [3, 3, 6]),
      gap: pick(p => p.gap, [0, 0, 0])
    }
    for (const [key, node] of Object.entries(uniforms)) {
      node.setName(`proceduralWeather_${key}`)
    }

    const nodes = (
      channel: WeatherChannel,
      channelParameters: WeatherChannelParameters
    ): WeatherChannelNodes =>
      channelNodes(
        channel,
        seedUniform.mul(SALT_SCALE).add(SALT[channel]),
        channelParameters,
        uniforms
      )

    const generate = createProceduralWeather(
      nodes('low', low),
      nodes('mid', mid),
      nodes('high', high)
    )
    super({ size: parameters.size ?? LOCAL_WEATHER_SIZE, generate })

    this.generate = generate

    // three's WebGPU compute path never generates a storage texture's mip
    // chain (WebGPUBackend.finishCompute only submits), so levels past 0 are
    // undefined. The march samples the map at those angles, so ask for level 0
    this.texture.minFilter = LinearFilter
    ;(this.texture as unknown as { generateMipmaps: boolean }).generateMipmaps =
      false

    this.seedU = seedUniform
    this.scaleU = uniforms.scale
    this.coverageU = uniforms.coverage
    this.clumpinessU = uniforms.clumpiness
    this.bandsU = uniforms.bands
    this.gapU = uniforms.gap
  }

  // Re-fill the texture after writing a parameter vector. Every field is a
  // uniform, so a parameter change costs one dispatch and no graph rebuild
  update(): void {
    this.needsRender = true
  }
}
