// Cloud-type presets: what they are allowed to write, and that applying one
// reaches the shader. The off-proof that nothing here moves the default
// render lives in defaultOutputDigest.test.ts

import { Vector4 } from 'three'
import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import {
  defaultChainDigest,
  layerUniformStateDigest
} from '../../test/helpers/defaultChainDigest'
import { log } from '../../test/helpers/log'
import { CloudLayer, type CloudLayerLike } from '../CloudLayer'
import { CloudLayers } from '../CloudLayers'
import { CloudsContext } from '../CloudsContext'
import { getLayerDensityCPU } from '../density/layerDensity'
import { DensityProfile, type DensityProfileLike } from '../DensityProfile'
import { createLayerUniforms, updateLayerUniforms } from '../layerUniforms'
import {
  applyCloudTypePreset,
  cloudTypePresetNames,
  cloudTypePresets,
  cloudTypeProfileAt,
  isCloudTypePresetName,
  type CloudTypePreset,
  type CloudTypePresetTarget
} from './cloudTypePresets'

// The permitted surface, derived from the classes rather than restated here,
// so a new CloudLayer field is permitted by construction and a typo is not
const LAYER_KEYS = Object.keys(new CloudLayer())
const PROFILE_KEYS = Object.keys(new DensityProfile())
const CHANNELS = ['r', 'g', 'b', 'a']

// The height above which this renderer stops being a cloud simulation
const SKY_CEILING = 25e3

function activeLanes(preset: CloudTypePreset) {
  return preset.layers.filter(layer => (layer.height ?? 0) > 0)
}

function laneKeys(layer: CloudLayerLike): string[] {
  return Object.keys(layer)
}

function describePreset(name: string, preset: CloudTypePreset) {
  return [
    {
      field: `${name}: coverage`,
      expected: '0..1',
      actual: String(preset.coverage)
    },
    {
      field: `${name}: channels`,
      expected: CHANNELS.join(''),
      actual: preset.layers.map(l => l.channel ?? '?').join('')
    },
    {
      field: `${name}: active lanes`,
      expected: '>=1',
      actual: String(activeLanes(preset).length)
    }
  ]
}

// The shipped CPU twin of the shader's profile expression, on a lane
const profileAt = (layer: CloudLayerLike, h: number): number =>
  cloudTypeProfileAt(layer.densityProfile ?? {}, h)

