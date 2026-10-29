import { float, uniform, vec2 } from 'three/tsl'
import { Vector4, type Node } from 'three/webgpu'
import { describe, expect, test } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  channelMeans,
  coverageFractions,
  defaultParameters,
  proceduralWeatherReference,
  saltFor,
  type TwinParameters
} from '../../test/helpers/proceduralWeatherReference'
import { localWeatherReference } from '../../test/helpers/weatherTextureReference'
import { CloudsContext } from '../CloudsContext'
import { LOCAL_WEATHER_SIZE } from '../textures/generators'
import {
  createProceduralWeather,
  ProceduralWeather,
  type WeatherChannel,
  type WeatherChannelNodes
} from './proceduralWeather'

// The CPU twin pins structure, not GPU bits: see the twin's header. Every
// assertion below is about a property that must hold for ANY correct
// implementation, so it survives the sin() divergence at the last digit

const SAMPLES = 24

const COMPONENT = { low: 'x', mid: 'y', high: 'z' } as const

// The twin's parameters as uniform-backed channel nodes: the same field the
// class builds, so the WGSL under test is the shipped graph
function nodesFromTwin(
  channel: WeatherChannel,
  parameters: TwinParameters
): WeatherChannelNodes {
  const p =
    channel === 'low'
      ? parameters.low
      : channel === 'mid'
        ? parameters.mid
        : parameters.high
  const one = (value: number): Node<'float'> => float(value)
  const component = (value: number): Node<'float'> =>
    uniform(new Vector4(value, value, value, 0))[COMPONENT[channel]]
  return {
    salt: float(saltFor(channel, parameters.seed)),
    saltIsEven: saltFor(channel, parameters.seed) % 2 === 0,
    pattern: p.pattern,
    octaves: p.octaves,
    scale: one(p.scale),
    coverage: component(p.coverage),
    clumpiness: component(p.clumpiness),
    bands: component(p.bands),
    gap: component(p.gap)
  }
}

function buildWGSL(parameters: TwinParameters): string {
  const generate = createProceduralWeather(
    nodesFromTwin('low', parameters),
    nodesFromTwin('mid', parameters),
    nodesFromTwin('high', parameters)
  )
  return compileWGSL(generate(vec2(0.5, 0.5))).fragment
}

function field(
  parameters: TwinParameters,
  pick: (rgba: [number, number, number, number]) => number,
  nx = SAMPLES,
  ny = SAMPLES
): number[] {
  const out: number[] = []
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const uv = { x: (i + 0.5) / nx, y: (j + 0.5) / ny }
      out.push(pick(proceduralWeatherReference(uv, parameters)))
    }
  }
  return out
}

