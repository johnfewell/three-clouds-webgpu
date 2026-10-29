// Evolving weather. The field is generated on the CPU, so the wind, the flow
// map and the life cycle are testable without a GPU. The WGSL half asserts the
// read count and the explicit level: an implicit-LOD read in the march loops
// returns zeros (undefined derivatives), which reads as "the evolution is off"

import {
  DataTexture,
  LinearFilter,
  RepeatWrapping,
  Vector2,
  Vector4
} from 'three'
import { float, texture as tslTexture, uniform, vec2 } from 'three/tsl'
import { describe, expect, test } from 'vitest'

import { compileWGSL, type CompileResult } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { createSampleWeather } from '../density/sampleWeather'
import {
  buildEvolvingWeatherField,
  cpuEvolvingWeather,
  curlWind,
  EvolvingWeather,
  evolvingWeatherDefaults,
  evolvingWeatherFrame,
  FLOW_MAX_STRETCH,
  metresPerWeatherUnit,
  waveField,
  type EvolvingWeatherFrame,
  type EvolvingWeatherParams
} from './evolvingWeather'

function makeUniforms() {
  const tex = new DataTexture(new Uint8Array([255, 128, 64, 32]), 1, 1)
  // The placeholder rule from parameterUniforms.ts: a Nearest/Nearest pair
  // makes three emit textureLoad instead of a filtered sample
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  return {
    localWeatherTexture: tslTexture(tex),
    localWeatherRepeat: uniform(new Vector2(100, 100)),
    localWeatherOffset: uniform(new Vector2(0, 0)),
    minLayerHeights: uniform(new Vector4(750, 1500, 3000, 5000)),
    maxLayerHeights: uniform(new Vector4(1400, 2200, 4000, 6000)),
    weatherExponents: uniform(new Vector4(1, 1, 1, 1)),
    shapeAlteringBiases: uniform(new Vector4(0.35, 0.35, 0.35, 0.35)),
    coverage: uniform(0.3),
    coverageFilterWidths: uniform(new Vector4(0.6, 0.6, 0.6, 0.5)),
    shadowLayerMask: uniform(new Vector4(1, 1, 1, 1))
  }
}

function compileSampler(
  evolving: EvolvingWeather,
  ctx: CloudsContext
): CompileResult {
  const u = makeUniforms()
  const sampler = evolving.build(ctx, u.localWeatherTexture)
  const sampleWeather = createSampleWeather(
    u.localWeatherTexture,
    u.localWeatherRepeat,
    u.localWeatherOffset,
    u.minLayerHeights,
    u.maxLayerHeights,
    u.weatherExponents,
    u.shapeAlteringBiases,
    u.coverage,
    u.coverageFilterWidths,
    u.shadowLayerMask,
    'rgba',
    false,
    undefined,
    sampler
  )
  return compileWGSL(sampleWeather(vec2(0.5, 0.5), float(1000), float(0)))
}

describe('evolving weather field', () => {
  setCurrentSpec('evolvingWeather_field')

  test('tiles without a seam: the wrapping edge steps like every other', () => {
    const size = 128
    const { data } = buildEvolvingWeatherField(size)
    const at = (i: number, j: number, c: number) =>
      data[
        ((((j % size) + size) % size) * size + (((i % size) + size) % size)) *
          4 +
          c
      ]!
    const rows: Array<Record<string, unknown>> = []
    for (let c = 0; c < 4; c++) {
      let interior = 0
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          interior = Math.max(interior, Math.abs(at(i + 1, j, c) - at(i, j, c)))
        }
      }
      // Integer wave numbers, so the wrapping edge steps like every other
      const seam = Math.abs(at(0, 0, c) - at(-1, 0, c))
      rows.push({
        channel: 'RGBA'[c] ?? '?',
        interiorStep: interior,
        seamStep: seam
      })
      expect(seam).toBeLessThanOrEqual(interior * 3)
    }
    table('tile-seam', rows)
  })

  test('the wind field is divergence free', () => {
    const size = 64
    const potential = waveField(size, [
      [1, 1, 1, 0],
      [2, -1, 0.55, 1.7]
    ])
    const curl = curlWind(size, potential)
    const at = (field: Float32Array, i: number, j: number): number =>
      field[(((j % size) + size) % size) * size + (((i % size) + size) % size)]!

    const rmsDivergence = (x: Float32Array, y: Float32Array): number => {
      let sum = 0
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          // central differences on the torus
          const d = (at(x, i + 1, j) - at(x, i - 1, j)) / 2
          const e = (at(y, i, j + 1) - at(y, i, j - 1)) / 2
          sum += (d + e) * (d + e)
        }
      }
      return Math.sqrt(sum / (size * size))
    }

    const curlDivergence = rmsDivergence(curl.x, curl.y)
    // The gradient of the same potential: the control. Its divergence is the
    // full Laplacian, so a curl that is not actually divergence free lands
    // somewhere between the two
    const gradientDivergence = rmsDivergence(potential, potential)
    log('divergence', {
      curlDivergence,
      gradientDivergence,
      ratio: curlDivergence / gradientDivergence
    })
    expect(curlDivergence).toBeLessThan(0.35 * gradientDivergence)
  })
})

