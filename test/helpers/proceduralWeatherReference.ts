// CPU twin of src/experimental/proceduralWeather.ts
//
// Mirrors the TSL generator in double precision. It pins the field's STRUCTURE
// (determinism, tiling, monotonicity, what each parameter does), not the GPU's
// exact bits: hash() is fract(sin(n + 1.951) * 43758.5453) with n up to ~2e4,
// and WGSL's sin there is not bit-comparable with Math.sin

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface TwinChannelParameters {
  pattern: 'clumps' | 'bands' | 'scattered'
  scale: number
  coverage: number
  clumpiness: number
  bands: number
  gap: number
  octaves: number
}

export interface TwinParameters {
  seed: number
  low: TwinChannelParameters
  mid: TwinChannelParameters
  high: TwinChannelParameters
}

export const BASE_SCALE = { low: 16, mid: 8, high: 8 }

export const DEFAULT_PATTERN = {
  low: 'clumps',
  mid: 'clumps',
  high: 'bands'
} as const

export function defaultChannelParameters(): TwinChannelParameters {
  return {
    pattern: 'clumps',
    scale: 1,
    coverage: 0.5,
    clumpiness: 0.15,
    bands: 3,
    gap: 0,
    octaves: 4
  }
}

export function defaultParameters(seed = 0): TwinParameters {
  const channel = (
    overrides: Partial<TwinChannelParameters> = {}
  ): TwinChannelParameters => ({
    ...defaultChannelParameters(),
    ...overrides
  })
  return {
    seed: Math.floor(seed),
    low: channel({ coverage: 0.8 }),
    mid: channel(),
    high: channel({ pattern: 'bands', clumpiness: 0, bands: 6 })
  }
}

const fract = (x: number): number => x - Math.floor(x)

export function hash(n: number): number {
  return fract(Math.sin(n + 1.951) * 43758.5453)
}

function glslMod(x: number, y: number): number {
  return x - y * Math.floor(x / y)
}

export function seededValueNoise(x: Vec3, salt: number, period?: Vec3): number {
  if (period != null) {
    x = {
      x: x.x - period.x * Math.floor(x.x / period.x),
      y: x.y - period.y * Math.floor(x.y / period.y),
      z: x.z - period.z * Math.floor(x.z / period.z)
    }
  }
  const px = Math.floor(x.x)
  const py = Math.floor(x.y)
  const pz = Math.floor(x.z)
  const f0x = x.x - px
  const f0y = x.y - py
  const f0z = x.z - pz
  const fade = (f0: number): number => f0 * f0 * (3 - f0 * 2)
  const fx = fade(f0x)
  const fy = fade(f0y)
  const fz = fade(f0z)

  const n = px + py * 57 + pz * 113
  const h = (offset: number): number => hash(n + offset + salt)

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
  return lerp(
    lerp(lerp(h(0), h(1), fx), lerp(h(57), h(58), fx), fy),
    lerp(lerp(h(113), h(114), fx), lerp(h(170), h(171), fx), fy),
    fz
  )
}

export function seededWorley(p: Vec3, cellCount: number, salt: number): number {
  const cell = { x: p.x * cellCount, y: p.y * cellCount, z: p.z * cellCount }
  const base = {
    x: Math.floor(cell.x),
    y: Math.floor(cell.y),
    z: Math.floor(cell.z)
  }

  let d = 1e10
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const tp = { x: base.x + x, y: base.y + y, z: base.z + z }
        const jitter = seededValueNoise(
          {
            x: glslMod(tp.x, cellCount),
            y: glslMod(tp.y, cellCount),
            z: glslMod(tp.z, cellCount)
          },
          salt
        )
        const dx = cell.x - tp.x - jitter
        const dy = cell.y - tp.y - jitter
        const dz = cell.z - tp.z - jitter
        d = Math.min(d, dx * dx + dy * dy + dz * dz)
      }
    }
  }
  return Math.min(Math.max(d, 0), 1)
}

export function worleyFbm(
  point: Vec3,
  salt: number,
  cellCount: number,
  octaves: number
): number {
  let noise = 0
  let f = cellCount
  let a = 0.4
  for (let i = 0; i < octaves; i++) {
    noise += (1 - seededWorley(point, f, salt)) * a
    f *= 2
    a *= 0.95
  }
  return noise
}

export const ISO_FREQUENCY = 6
export const BAND_FREQUENCY = { x: 0.75, y: 1.5, z: 1 }
export const BAND_CREST_POWER = 3
export const WINDOW = {
  clumps: [1.2, 0.8, 0.4],
  bands: [0.6, 0.1, 0.2],
  scattered: [0.8, 0.35, 0.15]
} as const