describe('proceduralWeather — CPU twin', () => {
  setCurrentSpec('procedural-weather-cpu')

  test('one seed gives one map, every time', () => {
    const a = defaultParameters(7)
    const b = defaultParameters(7)
    const at = [0.1, 0.25, 0.5, 0.75, 0.9].map(y =>
      proceduralWeatherReference({ x: 0.3, y }, a)
    )
    const bt = [0.1, 0.25, 0.5, 0.75, 0.9].map(y =>
      proceduralWeatherReference({ x: 0.3, y }, b)
    )
    expect(at).toEqual(bt)

    log('seed-determinism', [
      { field: 'seed 7 low', expected: at[0]![0], actual: at[0]![0] },
      { field: 'seed 7 mid', expected: at[0]![1], actual: at[0]![1] },
      { field: 'seed 7 high', expected: at[0]![2], actual: at[0]![2] },
      { field: 'alpha', expected: 1, actual: at[0]![3] }
    ])
  })

  test('two seeds give different maps', () => {
    const seven = defaultParameters(7)
    const eight = defaultParameters(8)
    const low7 = field(seven, c => c[0])
    const low8 = field(eight, c => c[0])
    const differing = low7.filter(
      (v, i) => Math.abs(v - low8[i]!) > 0.05
    ).length

    // A seed that only permutes a corner of the map would still tile and still
    // look like weather, so the bar is most of the map, not a few samples
    expect(differing / low7.length).toBeGreaterThan(0.5)
    log('seed-sensitivity', {
      samples: low7.length,
      differing,
      fraction: +(differing / low7.length).toFixed(3)
    })
  })

  test('the map tiles on both axes', () => {
    // The weather texture repeats ~100 times across a sky. A seam would be a
    // line of missing or doubled cloud running to the horizon, so this is the
    // property that makes the field usable at all
    const parameters = defaultParameters(3)
    let worst = 0
    for (let i = 0; i < 12; i++) {
      const u = (i + 0.5) / 12
      for (const j of [0.13, 0.41, 0.62, 0.88]) {
        const a = proceduralWeatherReference({ x: u, y: j }, parameters)
        const wrappedX = proceduralWeatherReference(
          { x: u + 1, y: j },
          parameters
        )
        const wrappedY = proceduralWeatherReference(
          { x: u, y: j + 1 },
          parameters
        )
        for (let c = 0; c < 4; c++) {
          worst = Math.max(
            worst,
            Math.abs(a[c]! - wrappedX[c]!),
            Math.abs(a[c]! - wrappedY[c]!)
          )
        }
      }
    }
    expect(worst).toBeLessThan(1e-9)
    log('tiling', { worstDelta: worst })
  })

  test('coverage is monotone: more coverage never thins the field', () => {
    const base = defaultParameters(5)
    const thicker = defaultParameters(5)
    thicker.mid.coverage = 0.8

    const before = field(base, c => c[1])
    const after = field(thicker, c => c[1])
    const regressions = after.filter((v, i) => v < before[i]! - 1e-12).length

    expect(regressions).toBe(0)
    expect(after.some((v, i) => v > before[i]! + 1e-6)).toBe(true)
    log('coverage-monotone', {
      samples: before.length,
      regressions,
      gained: after.filter((v, i) => v > before[i]! + 1e-6).length
    })
  })

  test('the defaults read like the baked map they replace', () => {
    // The point of the defaults: swap the generator in and the sky still looks
    // like the same weather. Measured as per-channel means against the
    // reference generator's own means over the same grid
    const mine = channelMeans(defaultParameters(11))
    const reference = { low: 0, mid: 0, high: 0 }
    let count = 0
    for (let i = 0; i < 48; i++) {
      for (let j = 0; j < 48; j++) {
        const ref = localWeatherReference([(i + 0.5) / 48, (j + 0.5) / 48])
        reference.low += ref.r
        reference.mid += ref.g
        reference.high += ref.b
        count++
      }
    }
    reference.low /= count
    reference.mid /= count
    reference.high /= count

    // The high channel is deliberately NOT matched: bands are sparser than the
    // reference's everywhere-nonzero Perlin, which is the point of the pattern
    expect(Math.abs(mine.low - reference.low)).toBeLessThan(0.1)
    expect(Math.abs(mine.mid - reference.mid)).toBeLessThan(0.05)
    expect(mine.high).toBeGreaterThan(0.05)
    expect(mine.high).toBeLessThan(reference.high)

    log('default-means-vs-reference', [
      {
        field: 'low mean',
        expected: +reference.low.toFixed(3),
        actual: +mine.low.toFixed(3)
      },
      {
        field: 'mid mean',
        expected: +reference.mid.toFixed(3),
        actual: +mine.mid.toFixed(3)
      },
      {
        field: 'high mean',
        expected: '< ' + +reference.high.toFixed(3),
        actual: +mine.high.toFixed(3)
      }
    ])
  })

  test('gap clears large areas and gap 0 clears none', () => {
    const open = defaultParameters(2)
    const gapped = defaultParameters(2)
    gapped.mid.gap = 1

    const openField = field(open, c => c[1])
    const gappedField = field(gapped, c => c[1])
    const openZeros = openField.filter(v => v === 0).length
    const gappedZeros = gappedField.filter(v => v === 0).length

    // Over half the map, not a few cells: a coverage window would punch
    // cell-sized holes and leave the deck
    expect(gappedZeros / gappedField.length).toBeGreaterThan(0.5)
    expect(gappedZeros / gappedField.length).toBeGreaterThan(
      openZeros / openField.length + 0.2
    )
    log('gap-clears', [
      {
        field: 'gap 0 zero fraction',
        expected: '~0.45',
        actual: +(openZeros / openField.length).toFixed(3)
      },
      {
        field: 'gap 1 zero fraction',
        expected: '>0.5',
        actual: +(gappedZeros / gappedField.length).toFixed(3)
      }
    ])
  })

  test('more gap never adds cloud', () => {
    let previous = Infinity
    for (const gap of [0, 0.25, 0.5, 1]) {
      const parameters = defaultParameters(2)
      parameters.mid.gap = gap
      const mean = channelMeans(parameters, 32).mid
      expect(mean).toBeLessThanOrEqual(previous + 1e-9)
      previous = mean
    }
    log('gap-monotone', {
      field: 'means at gap 0/0.25/0.5/1',
      actual: 'decreasing'
    })
  })

  test("'scattered' is mostly clear and 'clumps' is not", () => {
    // The two patterns exist to be told apart at a glance in the sky: fair
    // weather puffs versus a deck
    const scattered = defaultParameters(4)
    scattered.mid.pattern = 'scattered'
    const clumps = defaultParameters(4)
    clumps.mid.pattern = 'clumps'

    const s = coverageFractions(scattered, 48).mid
    const c = coverageFractions(clumps, 48).mid

    expect(s).toBeLessThan(c * 0.8)
    log('pattern-coverage', [
      {
        field: 'scattered mid',
        expected: '<0.8 x clumps',
        actual: +s.toFixed(3)
      },
      { field: 'clumps mid', expected: '>', actual: +c.toFixed(3) }
    ])
  })

  test("'bands' counts bands across the band axis", () => {
    const one = defaultParameters(6)
    one.high.bands = 1
    const many = defaultParameters(6)
    many.high.bands = 8

    // The band axis is y for an even salt, and the high channel's salt is
    // seed * 16 + 2, so the scan runs up y and not along x
    const crossings = (parameters: TwinParameters): number => {
      let n = 0
      for (let i = 1; i < 64; i++) {
        const a = proceduralWeatherReference(
          { x: 0.5, y: (i - 0.5) / 64 },
          parameters
        )
        const b = proceduralWeatherReference(
          { x: 0.5, y: (i + 0.5) / 64 },
          parameters
        )
        if (a[2] > 0.05 !== b[2] > 0.05) n++
      }
      return n
    }

    expect(crossings(many)).toBeGreaterThan(crossings(one))
    log('band-count', [
      { field: '1 band crossings', expected: 'few', actual: crossings(one) },
      { field: '8 bands crossings', expected: 'more', actual: crossings(many) }
    ])
  })

  test("'bands' reads as filaments in lanes, not as sheets", () => {
    // The regression this guards: ridging the SUM of the octaves instead of
    // each octave, which makes `1 - |2n - 1|` near 1 everywhere and renders
    // the pattern as solid pale sheets rather than filaments
    const parameters = defaultParameters(3)
    const NX = 64
    const NY = 32
    // Sampled j-major, so index [j * NX + i] is row j. field() packs i-major,
    // which would transpose every neighbour query below
    const high: number[] = []
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        high.push(
          proceduralWeatherReference(
            { x: (i + 0.5) / NX, y: (j + 0.5) / NY },
            parameters
          )[2]
        )
      }
    }

    // Solid means the lane is filled to the top of the coverage window, which
    // is what a sheet does and a filament does not
    let solid = 0
    let covered = 0
    for (const v of high) {
      if (v > 0.02) covered++
      if (v > 0.9) solid++
    }
    const solidShare = solid / covered

    // Lanes are separated by clear map, so a lanes pattern leaves whole
    // stretches of the map empty. Sheets filled the lanes to their edges
    let lane = 0
    let laneSolid = 0
    for (let j = 0; j < NY; j++) {
      // the band axis is y, so a row runs across a lane or between lanes
      const t = (((j + 0.5) / NY) * 6) % 1
      const acrossLane = Math.abs(t * 2 - 1) < 0.2
      if (!acrossLane) continue
      for (let i = 0; i < NX; i++) {
        const v = high[j * NX + i]!
        lane++
        if (v > 0.9) laneSolid++
      }
    }

    // Anisotropy, because a filament crosses several lanes so its height does
    // not distinguish it: a covered pixel is likelier to have covered
    // neighbours left and right than up and down, and sheets score 1 on both
    const along = (dx: number, dy: number): number => {
      let same = 0
      let either = 0
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const here = high[j * NX + i]! > 0.02
          if (!here) continue
          const i1 = i + dx
          const j1 = j + dy
          const neighbour =
            i1 < 0 || i1 >= NX || j1 < 0 || j1 >= NY
              ? false
              : high[j1 * NX + i1]! > 0.02
          if (neighbour) same++
          either++
        }
      }
      return either === 0 ? 0 : same / either
    }
    const horizontal = along(1, 0)
    const vertical = along(0, 1)
    const anisotropy = horizontal / Math.max(vertical, 1e-6)

    expect(solidShare).toBeLessThan(0.6)
    expect(laneSolid / lane).toBeLessThan(0.4)
    expect(anisotropy).toBeGreaterThan(1.5)
    log('band-filaments', [
      {
        field: 'solid share of covered',
        expected: '<0.6',
        actual: +solidShare.toFixed(3)
      },
      {
        field: 'solid share inside lanes',
        expected: '<0.4',
        actual: +(laneSolid / lane).toFixed(3)
      },
      {
        field: 'neighbours along / across',
        expected: '>1.5',
        actual: +anisotropy.toFixed(2)
      }
    ])
  })

  test('the channels are decorrelated', () => {
    // Measured as correlation, not as "the samples differ": two sparse fields
    // are both zero over much of the map, which says nothing about whether one
    // is a copy of the other
    const parameters = defaultParameters(9)
    const low = field(parameters, c => c[0])
    const mid = field(parameters, c => c[1])
    const high = field(parameters, c => c[2])

    const correlation = (a: number[], b: number[]): number => {
      const mean = (v: number[]): number =>
        v.reduce((s, x) => s + x, 0) / v.length
      const ma = mean(a)
      const mb = mean(b)
      let num = 0
      let da = 0
      let db = 0
      for (let i = 0; i < a.length; i++) {
        num += (a[i]! - ma) * (b[i]! - mb)
        da += (a[i]! - ma) ** 2
        db += (b[i]! - mb) ** 2
      }
      return num / Math.sqrt(da * db)
    }

    // Not ~0: two independently seeded fields still share their marginal
    // coverage, so a thresholded pair correlates around 0.3-0.4. The bar is
    // well clear of 1, which is what a copied channel would give
    const bar = 0.45
    expect(Math.abs(correlation(low, mid))).toBeLessThan(bar)
    expect(Math.abs(correlation(mid, high))).toBeLessThan(bar)
    expect(Math.abs(correlation(low, high))).toBeLessThan(bar)
    log('channel-decorrelation', [
      {
        field: 'corr(low, mid)',
        expected: `|r|<${bar}`,
        actual: +correlation(low, mid).toFixed(3)
      },
      {
        field: 'corr(mid, high)',
        expected: `|r|<${bar}`,
        actual: +correlation(mid, high).toFixed(3)
      },
      {
        field: 'corr(low, high)',
        expected: `|r|<${bar}`,
        actual: +correlation(low, high).toFixed(3)
      }
    ])
  })

  test('a pinned field, so a silent arithmetic change cannot pass', () => {
    const parameters = defaultParameters(7)
    // Two of the four points sit inside a band lane rather than in clear map
    // Three clear-map points all read zero whatever the band field does, so a
    // pin built only from those cannot see the band field change at all
    const pinned = [
      proceduralWeatherReference({ x: 0.125, y: 0.125 }, parameters),
      proceduralWeatherReference({ x: 0.5, y: 0.5 }, parameters),
      proceduralWeatherReference({ x: 0.875, y: 0.25 }, parameters),
      proceduralWeatherReference({ x: 0.4375, y: 0.4375 }, parameters),
      proceduralWeatherReference({ x: 0.0625, y: 0.0625 }, parameters)
    ].map(c => c.map(v => +v.toFixed(6)))

    expect(pinned).toMatchInlineSnapshot(`
      [
        [
          0,
          0,
          0,
          1,
        ],
        [
          0,
          0,
          0,
          1,
        ],
        [
          0,
          0.269482,
          0,
          1,
        ],
        [
          0.776884,
          0.222526,
          0.18431,
          1,
        ],
        [
          0.445599,
          0.072409,
          0.051663,
          1,
        ],
      ]
    `)
  })
})

