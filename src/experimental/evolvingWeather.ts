// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:63-103, CloudsMaterial.ts:338-358 - the weather map and
// the linear offset advection it already has. The evolution below is new

import {
  DataTexture,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector4
} from 'three'
import {
  float,
  Fn,
  fract,
  mix,
  smoothstep,
  texture as tslTexture,
  uniform
} from 'three/tsl'
import type { Node, TextureNode, UniformNode } from 'three/webgpu'

import type { CloudsContext } from '../CloudsContext'
import type { WeatherSampler } from '../density/sampleWeather'

// A life cycle is growth then decay, so the quarters are unequal on purpose
const GROWTH_END = 0.25
const DECAY_START = 0.75

// The flow map's bound on the wind's stretch of the map at a phase's full age
// The phase seed's own gradient adds a little on top (the twin test bounds both)
export const FLOW_MAX_STRETCH = 0.15

export const EVOLVING_WEATHER_FIELD_SIZE = 128

// Wave vectors of the potential in cycles per wind tile: kx, ky, amplitude,
// phase. Integer kx/ky make the field periodic, so one tile of the generated
// texture repeats without a seam
const WIND_MODES: readonly (readonly [number, number, number, number])[] = [
  [1, 1, 1, 0],
  [2, -1, 0.55, 1.7],
  [-1, 3, 0.45, 3.1],
  [3, 2, 0.3, 5.2]
]
const LIFE_MODES: readonly (readonly [number, number, number, number])[] = [
  [1, 2, 1, 0.9],
  [2, 3, 0.6, 2.4],
  [3, -2, 0.35, 4.7]
]
const PERIOD_MODES: readonly (readonly [number, number, number, number])[] = [
  [1, 1, 1, 2.2],
  [2, 1, 0.5, 5.1]
]

const TAU = Math.PI * 2

export interface EvolvingWeatherParams {
  // Peak speed of the swirling wind, in metres per second. 0 stops the drift
  windSpeed: number
  // The wind pattern repeats every this many metres. Each swirl in it is about
  // a third of that
  windPatternSize: number
  // Nominal seconds for a cloud cell to grow and fade away. Each cell runs
  // between half and one and a half times this, so the sky never pulses
  cellLifetime: number
  // How far a cell swells at its peak and thins at its end, from 0 to 1
  lifeStrength: number
}

export const evolvingWeatherDefaults: Readonly<EvolvingWeatherParams> =
  Object.freeze({
    windSpeed: 20,
    windPatternSize: 500_000,
    cellLifetime: 600,
    lifeStrength: 0.4
  })

type Mode = readonly [number, number, number, number]

// Sum of the modes' cosine waves, one per grid cell, normalised by the grid's
// own extremes so the bytes use the full range whatever the amplitudes
export function waveField(size: number, modes: readonly Mode[]): Float32Array {
  const field = new Float32Array(size * size)
  let min = Infinity
  let max = -Infinity
  for (let j = 0; j < size; j++) {
    const y = j / size
    for (let i = 0; i < size; i++) {
      const x = i / size
      let sum = 0
      for (const [kx, ky, amplitude, phase] of modes) {
        sum += amplitude * Math.cos(TAU * (kx * x + ky * y) + phase)
      }
      field[j * size + i] = sum
      if (sum < min) min = sum
      if (sum > max) max = sum
    }
  }
  const span = max - min
  for (let n = 0; n < field.length; n++) {
    field[n] = span > 0 ? ((field[n] ?? 0) - min) / span : 0.5
  }
  return field
}

// The curl of the potential, so the flow has no divergence and the map never
// bunches into sinks the way a gradient field would
export function curlWind(
  size: number,
  potential: Float32Array
): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(size * size)
  const y = new Float32Array(size * size)
  let max = 0
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const here = potential[j * size + i]!
      // Forward differences on a torus, so every cell has both neighbours
      // and no cell sees a step at the tile edge
      const east = potential[j * size + ((i + 1) % size)]!
      const north = potential[((j + 1) % size) * size + i]!
      x[j * size + i] = north - here
      y[j * size + i] = here - east
      max = Math.max(
        max,
        Math.abs(x[j * size + i]!),
        Math.abs(y[j * size + i]!)
      )
    }
  }
  const inverse = max > 0 ? 1 / max : 0
  for (let n = 0; n < x.length; n++) {
    x[n]! *= inverse
    y[n]! *= inverse
  }
  return { x, y }
}

// The largest forward difference of any of the fields, per wind tile, so the
// flow period can bound the stretch whatever the modes are
export function maxFieldGradient(
  size: number,
  fields: readonly Float32Array[]
): number {
  let max = 0
  for (const field of fields) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const here = field[j * size + i]!
        const east = field[j * size + ((i + 1) % size)]!
        const north = field[((j + 1) % size) * size + i]!
        max = Math.max(max, Math.abs(east - here), Math.abs(north - here))
      }
    }
  }
  return max * size
}