describe('cloud type presets', () => {
  it('writes only fields that already exist on a CloudLayer', () => {
    const rows: Array<Record<string, unknown>> = []
    for (const name of cloudTypePresetNames) {
      const preset = cloudTypePresets[name]
      const unknownKeys = preset.layers.flatMap(layer =>
        laneKeys(layer).filter(key => !LAYER_KEYS.includes(key))
      )
      const profileKeys = preset.layers.flatMap(layer =>
        Object.keys(layer.densityProfile ?? {}).filter(
          key => !PROFILE_KEYS.includes(key)
        )
      )
      expect(unknownKeys, `${name} unknown layer keys`).toEqual([])
      expect(profileKeys, `${name} unknown profile keys`).toEqual([])
      rows.push({
        field: name,
        expected: '0 unknown keys',
        actual: `${unknownKeys.length + profileKeys.length} of ${
          preset.layers.length * LAYER_KEYS.length
        } slots`
      })
    }
    table('preset-fields', rows)
    log('preset-fields', {
      presets: cloudTypePresetNames.length,
      layerKeys: LAYER_KEYS.length,
      profileKeys: PROFILE_KEYS.length
    })
  })

  it('keeps four distinct channels, live lanes inside the sky, and coverage in range', () => {
    const rows: Array<Record<string, unknown>> = []
    for (const name of cloudTypePresetNames) {
      const preset = cloudTypePresets[name]
      rows.push(...describePreset(name, preset))
      expect(preset.coverage).toBeGreaterThan(0)
      expect(preset.coverage).toBeLessThanOrEqual(1)
      expect(preset.layers.map(layer => layer.channel)).toEqual(CHANNELS)
      expect(activeLanes(preset).length).toBeGreaterThan(0)
      for (const layer of preset.layers) {
        const height = layer.height ?? 0
        const altitude = layer.altitude ?? 0
        expect(altitude).toBeGreaterThanOrEqual(0)
        if (height > 0) {
          expect(altitude + height).toBeLessThanOrEqual(SKY_CEILING)
          expect(layer.densityScale ?? 0).toBeGreaterThan(0)
        } else {
          // An empty lane is spelled height 0, the shape CloudLayers.structure
          // compiles out. Anything else would spend a live lane on nothing
          expect(height).toBe(0)
        }
      }
      // Active lanes ascend: the shader walks the layer intervals in that order
      const tops = activeLanes(preset).map(
        layer => (layer.altitude ?? 0) + (layer.height ?? 0)
      )
      for (let i = 1; i < tops.length; ++i) {
        expect(tops[i]!).toBeGreaterThan(tops[i - 1]!)
      }
    }
    table('preset-shape', rows)
  })

  it('is six distinct skies, not six names for one', () => {
    const seen = new Map<string, string>()
    for (const name of cloudTypePresetNames) {
      const preset = cloudTypePresets[name]
      const key = JSON.stringify([preset.coverage, preset.layers])
      const other = seen.get(key)
      expect(other, `${name} duplicates ${other}`).toBeUndefined()
      seen.set(key, name)
    }
    log('preset-distinct', { count: seen.size })
    expect(seen.size).toBe(cloudTypePresetNames.length)
  })

  // The intent each preset exists for. A preset that stops reading as its
  // named cloud type fails here, not in a screenshot nobody diffs
  it('fairWeatherCumulus is scattered, low and rising', () => {
    const preset = cloudTypePresets.fairWeatherCumulus
    const [lane] = activeLanes(preset)
    table('fairWeatherCumulus', [
      { field: 'coverage', expected: '<0.4', actual: preset.coverage },
      { field: 'altitude', expected: '1..2 km', actual: lane!.altitude ?? 0 },
      {
        field: 'profile at h=0',
        expected: '<h=1',
        actual: profileAt(lane!, 0)
      },
      {
        field: 'profile at h=1',
        expected: '>h=0',
        actual: profileAt(lane!, 1)
      },
      { field: 'shadow', expected: true, actual: lane!.shadow ?? false }
    ])
    expect(preset.coverage).toBeLessThan(0.4)
    expect(lane!.altitude).toBeGreaterThan(1000)
    expect(lane!.altitude).toBeLessThan(2000)
    expect(profileAt(lane!, 1)).toBeGreaterThan(profileAt(lane!, 0))
    expect(lane!.shadow).toBe(true)
  })

  it('stratocumulusDeck is a wider, lumpier, flatter deck than cumulus', () => {
    const deck = cloudTypePresets.stratocumulusDeck
    const cumulus = cloudTypePresets.fairWeatherCumulus
    const [deckLane] = activeLanes(deck)
    const [cumulusLane] = activeLanes(cumulus)
    table('stratocumulusDeck', [
      { field: 'coverage vs cumulus', expected: '>', actual: deck.coverage },
      {
        field: 'weatherExponent vs cumulus',
        expected: '>',
        actual:
          (deckLane!.weatherExponent ?? 0) - (cumulusLane!.weatherExponent ?? 0)
      },
      {
        field: 'altitude vs cumulus (m)',
        expected: '<',
        actual: (deckLane!.altitude ?? 0) - (cumulusLane!.altitude ?? 0)
      }
    ])
    expect(deck.coverage).toBeGreaterThan(cumulus.coverage)
    expect(deckLane!.weatherExponent).toBeGreaterThan(
      cumulusLane!.weatherExponent ?? 0
    )
    expect(deckLane!.altitude).toBeLessThan(cumulusLane!.altitude ?? 0)
  })

  it('overcastSheet is continuous, high and thin enough to pass the sun', () => {
    const preset = cloudTypePresets.overcastSheet
    const [lane] = activeLanes(preset)
    table('overcastSheet', [
      { field: 'coverage', expected: '>0.85', actual: preset.coverage },
      { field: 'altitude', expected: '>3 km', actual: lane!.altitude ?? 0 },
      {
        field: 'densityScale',
        expected: '<0.15',
        actual: lane!.densityScale ?? 0
      },
      {
        field: 'profile at h=1 vs h=0',
        expected: '~flat',
        actual: profileAt(lane!, 1) - profileAt(lane!, 0)
      }
    ])
    expect(preset.coverage).toBeGreaterThan(0.85)
    expect(lane!.altitude).toBeGreaterThan(3000)
    expect(lane!.densityScale).toBeLessThan(0.15)
    expect(Math.abs(profileAt(lane!, 1) - profileAt(lane!, 0))).toBeLessThan(
      0.5
    )
  })

  it('highCirrus is the highest, thinnest and patchiest of the six, and casts no shadow', () => {
    const preset = cloudTypePresets.highCirrus
    const [lane] = activeLanes(preset)
    const [deck] = activeLanes(cloudTypePresets.stratocumulusDeck)
    const tops = cloudTypePresetNames.map(name => {
      const top = activeLanes(cloudTypePresets[name])[0]
      return (top?.altitude ?? 0) + (top?.height ?? 0)
    })
    table('highCirrus', [
      {
        field: 'lane top, the highest of the six',
        expected: 'max',
        actual: (lane!.altitude ?? 0) + (lane!.height ?? 0)
      },
      {
        field: 'densityScale, relative to the deck',
        expected: '< a tenth',
        actual: (lane!.densityScale ?? 0) / (deck!.densityScale ?? 1)
      },
      {
        field: 'coverageFilterWidth, patchy',
        expected: '<0.5',
        actual: lane!.coverageFilterWidth ?? 0
      },
      {
        field: 'coverage, as a fraction of the overcast sheet',
        expected: '<1, so gaps the sheet does not have',
        actual: preset.coverage / cloudTypePresets.overcastSheet.coverage
      },
      { field: 'shadow', expected: false, actual: lane!.shadow ?? false }
    ])
    expect((lane!.altitude ?? 0) + (lane!.height ?? 0)).toBe(Math.max(...tops))
    expect(lane!.densityScale).toBeLessThan((deck!.densityScale ?? 1) / 10)
    // Patchy where the overcast sheet is continuous: the same soft filter that
    // makes the sheet read as one deck would make this a bright wash
    expect(lane!.coverageFilterWidth).toBeLessThan(0.5)
    expect(preset.coverage).toBeLessThan(
      cloudTypePresets.overcastSheet.coverage
    )
    expect(lane!.shadow).toBe(false)
  })

  it('groundFog hugs the surface and is thick enough to resolve', () => {
    const preset = cloudTypePresets.groundFog
    const [lane] = activeLanes(preset)
    // The floor is the render, not taste: at the story's -9 degree view a
    // 90 m layer is thinner than one march step (277-t05-groundFog). The
    // ceiling is taste: past about 800 m this stops being a fog bank
    table('groundFog', [
      { field: 'altitude', expected: '<100 m', actual: lane!.altitude ?? 0 },
      {
        field: 'height',
        expected: '400..800 m, resolvable at a grazing view',
        actual: lane!.height ?? 0
      },
      {
        field: 'profile at h=1 vs h=0',
        expected: '<',
        actual: profileAt(lane!, 1) - profileAt(lane!, 0)
      },
      { field: 'shadow', expected: false, actual: lane!.shadow ?? false }
    ])
    expect(lane!.altitude).toBeLessThan(100)
    expect(lane!.height).toBeGreaterThanOrEqual(400)
    expect(lane!.height).toBeLessThanOrEqual(800)
    expect(profileAt(lane!, 1)).toBeLessThan(profileAt(lane!, 0))
    expect(lane!.shadow).toBe(false)
  })

  it('mixedSky stacks three live lanes on the three weather channels', () => {
    const preset = cloudTypePresets.mixedSky
    const lanes = activeLanes(preset)
    table('mixedSky', [
      { field: 'active lanes', expected: 3, actual: lanes.length },
      {
        field: 'channels',
        expected: 'rgb',
        actual: lanes.map(l => l.channel).join('')
      },
      {
        field: 'altitudes (m)',
        expected: 'ascending',
        actual: lanes.map(l => l.altitude ?? 0).join(' < ')
      },
      {
        field: 'shadow casters',
        expected: 2,
        actual: lanes.filter(l => l.shadow).length
      }
    ])
    expect(lanes.length).toBe(3)
    expect(lanes.map(l => l.channel)).toEqual(['r', 'g', 'b'])
    expect(lanes[1]!.altitude).toBeGreaterThan(lanes[0]!.altitude ?? 0)
    expect(lanes[2]!.altitude).toBeGreaterThan(lanes[1]!.altitude ?? 0)
    // The cirrus lane is the one that must not shadow
    expect(lanes[2]!.shadow).toBe(false)
  })
})