export function valueFbm(
  point: Vec3,
  salt: number,
  frequency: Vec3,
  octaves: number
): number {
  let sum = 0
  let weightSum = 0
  let weight = 1
  let f = frequency
  for (let i = 0; i < octaves; i++) {
    const p = { x: point.x * f.x, y: point.y * f.y, z: point.z * f.z }
    sum += seededValueNoise(p, salt + i, f) * weight
    weightSum += weight
    weight *= 0.5
    f = { x: f.x * 2, y: f.y * 2, z: f.z * 2 }
  }
  return sum / weightSum
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

function warpedPoint(point: Vec3, salt: number, clumpiness: number): Vec3 {
  const frequency = { x: ISO_FREQUENCY, y: ISO_FREQUENCY, z: ISO_FREQUENCY }
  const wx = valueFbm(point, salt + 101, frequency, 3) - 0.5
  const wy =
    valueFbm(
      { x: point.x + 0.31, y: point.y + 0.17, z: 0 },
      salt + 211,
      frequency,
      3
    ) - 0.5
  return {
    x: point.x + wx * clumpiness * 0.4,
    y: point.y + wy * clumpiness * 0.4,
    z: 0
  }
}

export function ridgedFbm(
  point: Vec3,
  salt: number,
  frequency: Vec3,
  octaves: number
): number {
  let sum = 0
  let weightSum = 0
  let weight = 1
  let f = frequency
  for (let i = 0; i < octaves; i++) {
    const p = { x: point.x * f.x, y: point.y * f.y, z: point.z * f.z }
    const n = seededValueNoise(p, salt + i, f)
    const crest = Math.pow(1 - Math.abs(n * 2 - 1), BAND_CREST_POWER)
    sum += crest * weight
    weightSum += weight
    weight *= 0.5
    f = { x: f.x * 2, y: f.y * 2, z: f.z * 2 }
  }
  return sum / weightSum
}

export function bandField(
  point: Vec3,
  salt: number,
  cellCount: number,
  octaves: number,
  bands: number
): number {
  const count = Math.floor(bands)
  const across = salt % 2 === 0 ? point.y : point.x
  const tri = Math.abs((across * count - Math.floor(across * count)) * 2 - 1)
  const gate = 1 - smoothstep(0.05, 0.6, tri)

  const frequency = {
    x: cellCount * BAND_FREQUENCY.x,
    y: cellCount * BAND_FREQUENCY.y,
    z: cellCount * BAND_FREQUENCY.z
  }

  return ridgedFbm(point, salt, frequency, octaves) * gate
}

export function scatteredField(
  point: Vec3,
  salt: number,
  cellCount: number
): number {
  return (
    1 -
    smoothstep(0.05, 0.4, seededWorley(point, Math.floor(cellCount * 2), salt))
  )
}

export interface SampledChannel extends TwinChannelParameters {
  salt: number
  baseScale: number
}

function sampleChannel(point: Vec3, channel: SampledChannel): number {
  const warped = warpedPoint(point, channel.salt, channel.clumpiness)
  const cells = Math.floor(channel.scale * channel.baseScale)

  let field: number
  if (channel.pattern === 'scattered') {
    field = scatteredField(warped, channel.salt, cells)
  } else if (channel.pattern === 'bands') {
    field = bandField(
      warped,
      channel.salt,
      cells,
      channel.octaves,
      channel.bands
    )
  } else {
    field = worleyFbm(warped, channel.salt, cells, channel.octaves)
  }

  const [open, shut, width] = WINDOW[channel.pattern]
  const edge = lerp(open, shut, channel.coverage)
  let value = smoothstep(edge, edge + width, field)

  const gapMask = smoothstep(
    0.38,
    0.6,
    valueFbm(point, channel.salt + 7, { x: 3, y: 3, z: 3 }, 1)
  )
  value *= 1 - gapMask * channel.gap

  return Math.min(Math.max(value, 0), 1)
}

export function saltFor(channel: 'low' | 'mid' | 'high', seed: number): number {
  return (
    Math.floor(seed) * 16 + (channel === 'low' ? 0 : channel === 'mid' ? 1 : 2)
  )
}

/** RGBA at a normalised uv, low / mid / high in R / G / B and 1 in A */
export function proceduralWeatherReference(
  uv: { x: number; y: number },
  parameters: TwinParameters
): [number, number, number, number] {
  const point: Vec3 = { x: uv.x, y: uv.y, z: 0 }
  const channel = (
    name: 'low' | 'mid' | 'high',
    p: TwinChannelParameters
  ): SampledChannel => ({
    ...p,
    salt: saltFor(name, parameters.seed),
    baseScale: BASE_SCALE[name]
  })

  const mid = sampleChannel(point, channel('mid', parameters.mid))
  const low = Math.min(
    Math.max(sampleChannel(point, channel('low', parameters.low)) - mid, 0),
    1
  )
  const high = sampleChannel(point, channel('high', parameters.high))

  return [low, mid, high, 1]
}

/**
 * Mean of each channel over the unit map, compared against the reference
 * generator's means to check the defaults read like the baked map
 */
export function channelMeans(
  parameters: TwinParameters,
  samples = 48
): { low: number; mid: number; high: number } {
  let low = 0
  let mid = 0
  let high = 0
  let count = 0
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const [l, m, h] = proceduralWeatherReference(
        { x: (i + 0.5) / samples, y: (j + 0.5) / samples },
        parameters
      )
      low += l
      mid += m
      high += h
      count++
    }
  }
  return { low: low / count, mid: mid / count, high: high / count }
}

/** Fraction of samples above `threshold`, per channel */
export function coverageFractions(
  parameters: TwinParameters,
  samples = 32,
  threshold = 0.02
): { low: number; mid: number; high: number } {
  let low = 0
  let mid = 0
  let high = 0
  let count = 0
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const uv = { x: (i + 0.5) / samples, y: (j + 0.5) / samples }
      const [l, m, h] = proceduralWeatherReference(uv, parameters)
      if (l > threshold) low++
      if (m > threshold) mid++
      if (h > threshold) high++
      count++
    }
  }
  return { low: low / count, mid: mid / count, high: high / count }
}