// The defaults' frame at the library's default radius and repeat
const METRES_PER_UNIT = metresPerWeatherUnit(6_360_000, 100)
const FIELD = buildEvolvingWeatherField()

function frameAt(
  time: number,
  params: EvolvingWeatherParams = evolvingWeatherDefaults
): EvolvingWeatherFrame {
  return evolvingWeatherFrame(params, time, METRES_PER_UNIT, FIELD.windGradient)
}

// The field as the shader decodes it: signed wind, seeds in [0, 1]
function texel(i: number, j: number) {
  const { data, size } = FIELD
  const n =
    ((((j % size) + size) % size) * size + (((i % size) + size) % size)) * 4
  return {
    wind: [(data[n]! / 255) * 2 - 1, (data[n + 1]! / 255) * 2 - 1] as const,
    lifeSeed: data[n + 2]! / 255,
    periodSeed: data[n + 3]! / 255
  }
}

type Texel = ReturnType<typeof texel>

// One texel pair, both phases. A phase that restarts between the two has no
// stretch to measure there, only its share at the restart
function pairStretch(here: Texel, there: Texel, frame: EvolvingWeatherFrame) {
  const step = 1 / (FIELD.size * frame.fieldScale)
  const a = cpuEvolvingWeather(here.wind, here.lifeSeed, here.periodSeed, frame)
  const b = cpuEvolvingWeather(
    there.wind,
    there.lifeSeed,
    there.periodSeed,
    frame
  )
  let stretch = 0
  let wrapWeight = 0
  for (const phase of [0, 1] as const) {
    const age = (seed: number) => (frame.flowPhase + seed + phase * 0.5) % 1
    if (Math.abs(age(here.periodSeed) - age(there.periodSeed)) > 0.5) {
      wrapWeight = Math.max(wrapWeight, a.weights[phase], b.weights[phase])
      continue
    }
    const pa = a.offsets[phase]
    const pb = b.offsets[phase]
    stretch = Math.max(stretch, Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / step)
  }
  return { stretch, wrapWeight }
}

// The largest stretch either phase applies to the map, over every texel pair
// of the field, and the largest share a phase has where it restarts
function maxStretch(frame: EvolvingWeatherFrame) {
  let stretch = 0
  let wrapWeight = 0
  for (let j = 0; j < FIELD.size; j++) {
    for (let i = 0; i < FIELD.size; i++) {
      for (const there of [texel(i + 1, j), texel(i, j + 1)]) {
        const pair = pairStretch(texel(i, j), there, frame)
        stretch = Math.max(stretch, pair.stretch)
        wrapWeight = Math.max(wrapWeight, pair.wrapWeight)
      }
    }
  }
  return { stretch, wrapWeight }
}