it('cloudTypeProfileAt IS getLayerDensityCPU, so the twin cannot drift', () => {
  // Every "is rising / is a slab" assertion here is reasoned about in prose, so
  // a twin that stops twinning makes those comments wrong silently: doubling
  // the real evaluator's linear term left all 18 tests green
  const profiles: DensityProfileLike[] = [
    { expTerm: 0, exponent: 0, linearTerm: 0, constantTerm: 0 },
    { expTerm: 1, exponent: -3, linearTerm: 0, constantTerm: 0.1 },
    { expTerm: 1, exponent: 3, linearTerm: 0.5, constantTerm: 0 },
    { expTerm: 0.5, exponent: 1.5, linearTerm: -0.25, constantTerm: 0.75 }
  ]
  for (const preset of Object.values(cloudTypePresets)) {
    for (const lane of activeLanes(preset)) {
      profiles.push(lane.densityProfile ?? {})
    }
  }
  let worst = 0
  let worstAt = ''
  for (const profile of profiles) {
    for (let step = 0; step <= 20; step++) {
      const h = step / 20
      const twin = cloudTypeProfileAt(profile, h)
      const real = getLayerDensityCPU(
        h,
        profile.expTerm ?? 0,
        profile.exponent ?? 0,
        profile.linearTerm ?? 0,
        profile.constantTerm ?? 0
      )
      const delta = Math.abs(twin - real)
      if (delta > worst) {
        worst = delta
        worstAt = `h=${h} twin=${twin} real=${real}`
      }
    }
  }
  table('profile-twin-vs-evaluator', [
    { profiles: profiles.length, gridPoints: profiles.length * 21 },
    { worstAbsDelta: worst, worstAt }
  ])
  expect(worst).toBe(0)
})