describe('proceduralWeather — WGSL', () => {
  setCurrentSpec('procedural-weather-wgsl')

  test('the generator compiles and carries its seed into the shader', () => {
    const fragment = buildWGSL(defaultParameters(7))

    // Salt 7 * 16 = 112. A seed that never reaches the shader means every seed
    // renders the same weather
    expect(fragment).toContain('112')
    expect(fragment.length).toBeGreaterThan(1000)
  })

  test('each pattern is a different graph', () => {
    const clumpsParameters = defaultParameters(1)
    const scatteredParameters = defaultParameters(1)
    scatteredParameters.low.pattern = 'scattered'
    const clumps = buildWGSL(clumpsParameters)
    const scattered = buildWGSL(scatteredParameters)

    // A wiring slip that picked the wrong field would compile and render
    expect(clumps).not.toBe(scattered)
    log('pattern-graph-size', [
      { field: 'clumps chars', expected: '>', actual: clumps.length },
      { field: 'scattered chars', expected: '<', actual: scattered.length }
    ])
    expect(scattered.length).toBeLessThan(clumps.length)
  })
})

describe('ProceduralWeather', () => {
  setCurrentSpec('procedural-weather-bookkeeping')

  test('defaults to the reference weather map size', () => {
    const weather = new ProceduralWeather()
    expect(weather.size).toBe(LOCAL_WEATHER_SIZE)
    expect(weather.seed).toBe(0)
    weather.dispose()
  })

  test('is opt-in: nothing constructs one by default', () => {
    // The parity harness and every existing scene load the baked PNG. A default
    // that generated weather instead would move the 63-case ladder
    expect(new CloudsContext().resolvedLocalWeatherTexture).toBeNull()
    expect(new CloudsContext().localWeatherTexture).toBeNull()
  })

  test('parameter writes are visible in the uniform and need a refill', () => {
    const weather = new ProceduralWeather({ seed: 3 })
    expect(weather.needsRender).toBe(true)
    weather.render({ compute: () => {} } as never)
    expect(weather.needsRender).toBe(false)

    weather.coverage.y = 0.9
    expect(weather.coverage.y).toBe(0.9)
    weather.update()
    expect(weather.needsRender).toBe(true)

    log('procedural-weather-uniforms', [
      { field: 'seed', expected: 3, actual: weather.seed },
      {
        field: 'coverage.mid after write',
        expected: 0.9,
        actual: weather.coverage.y
      },
      {
        field: 'needsRender after update()',
        expected: true,
        actual: weather.needsRender
      }
    ])
    weather.dispose()
  })

  test('the constructor defaults match the documented defaults', () => {
    const weather = new ProceduralWeather()
    expect(weather.scale.toArray()).toEqual([1, 1, 1, 0])
    expect(weather.coverage.toArray()).toEqual([0.8, 0.5, 0.5, 0])
    expect(weather.clumpiness.toArray()).toEqual([0.15, 0.15, 0, 0])
    expect(weather.bands.toArray()).toEqual([3, 3, 6, 0])
    expect(weather.gap.toArray()).toEqual([0, 0, 0, 0])
    weather.dispose()
  })
})