describe('flow map', () => {
  setCurrentSpec('evolvingWeather_flowMap')

  test('the stretch stays bounded however long time runs', () => {
    const rows: Array<Record<string, unknown>> = []
    const speed = evolvingWeatherDefaults.windSpeed / METRES_PER_UNIT
    const gradient = FIELD.windGradient * frameAt(0).fieldScale
    for (const time of [0, 150, 520, 3600, 86_400, 1e7]) {
      const frame = frameAt(time)
      const { stretch, wrapWeight } = maxStretch(frame)
      // What the unbounded drift (offset = wind * speed * time) stretched by
      const unbounded = gradient * speed * time
      rows.push({ time, stretch, unbounded, wrapWeight })
      expect(stretch).toBeLessThan(FLOW_MAX_STRETCH + 0.1)
      // A phase restarts only where its share has faded out
      expect(wrapWeight).toBeLessThan(0.1)
    }
    table('flow-stretch', rows)
    // The control: the drift this replaces had folded the map by t = 3600
    expect(gradient * speed * 3600).toBeGreaterThan(1)
  })

  test('the shares sum to one and a phase restarts while unseen', () => {
    const rows: Array<Record<string, unknown>> = []
    for (let phase = 0; phase < 1; phase += 0.125) {
      const frame = { ...frameAt(0), flowPhase: phase }
      const s = cpuEvolvingWeather([0.6, -0.8], 0.3, 0, frame)
      rows.push({ phase, weightA: s.weights[0], offsetA: s.offsets[0][0] })
      expectClose(s.weights[0] + s.weights[1], 1, { abs: 1e-12 })
    }
    table('flow-shares', rows)
    const atWrap = cpuEvolvingWeather([0.6, -0.8], 0.3, 0, {
      ...frameAt(0),
      flowPhase: 0
    })
    expect(atWrap.weights[0]).toBe(0)
    expect(Math.hypot(...atWrap.offsets[0])).toBe(0)
  })

  test('the drift moves downwind, at the wind speed', () => {
    const frame = frameAt(0)
    const early = cpuEvolvingWeather([1, 0], 0, 0.1, frame)
    const later = cpuEvolvingWeather([1, 0], 0, 0.1, frameAt(10))
    // Sampling upwind moves the clouds downwind
    const moved = early.offsets[0][0] - later.offsets[0][0]
    const expected = (10 * evolvingWeatherDefaults.windSpeed) / METRES_PER_UNIT
    log('downwind', { moved, expected, period: frame.flowPeriod })
    expectClose(moved, expected, { rel: 1e-6 })
  })

  test('a seek lands on the frame that time gives', () => {
    const direct = frameAt(250)
    frameAt(1000)
    expect(frameAt(250)).toEqual(direct)
    // Long clocks keep the phase in [0, 1) without losing it to a float
    const late = frameAt(1e9)
    log('late-phase', { flowPhase: late.flowPhase })
    expect(late.flowPhase).toBeGreaterThanOrEqual(0)
    expect(late.flowPhase).toBeLessThan(1)
  })
})

describe('evolving weather knobs in physical units', () => {
  setCurrentSpec('evolvingWeather_units')

  test('one weather unit is a quarter great circle over the repeat', () => {
    const metres = metresPerWeatherUnit(6_360_000, 100)
    log('metres-per-unit', { metres })
    expectClose(metres, (Math.PI / 2) * 63_600, { rel: 1e-12 })
  })

  test('wind speed sets the period, not the reach', () => {
    const slow = frameAt(0)
    const fast = frameAt(0, { ...evolvingWeatherDefaults, windSpeed: 40 })
    table('wind-speed', [
      { windSpeed: 20, period: slow.flowPeriod, reach: slow.flowReach },
      { windSpeed: 40, period: fast.flowPeriod, reach: fast.flowReach }
    ])
    expectClose(fast.flowPeriod, slow.flowPeriod / 2, { rel: 1e-12 })
    expect(fast.flowReach).toBe(slow.flowReach)
  })

  test('still air reads the map in place', () => {
    const still = frameAt(5000, { ...evolvingWeatherDefaults, windSpeed: 0 })
    const s = cpuEvolvingWeather([0.7, 0.2], 0.1, 0.4, still)
    log('still', { reach: still.flowReach, period: still.flowPeriod })
    expect(still.flowReach).toBe(0)
    expect(Math.hypot(...s.offsets[0], ...s.offsets[1])).toBe(0)
  })

  test('a non-finite or negative knob reads as off', () => {
    const bad = frameAt(100, {
      windSpeed: Number.NaN,
      windPatternSize: -1,
      cellLifetime: Number.POSITIVE_INFINITY,
      lifeStrength: -0.5
    })
    log('bad-knobs', { ...bad })
    expect(bad.flowReach).toBe(0)
    expect(bad.fieldScale).toBe(0)
    expect(bad.cellLifetime).toBe(0)
    expect(bad.lifeStrength).toBe(0)
  })
})