describe('applyCloudTypePreset', () => {
  function stub(): CloudTypePresetTarget & { coverage: number } {
    return { cloudLayers: CloudLayers.DEFAULT.clone(), coverage: 0.3 }
  }

  it('writes coverage and all four lanes, and returns the preset', () => {
    for (const name of cloudTypePresetNames) {
      const target = stub()
      const returned = applyCloudTypePreset(target, name)
      const preset = cloudTypePresets[name]
      expect(returned).toBe(preset)
      expect(target.coverage).toBe(preset.coverage)
      // The whole lane set, field for field, against a set built the same way
      expect(JSON.stringify(target.cloudLayers)).toBe(
        JSON.stringify(new CloudLayers(preset.layers))
      )
      expect(target.cloudLayers.localWeatherChannels).toBe('rgba')
    }
    log('apply', { presets: cloudTypePresetNames.length })
  })

  it('leaves the table and the defaults untouched, and is idempotent', () => {
    const before = JSON.stringify(cloudTypePresets)
    const defaults = JSON.stringify(CloudLayers.DEFAULT)
    const first = stub()
    applyCloudTypePreset(first, 'mixedSky')
    const second = stub()
    applyCloudTypePreset(second, 'mixedSky')
    const third = stub()
    applyCloudTypePreset(third, 'fairWeatherCumulus')
    applyCloudTypePreset(third, 'mixedSky')
    table('apply-purity', [
      {
        field: 'preset table unchanged',
        expected: true,
        actual: JSON.stringify(cloudTypePresets) === before
      },
      {
        field: 'CloudLayers.DEFAULT unchanged',
        expected: true,
        actual: JSON.stringify(CloudLayers.DEFAULT) === defaults
      },
      {
        field: 'same preset twice is idempotent',
        expected: true,
        actual:
          JSON.stringify(first.cloudLayers) ===
          JSON.stringify(second.cloudLayers)
      },
      {
        field: 're-applying wins over an earlier preset',
        expected: true,
        actual:
          JSON.stringify(first.cloudLayers) ===
          JSON.stringify(third.cloudLayers)
      }
    ])
    expect(JSON.stringify(cloudTypePresets)).toBe(before)
    expect(JSON.stringify(CloudLayers.DEFAULT)).toBe(defaults)
    expect(JSON.stringify(first.cloudLayers)).toBe(
      JSON.stringify(third.cloudLayers)
    )
  })

  it('refuses an unknown name and rejects prototype keys', () => {
    const target = stub()
    expect(() => applyCloudTypePreset(target, 'nimbus' as never)).toThrow(
      RangeError
    )
    expect(isCloudTypePresetName('groundFog')).toBe(true)
    for (const junk of [
      'constructor',
      '__proto__',
      'toString',
      '',
      0,
      null,
      undefined,
      {},
      ['groundFog']
    ]) {
      expect(isCloudTypePresetName(junk)).toBe(false)
    }
    expect(target.coverage).toBe(0.3)
    log('apply-guard', { rejected: 9 })
  })

  it('reaches the layer uniforms the shader reads', () => {
    const ctx = new CloudsContext()
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)
    const before = {
      min: u.minLayerHeights.value.clone(),
      density: u.densityScales.value.clone()
    }
    applyCloudTypePreset(ctx, 'fairWeatherCumulus')
    updateLayerUniforms(u, ctx)
    const preset = cloudTypePresets.fairWeatherCumulus
    table('preset-uniforms', [
      {
        field: 'minLayerHeights.x before -> after',
        expected: `${before.min.x} -> ${preset.layers[0].altitude}`,
        actual: `${before.min.x} -> ${u.minLayerHeights.value.x}`
      },
      {
        field: 'densityScales.x after',
        expected: preset.layers[0].densityScale,
        actual: u.densityScales.value.x
      },
      {
        field: 'inactive lane 1 min height',
        expected: 0,
        actual: u.minLayerHeights.value.y
      }
    ])
    expect(u.minLayerHeights.value.x).toBe(preset.layers[0].altitude)
    expect(u.densityScales.value.x).toBe(preset.layers[0].densityScale)
    // Lane 1 is the first inactive lane: a preset resets the lanes, so it holds
    // CloudLayer.DEFAULT's 0, not the default set's 1000
    expect(u.minLayerHeights.value.y).toBe(0)
  })

  it('reports the graph-time changes the context polls for', () => {
    const ctx = new CloudsContext()
    applyCloudTypePreset(ctx, 'fairWeatherCumulus')
    // Three live lanes become one, so the compiled shape must change
    expect(ctx.checkLayerStructure()).toBe(true)
    // The default set casts shadows and so does this one
    expect(ctx.checkShadowStructure()).toBe(false)
    const noShadow = new CloudsContext()
    applyCloudTypePreset(noShadow, 'groundFog')
    expect(noShadow.checkShadowStructure()).toBe(true)
    // A preset that leaves the shape as the default set reports no change
    const unchanged = new CloudsContext()
    expect(unchanged.checkLayerStructure()).toBe(false)
    expect(unchanged.checkShadowStructure()).toBe(false)
    log('preset-graph-flags', {
      coverage: ctx.coverage,
      structureKey: ctx.cloudLayers.structure.active.join('')
    })
  })

  it('packs an ascending interval order for a three-lane preset', () => {
    const ctx = new CloudsContext()
    applyCloudTypePreset(ctx, 'mixedSky')
    const u = createLayerUniforms()
    updateLayerUniforms(u, ctx)
    const min = new Vector4().copy(u.minLayerHeights.value)
    const max = new Vector4().copy(u.maxLayerHeights.value)
    table('mixedSky-intervals', [
      {
        field: 'lane bottoms (m)',
        expected: 'ascending',
        actual: min.toArray().join(' < ')
      },
      {
        field: 'lane tops (m)',
        expected: 'ascending',
        actual: max.toArray().join(' < ')
      }
    ])
    // The three live lanes ascend, and the fourth is the empty lane
    expect(min.x).toBeLessThan(min.y)
    expect(min.y).toBeLessThan(min.z)
    expect(min.w).toBe(0)
    expect(max.x).toBeGreaterThan(min.x)
    expect(max.w).toBe(0)
  })

  // The empty-space skip records three inter-band gaps at most, one per slot
  // in minIntervalHeights / maxIntervalHeights (CloudLayers.packIntervalHeights)
  it('needs no more empty-space gaps than the packer records', () => {
    const rows: Array<Record<string, unknown>> = []
    for (const name of cloudTypePresetNames) {
      const ctx = new CloudsContext()
      applyCloudTypePreset(ctx, name)
      const u = createLayerUniforms()
      updateLayerUniforms(u, ctx)
      const packed: Array<[number, number]> = (
        [
          [u.minIntervalHeights.value.x, u.maxIntervalHeights.value.x],
          [u.minIntervalHeights.value.y, u.maxIntervalHeights.value.y],
          [u.minIntervalHeights.value.z, u.maxIntervalHeights.value.z]
        ] as Array<[number, number]>
      ).filter(([min, max]) => max > min)
      // Bands of the live lanes, merged where they touch
      const bands: Array<[number, number]> = activeLanes(
        cloudTypePresets[name]
      ).map(layer => [
        layer.altitude ?? 0,
        (layer.altitude ?? 0) + (layer.height ?? 0)
      ])
      bands.sort((a, b) => a[0] - b[0])
      const merged: Array<[number, number]> = []
      for (const [lo, hi] of bands) {
        const last = merged.at(-1)
        if (last != null && lo <= last[1]) last[1] = Math.max(last[1], hi)
        else merged.push([lo, hi])
      }
      // One gap per merged band: the climb from the ground to the lowest band
      // (the one the design doc calls the below-deck gap) plus one per interior
      // split. The topmost gap is outside the shell and never packed
      const needed = merged.length
      rows.push({
        field: name,
        expected: `${needed} gaps recorded`,
        actual: `${packed.length} of ${needed} needed`
      })
      expect(packed.length, `${name} recorded gaps`).toBe(needed)
      // And the slots themselves, so a future fourth gap is loud
      expect(needed).toBeLessThanOrEqual(3)
    }
    table('preset-gaps', rows)
  })

  // The ON half of the design doc section 7 recipe, the OFF half being pinned
  // against main in defaultOutputDigest.test.ts. Without this half a preset
  // that never reached the shader would still pass the off proof
  it('reaches the shader: every preset moves the uniform state, and some move the graph', () => {
    const offContext = new CloudsContext()
    const offGraph = defaultChainDigest(offContext)
    const offUniforms = layerUniformStateDigest(offContext)
    const rows: Array<Record<string, unknown>> = []
    let compiledMoves = 0
    for (const name of cloudTypePresetNames) {
      const ctx = new CloudsContext()
      applyCloudTypePreset(ctx, name)
      const graph = defaultChainDigest(ctx)
      const uniforms = layerUniformStateDigest(ctx)
      if (graph !== offGraph) ++compiledMoves
      rows.push({
        field: name,
        expected: 'uniforms differ from off',
        actual:
          uniforms === offUniforms
            ? 'IDENTICAL, the preset is inert'
            : graph === offGraph
              ? 'uniforms only, graph unchanged'
              : 'uniforms and graph'
      })
      expect(uniforms, `${name} reaches the uniforms`).not.toBe(offUniforms)
    }
    table('preset-reaches-shader', rows)
    // Three lanes live and three are empty, so the structure literals move for
    // at least the single-lane presets
    expect(compiledMoves).toBeGreaterThan(0)
    log('preset-reaches-shader', {
      off: offGraph.slice(0, 12),
      compiledMoves,
      total: cloudTypePresetNames.length
    })
  })

  it('keeps a multi-lane preset height-overlapping', () => {
    // docs/design/cloud-types.md 2.2: overlapping bands cost nothing, disjoint
    // ones lose the below-deck gap and every upward ray pays for it
    const lanes = activeLanes(cloudTypePresets.mixedSky)
    const cumulusTop = (lanes[0]!.altitude ?? 0) + (lanes[0]!.height ?? 0)
    const deckBottom = lanes[1]!.altitude ?? 0
    table('mixedSky-overlap', [
      {
        field: 'cumulus top vs deck bottom (m)',
        expected: 'deck starts below the cumulus top',
        actual: `${cumulusTop} vs ${deckBottom}`
      },
      {
        field: 'overlap (m)',
        expected: '>0',
        actual: cumulusTop - deckBottom
      }
    ])
    expect(deckBottom).toBeLessThan(cumulusTop)
  })
})