export interface EvolvingWeatherField {
  data: Uint8Array
  size: number
  // Per wind tile. `windGradient` covers both wind components (signed, -1 to
  // 1), `seedGradient` the phase seed in A (0 to 1)
  windGradient: number
  seedGradient: number
}

export function buildEvolvingWeatherField(
  size = EVOLVING_WEATHER_FIELD_SIZE
): EvolvingWeatherField {
  const wind = curlWind(size, waveField(size, WIND_MODES))
  const life = waveField(size, LIFE_MODES)
  const period = waveField(size, PERIOD_MODES)
  const data = new Uint8Array(size * size * 4)
  for (let n = 0; n < size * size; n++) {
    data[n * 4] = Math.round((wind.x[n]! * 0.5 + 0.5) * 255)
    data[n * 4 + 1] = Math.round((wind.y[n]! * 0.5 + 0.5) * 255)
    data[n * 4 + 2] = Math.round(life[n]! * 255)
    data[n * 4 + 3] = Math.round(period[n]! * 255)
  }
  return {
    data,
    size,
    windGradient: maxFieldGradient(size, [wind.x, wind.y]),
    seedGradient: maxFieldGradient(size, [period])
  }
}

// One weather texture unit in metres. The weather uv is the cube-sphere face
// coordinate (globeUv.ts), so one face edge, a quarter of a great circle,
// spans localWeatherRepeat texture units
export function metresPerWeatherUnit(
  bottomRadius: number,
  localWeatherRepeat: number
): number {
  return ((Math.PI / 2) * bottomRadius) / localWeatherRepeat
}

// What the sampler reads in one frame, derived on the CPU in double precision
export interface EvolvingWeatherFrame {
  // Weather units to wind-field units
  fieldScale: number
  // Seconds per flow cycle. Infinity when the wind is still
  flowPeriod: number
  // fract(time / flowPeriod), so a long clock costs no float precision
  flowPhase: number
  // How far a phase drifts at its full age, in weather units
  flowReach: number
  time: number
  cellLifetime: number
  lifeStrength: number
}

const positive = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0

export function evolvingWeatherFrame(
  params: EvolvingWeatherParams,
  time: number,
  metresPerUnit: number,
  windGradient: number
): EvolvingWeatherFrame {
  const patternSize = positive(params.windPatternSize)
  const fieldScale = patternSize > 0 ? metresPerUnit / patternSize : 0
  // The wind's steepest change per weather unit at unit speed. The reach is
  // the drift that stretches the map by FLOW_MAX_STRETCH, whatever the speed
  const gradient = windGradient * fieldScale
  const speed = positive(params.windSpeed) / metresPerUnit
  const still = speed === 0 || gradient === 0
  const flowReach = still ? 0 : FLOW_MAX_STRETCH / gradient
  const flowPeriod = still ? Infinity : flowReach / speed
  const cycles = still ? 0 : time / flowPeriod
  return {
    fieldScale,
    flowPeriod,
    flowPhase: cycles - Math.floor(cycles),
    flowReach,
    time,
    cellLifetime: positive(params.cellLifetime),
    lifeStrength: Math.min(1, positive(params.lifeStrength))
  }
}

export interface EvolvingWeatherSample {
  // Each flow phase's displacement of the weather read, in weather units
  offsets: [[number, number], [number, number]]
  // Each phase's share. They sum to 1, and a phase's share is 0 at its wrap
  weights: [number, number]
  growth: number
}

// The CPU twin of the sampler at one texture coordinate. `wind` is signed,
// the seeds are the field's B and A channels
export function cpuEvolvingWeather(
  wind: readonly [number, number],
  lifeSeed: number,
  periodSeed: number,
  frame: EvolvingWeatherFrame
): EvolvingWeatherSample {
  const phaseA = fract01(frame.flowPhase + periodSeed)
  const phaseB = fract01(phaseA + 0.5)
  const weightA = 1 - Math.abs(2 * phaseA - 1)
  const offset = (phase: number): [number, number] => [
    -wind[0] * phase * frame.flowReach,
    -wind[1] * phase * frame.flowReach
  ]

  const period = frame.cellLifetime * (0.5 + periodSeed)
  const cycle = fract01(lifeSeed + (period === 0 ? 0 : frame.time / period))
  const rise = smoothstep01(cycle / GROWTH_END)
  const fall = 1 - smoothstep01((cycle - DECAY_START) / (1 - DECAY_START))
  const life = rise * fall
  const strength = frame.lifeStrength
  return {
    offsets: [offset(phaseA), offset(phaseB)],
    weights: [weightA, 1 - weightA],
    growth: (1 - strength) * (1 - life) + (1 + strength) * life
  }
}

function fract01(x: number): number {
  return x - Math.floor(x)
}