describe('cloud life cycle', () => {
  setCurrentSpec('evolvingWeather_lifeCycle')

  const strength = evolvingWeatherDefaults.lifeStrength

  test('growth and decay are asymmetric and stay within the amplitude band', () => {
    const samples: number[] = []
    for (let cycle = 0; cycle <= 1.0001; cycle += 0.05) {
      samples.push(cpuEvolvingWeather([0, 0], cycle, 0.5, frameAt(0)).growth)
    }
    const min = Math.min(...samples)
    const max = Math.max(...samples)
    log('growth-band', { min, max, band: [1 - strength, 1 + strength] })
    expectClose(min, 1 - strength, { abs: 0.001 })
    expectClose(max, 1 + strength, { abs: 0.001 })

    // Growth reaches its peak a quarter of the way in, so the first half of
    // the cycle is short and the second is long
    const peak = samples.indexOf(max)
    log('cycle-asymmetry', { peakFraction: peak / 20, samples: samples.length })
    expect(peak / 20).toBeGreaterThan(0.15)
    expect(peak / 20).toBeLessThan(0.35)
  })

  test('the life cycle wraps continuously at its period', () => {
    const periodSeed = 0.5
    const period = evolvingWeatherDefaults.cellLifetime * (0.5 + periodSeed)
    const before = cpuEvolvingWeather([0.4, -0.2], 0.3, periodSeed, frameAt(0))
    const after = cpuEvolvingWeather(
      [0.4, -0.2],
      0.3,
      periodSeed,
      frameAt(period)
    )
    log('cycle-wrap', {
      growthBefore: before.growth,
      growthAfter: after.growth
    })
    expectClose(before.growth, after.growth, { abs: 1e-9 })
  })
})

describe('evolving weather WGSL', () => {
  setCurrentSpec('evolvingWeather_wgsl')

  test('off: one weather read and no field read', () => {
    const ctx = new CloudsContext()
    const { fragment } = compileSampler(new EvolvingWeather(), ctx)
    const reads = (fragment.match(/textureSampleLevel/g) ?? []).length
    log('off', { reads, bytes: fragment.length })
    expect(reads).toBe(1)
  })

  test('on: the field and two flow phases, every read explicit-level', () => {
    const ctx = new CloudsContext()
    ctx.experimental = { evolvingWeather: true }
    const { fragment } = compileSampler(new EvolvingWeather(), ctx)
    const reads = (fragment.match(/textureSampleLevel/g) ?? []).length
    // An implicit-LOD sample in here would emit textureSample and read
    // undefined derivatives inside the march loops
    const implicit = (fragment.match(/textureSample\(/g) ?? []).length
    log('on', { reads, implicitLodReads: implicit })
    expect(reads).toBe(3)
    expect(implicit).toBe(0)
  })

  test('update() reads the context and assigns, so a seek lands', () => {
    const evolving = new EvolvingWeather()
    const ctx = new CloudsContext()
    ctx.experimental = { evolvingWeather: true }
    compileSampler(evolving, ctx)
    ctx.time = 412.5
    evolving.update(ctx)
    const first = { ...evolving.frame }
    ctx.time = 0
    evolving.update(ctx)
    ctx.time = 412.5
    evolving.update(ctx)
    expect(evolving.frame).toEqual(first)

    // A knob on the context reaches the next frame, no rebuild
    ctx.evolvingWeather.windSpeed *= 2
    evolving.update(ctx)
    log('update', {
      before: first.flowPeriod,
      after: evolving.frame?.flowPeriod
    })
    expectClose(evolving.frame!.flowPeriod, first.flowPeriod! / 2, {
      rel: 1e-12
    })
  })

  test('update() is inert until the option builds the sampler', () => {
    const evolving = new EvolvingWeather()
    evolving.update(new CloudsContext())
    expect(evolving.frame).toBeNull()
  })

  test('the field is bound as a repeating, mip-free texture', () => {
    const ctx = new CloudsContext()
    ctx.experimental = { evolvingWeather: true }
    const { boundTextures } = compileSampler(new EvolvingWeather(), ctx)
    const field = boundTextures().find(
      candidate =>
        (candidate as { wrapS?: unknown }).wrapS === RepeatWrapping &&
        (candidate as { image?: { width?: number } }).image?.width === 128
    )
    expect(field).toBeDefined()
    // No mip chain: the sampler asks for level 0 explicitly, and a chain would
    // only cost the upload
    expect((field as { generateMipmaps: boolean }).generateMipmaps).toBe(false)
    log('field-binding', {
      boundTextures: boundTextures().length,
      width: (field as { image: { width: number } }).image.width
    })
    table('field-encoding', [
      { channel: 'R', meaning: 'wind x, signed' },
      { channel: 'G', meaning: 'wind y, signed' },
      { channel: 'B', meaning: 'life-cycle seed' },
      { channel: 'A', meaning: 'life-cycle period, 0.5 to 1.5 of nominal' }
    ])
  })
})