function smoothstep01(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

interface EvolvingWeatherUniforms {
  time: UniformNode<'float', number>
  fieldScale: UniformNode<'float', number>
  // flowPhase, flowReach, cellLifetime, lifeStrength
  params: UniformNode<'vec4', Vector4>
}

// Owns the field and the uniforms the evolution reads. The knobs live on
// CloudsContext.evolvingWeather and are read every frame. Nothing here is
// referenced while the option is off, so the default graph is untouched
export class EvolvingWeather {
  private _field: EvolvingWeatherField | null = null
  private _texture: DataTexture | null = null
  private _uniforms: EvolvingWeatherUniforms | null = null
  private _frame: EvolvingWeatherFrame | null = null

  // The last frame update() derived, null until the option is on
  get frame(): Readonly<EvolvingWeatherFrame> | null {
    return this._frame
  }

  // null unless the option is on, which is what keeps the default graph
  // identical to a build without this module
  build(ctx: CloudsContext, weather: TextureNode): WeatherSampler | null {
    if (!ctx.experimental.evolvingWeather) return null
    const texture = tslTexture(this.ensureTexture())
    this._uniforms ??= {
      time: uniform(0).setName('evolvingWeather_time'),
      fieldScale: uniform(1).setName('evolvingWeather_fieldScale'),
      params: uniform(new Vector4()).setName('evolvingWeather_params')
    }
    this.update(ctx)
    return this.createSampler(weather, texture, this._uniforms)
  }

  private createSampler(
    weather: TextureNode,
    field: TextureNode,
    { time, fieldScale, params }: EvolvingWeatherUniforms
  ): WeatherSampler {
    return Fn(([texCoord, mipLevel]: [Node<'vec2'>, Node<'float'>]) => {
      // .level(0) explicitly: this runs inside the march loops, where an
      // implicit-LOD sample would read undefined derivatives, which WGSL
      // leaves undefined in non-uniform control flow
      const cell = field.sample(texCoord.mul(fieldScale)).level(float(0))
      const wind = cell.xy.mul(2).sub(1)

      // Two-phase flow map: each phase drifts for one flow period and restarts
      // while its share is 0, so the stretch is bounded however long time runs
      // The seed staggers the restarts over space, so the sky never pulses
      const phaseA = fract(params.x.add(cell.w))
      const phaseB = fract(phaseA.add(0.5))
      const weightA = phaseA.mul(2).sub(1).abs().oneMinus()
      const readA = texCoord.sub(wind.mul(phaseA.mul(params.y)))
      const readB = texCoord.sub(wind.mul(phaseB.mul(params.y)))
      const flowed = mix(
        weather.sample(readB).level(mipLevel),
        weather.sample(readA).level(mipLevel),
        weightA
      )

      // One period per cell, between half and one and a half of the nominal,
      // so neighbouring cells are out of step and the map never pulses
      const period = mix(params.z.mul(0.5), params.z.mul(1.5), cell.w)
      const cycle = fract(cell.z.add(time.div(period)))
      const life = smoothstep(float(0), float(GROWTH_END), cycle).mul(
        smoothstep(float(DECAY_START), float(1), cycle).oneMinus()
      )
      return flowed.mul(
        mix(float(1).sub(params.w), float(1).add(params.w), life)
      )
    })
  }

  // Assigns, never accumulates, so a seek lands on the frame that time gives
  update(ctx: CloudsContext): void {
    const uniforms = this._uniforms
    if (uniforms == null) return
    const field = this.ensureField()
    const repeat = (ctx.localWeatherRepeat.x + ctx.localWeatherRepeat.y) / 2
    const frame = evolvingWeatherFrame(
      ctx.evolvingWeather,
      ctx.time,
      metresPerWeatherUnit(ctx.bottomRadius, repeat),
      field.windGradient
    )
    this._frame = frame
    uniforms.time.value = frame.time
    uniforms.fieldScale.value = frame.fieldScale
    uniforms.params.value.set(
      frame.flowPhase,
      frame.flowReach,
      frame.cellLifetime,
      frame.lifeStrength
    )
  }

  private ensureField(): EvolvingWeatherField {
    this._field ??= buildEvolvingWeatherField()
    return this._field
  }

  private ensureTexture(): DataTexture {
    this._texture ??= this.createTexture()
    return this._texture
  }

  private createTexture(): DataTexture {
    const { data, size } = this.ensureField()
    const texture = new DataTexture(
      data,
      size,
      size,
      RGBAFormat,
      UnsignedByteType
    )
    // The sampler reads far outside [0,1) and the modes are integer-frequency,
    // so one tile repeats without a step at the wrap
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    // No mip chain, since the sampler asks for level 0
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.colorSpace = NoColorSpace
    texture.needsUpdate = true
    return texture
  }

  dispose(): void {
    this._texture?.dispose()
    this._texture = null
    this._uniforms = null
    this._frame = null
  }
}
