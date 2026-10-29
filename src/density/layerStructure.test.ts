// the layer set's STRUCTURE is compiled at graph time (dead lanes,
// weatherExponent === 1, expTerm === 0); magnitudes stay uniforms. These tests
// hold the specialised path to the generic one, and pin the rebuild contract

import {
  Data3DTexture,
  DataTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4
} from 'three'
import {
  float,
  texture as tslTexture,
  texture3D as tslTexture3D,
  uniform,
  vec2,
  vec3
} from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import {
  CloudLayers,
  GENERIC_LAYER_STRUCTURE,
  layerStructureKey,
  type LayerStructure
} from '../CloudLayers'
import { CloudsContext } from '../CloudsContext'
import { clouds, hashGraphFlags } from '../CloudsPassNode'
import { cpuSampleMedia, createSampleMedia } from './sampleShape'
import { cpuSampleWeather, createSampleWeather } from './sampleWeather'

type V4 = [number, number, number, number]

// CPU twins: specialised vs generic, end to end (weather -> media)

function packed(layers: CloudLayers) {
  const v = (k: Parameters<CloudLayers['packValues']>[0]) =>
    layers.packValues(k, new Vector4()).toArray()
  const p = (k: Parameters<CloudLayers['packDensityProfiles']>[0]) =>
    layers.packDensityProfiles(k, new Vector4()).toArray()
  return {
    min: v('altitude'),
    max: layers.packSums('altitude', 'height', new Vector4()).toArray(),
    exponents: v('weatherExponent'),
    biases: v('shapeAlteringBias'),
    cfw: v('coverageFilterWidth'),
    shapeAmounts: v('shapeAmount'),
    detailAmounts: v('shapeDetailAmount'),
    densityScales: v('densityScale'),
    expTerms: p('expTerm'),
    profileExponents: p('exponent'),
    linear: p('linearTerm'),
    constant: p('constantTerm')
  }
}

function chain(
  layers: CloudLayers,
  structure: LayerStructure,
  height: number,
  weather: V4,
  shape: number,
  detail: number
): number[] {
  const k = packed(layers)
  const w = cpuSampleWeather(
    height,
    k.min,
    k.max,
    weather,
    k.exponents,
    k.biases,
    0.3,
    k.cfw,
    [1, 1, 1, 1],
    false,
    structure
  )
  const m = cpuSampleMedia(
    w.density,
    w.heightFraction,
    shape,
    k.shapeAmounts,
    k.densityScales,
    k.expTerms,
    k.profileExponents,
    k.linear,
    k.constant,
    1,
    0,
    {
      shapeDetail: true,
      detailValue: detail,
      shapeDetailAmounts: k.detailAmounts,
      mipLevel: 0,
      jitter: 0.3,
      structure
    }
  )
  // Every output, lane by lane. MediaSample.density is the SUM over layers (a
  // scalar); the per-layer split is in weight. Comparing only .density[i]
  // compared undefined with undefined, caught by the red-proof
  return [...w.density, m.density, ...m.weight, m.scattering, m.extinction]
}

// Heights on a non-integer stride, so no sample lands exactly on a layer's
// altitude (where an empty lane's remap is 0/0 on the GPU)
const HEIGHTS = Array.from({ length: 1400 }, (_, i) => 3.7 + i * 7.3)
const WEATHER: V4[] = [0, 0.1, 0.37, 0.5, 0.83, 1].flatMap(a => [
  [a, a, a, a] as V4,
  [a, 1 - a, a * 0.5, 0.9] as V4
])
const SHAPES = [0, 0.2, 0.6, 1]
const DETAILS = [0, 0.4, 1]

function compare(layers: CloudLayers) {
  const structure = layers.structure
  let samples = 0
  let differing = 0
  let maxAbs = 0
  let nonzeroMedia = 0
  for (const h of HEIGHTS)
    for (const w of WEATHER)
      for (const s of SHAPES)
        for (const d of DETAILS) {
          const a = chain(layers, structure, h, w, s, d)
          const b = chain(layers, GENERIC_LAYER_STRUCTURE, h, w, s, d)
          if (a.length !== 11 || b.length !== 11)
            throw new Error('chain must return 11 outputs')
          if (a[4]! > 0) nonzeroMedia++
          for (let i = 0; i < a.length; i++) {
            samples++
            if (!Object.is(a[i], b[i])) differing++
            maxAbs = Math.max(maxAbs, Math.abs(a[i]! - b[i]!))
          }
        }
  return {
    key: layerStructureKey(structure),
    samples,
    differing,
    maxAbs,
    nonzeroMedia
  }
}

describe('CloudLayers.structure', () => {
  it('reads the DEFAULT set as three live lanes with both terms foldable', () => {
    const s = CloudLayers.DEFAULT.structure
    table('default-structure', [
      {
        field: 'active',
        expected: 'true,true,true,false',
        actual: String(s.active)
      },
      {
        field: 'weatherExponentOne',
        expected: true,
        actual: s.weatherExponentOne
      },
      { field: 'expTermZero', expected: true, actual: s.expTermZero },
      { field: 'key', expected: '1110we', actual: layerStructureKey(s) }
    ])
    expect(s).toEqual({
      active: [true, true, true, false],
      weatherExponentOne: true,
      expTermZero: true
    })
  })

  it('ignores empty lanes and tracks each flag on the live ones', () => {
    const layers = CloudLayers.DEFAULT.clone()
    // Empty lane: no effect
    layers[3]!.weatherExponent = 5
    layers[3]!.densityProfile.expTerm = 2
    const deadOnly = layerStructureKey(layers.structure)
    layers[0]!.weatherExponent = 2
    const exponent = layerStructureKey(layers.structure)
    layers[0]!.weatherExponent = 1
    layers[1]!.densityProfile.expTerm = 0.5
    const expTerm = layerStructureKey(layers.structure)
    layers[1]!.densityProfile.expTerm = 0
    // The empty lane becomes a layer, and the exponent 5 and expTerm 2 it was
    // given while empty now count
    layers[3]!.height = 300
    const fourth = layerStructureKey(layers.structure)
    table('structure-keys', [
      { field: 'dead-lane-only edits', expected: '1110we', actual: deadOnly },
      { field: 'exponent 2 on lane 0', expected: '1110-e', actual: exponent },
      { field: 'expTerm 0.5 on lane 1', expected: '1110w-', actual: expTerm },
      { field: 'lane 3 given height', expected: '1111--', actual: fourth }
    ])
    expect([deadOnly, exponent, expTerm, fourth]).toEqual([
      '1110we',
      '1110-e',
      '1110w-',
      '1111--'
    ])
  })
})

describe('specialised CPU twin equals the generic one', () => {
  // Bit-identical in double precision (pow(x, 1) = x, 0 * exp(y) = 0). On the
  // GPU pow(x, 1) is exp2(log2(x)), so the fold can move a value by about one
  // fp32 ulp, and everything else is exact
  it('the DEFAULT set: dead lane 3, exponents 1, expTerms 0', () => {
    const r = compare(CloudLayers.DEFAULT)
    table('twin-default', [
      { field: 'key', expected: '1110we', actual: r.key },
      { field: 'differing outputs', expected: 0, actual: r.differing },
      {
        field: 'nonzero media samples',
        expected: '> 1000',
        actual: r.nonzeroMedia
      },
      { field: 'max |diff|', expected: 0, actual: r.maxAbs }
    ])
    expect(r.key).toBe('1110we')
    expect(r.samples).toBeGreaterThan(100_000)
    // Positive control: the sweep must reach clouds, or equality is vacuous
    expect(r.nonzeroMedia).toBeGreaterThan(1000)
    expect(r.differing).toBe(0)
  })

  it('a four-layer set that folds every lane (no dead lane)', () => {
    const layers = CloudLayers.DEFAULT.clone()
    layers[3]!.set({
      channel: 'a',
      altitude: 9000,
      height: 400,
      densityScale: 0.1
    })
    const r = compare(layers)
    table('twin-four-lanes', [
      { field: 'key', expected: '1111we', actual: r.key },
      { field: 'differing outputs', expected: 0, actual: r.differing },
      {
        field: 'nonzero media samples',
        expected: '> 1000',
        actual: r.nonzeroMedia
      }
    ])
    expect(r.key).toBe('1111we')
    // Positive control: the sweep must reach clouds, or equality is vacuous
    expect(r.nonzeroMedia).toBeGreaterThan(1000)
    expect(r.differing).toBe(0)
  })

  it('a set that cannot be specialised stays on the generic path', () => {
    const layers = CloudLayers.DEFAULT.clone()
    layers[3]!.set({ channel: 'a', altitude: 9000, height: 400 })
    layers[0]!.weatherExponent = 2
    layers[1]!.densityProfile.set(0.4, -1.5, 0.5, 0.1)
    const s = layers.structure
    expect(s).toEqual(GENERIC_LAYER_STRUCTURE)
    const r = compare(layers)
    table('twin-generic', [
      { field: 'key', expected: '1111--', actual: r.key },
      { field: 'differing outputs', expected: 0, actual: r.differing },
      {
        field: 'nonzero media samples',
        expected: '> 1000',
        actual: r.nonzeroMedia
      }
    ])
    // Positive control: the sweep must reach clouds, or equality is vacuous
    expect(r.nonzeroMedia).toBeGreaterThan(1000)
    expect(r.differing).toBe(0)
  })
})

// WGSL: what the specialisation removes

function tex2D() {
  const t = new DataTexture(
    new Uint8Array([255, 128, 64, 32]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType
  )
  t.minFilter = LinearMipMapLinearFilter
  t.magFilter = LinearFilter
  t.wrapS = t.wrapT = RepeatWrapping
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
}
function tex3D() {
  const t = new Data3DTexture(new Uint8Array([128]), 1, 1, 1)
  t.format = RedFormat
  t.needsUpdate = true
  return t
}

function compileChain(structure: LayerStructure): string {
  const shape = tslTexture3D(tex3D())
  const detail = tslTexture3D(tex3D())
  ;(shape as unknown as { updateMatrix: boolean }).updateMatrix = false
  ;(detail as unknown as { updateMatrix: boolean }).updateMatrix = false
  const minLayerHeights = uniform(new Vector4(750, 1000, 7500, 0))
  const maxLayerHeights = uniform(new Vector4(1400, 2200, 8000, 0))
  const weather = createSampleWeather(
    tslTexture(tex2D()),
    uniform(new Vector2(100, 100)),
    uniform(new Vector2(0, 0)),
    minLayerHeights,
    maxLayerHeights,
    uniform(new Vector4(1, 1, 1, 1)),
    uniform(new Vector4(0.35, 0.35, 0.35, 0.35)),
    uniform(0.3),
    uniform(new Vector4(0.6, 0.6, 0.5, 0.6)),
    uniform(new Vector4(1, 1, 1, 1)),
    'rgba',
    false,
    structure
  )
  const media = createSampleMedia(
    shape,
    uniform(new Vector3(0.0003, 0.0003, 0.0003)),
    uniform(new Vector3(0, 0, 0)),
    uniform(new Vector4(1, 1, 0.4, 1)),
    detail,
    uniform(new Vector3(0.001, 0.001, 0.001)),
    uniform(new Vector3(0, 0, 0)),
    uniform(new Vector4(1, 1, 0, 1)),
    tslTexture(tex2D()),
    uniform(new Vector2(20, 20)),
    uniform(350),
    uniform(new Vector2(100, 100)),
    uniform(new Vector2(0, 0)),
    uniform(new Vector4(0.2, 0.2, 0.003, 0.2)),
    uniform(new Vector4(0, 0, 0, 0)),
    uniform(new Vector4(0, 0, 0, 0)),
    uniform(new Vector4(0.75, 0.75, 0.75, 0.75)),
    uniform(new Vector4(0.25, 0.25, 0.25, 0.25)),
    false,
    true,
    false,
    structure
  )
  const height = float(1800)
  const density = weather(vec2(0.5, 0.5), height, float(0))
  const out = media(
    density,
    density,
    vec3(6361800, 0, 0),
    vec2(0.5, 0.5),
    float(0),
    float(0.3)
  )
  return normalizeWGSL(compileWGSL(out).fragment)
}

describe('WGSL of the specialised layer maths', () => {
  it('drops the weather pow and the profile exp, and zeroes the dead lane', () => {
    const generic = compileChain(GENERIC_LAYER_STRUCTURE)
    const special = compileChain(CloudLayers.DEFAULT.structure)
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length
    // pow(weather, weatherExponents): a local base, a uniform exponent. The
    // shape and detail pows stay. TSL emits a pow per use of its result, so
    // this counts emissions, not calls
    const weatherPow = /\bpow\( nodeVarN, object\.nodeUniformN \)/g
    // The density profile's expTerm * exp(exponent * h) is the chain's only exp
    const profileExp = /\bexp\(/g
    const rows = {
      weatherPow: [count(generic, weatherPow), count(special, weatherPow)],
      exp: [count(generic, profileExp), count(special, profileExp)]
    }
    table('wgsl-folds', [
      {
        field: 'weather pow emissions, generic -> specialised',
        expected: '>0 -> 0',
        actual: rows.weatherPow.join(' -> ')
      },
      {
        field: 'profile exp, generic -> specialised',
        expected: '1 -> 0',
        actual: rows.exp.join(' -> ')
      }
    ])
    expect(rows.weatherPow[0]).toBeGreaterThan(0)
    expect(rows.weatherPow[1]).toBe(0)
    expect(rows.exp).toEqual([1, 0])
    // The dead lane is a literal: vec4( x, y, z, 0.0 )
    expect(special).toMatch(/vec4<f32>\( [^;]*, 0\.0 \)/)
  })

  it('a structure with nothing to fold compiles exactly as the generic path', () => {
    expect(
      compileChain({
        active: [true, true, true, true],
        weatherExponentOne: false,
        expTermZero: false
      })
    ).toBe(compileChain(GENERIC_LAYER_STRUCTURE))
  })
})

// Bookkeeping: structure rebuilds, magnitudes do not

describe('layer structure rebuild contract', () => {
  it('bumps graphVersion and the cache key on a structure change only', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion
    const key0 = hashGraphFlags(true, false, ctx.graphFlags())
    // Untouched context: no change
    const first = ctx.checkLayerStructure()
    // Magnitude
    ctx.cloudLayers[0]!.densityScale = 0.5
    ctx.cloudLayers[2]!.altitude = 7000
    const magnitude = ctx.checkLayerStructure()
    const v1 = ctx.graphVersion
    // Structure
    ctx.cloudLayers[0]!.weatherExponent = 2
    const structural = ctx.checkLayerStructure()
    const v2 = ctx.graphVersion
    const key2 = hashGraphFlags(true, false, ctx.graphFlags())
    // Back to the folded shape
    ctx.cloudLayers[0]!.weatherExponent = 1
    const back = ctx.checkLayerStructure()
    table('rebuild-contract', [
      { field: 'first poll changes', expected: false, actual: first },
      { field: 'magnitude edit changes', expected: false, actual: magnitude },
      { field: 'graphVersion after magnitude', expected: v0, actual: v1 },
      { field: 'exponent edit changes', expected: true, actual: structural },
      { field: 'graphVersion after exponent', expected: v0 + 1, actual: v2 },
      { field: 'cache key moved', expected: true, actual: key2 !== key0 },
      { field: 'revert changes', expected: true, actual: back }
    ])
    expect([first, magnitude, structural, back]).toEqual([
      false,
      false,
      true,
      true
    ])
    expect(v1).toBe(v0)
    expect(v2).toBe(v0 + 1)
    expect(key2).not.toBe(key0)
  })

  it('moves the pass cache key when a layer leaves the default structure', () => {
    const pass = clouds({ sceneDepth: null })
    const before = pass.customCacheKey()
    pass.cloudsContext.cloudLayers[1]!.densityProfile.expTerm = 0.3
    const after = pass.customCacheKey()
    pass.cloudsContext.cloudLayers[1]!.densityProfile.expTerm = 0
    const restored = pass.customCacheKey()
    table('pass-cache-key', [
      {
        field: 'expTerm 0.3 moves the key',
        expected: true,
        actual: after !== before
      },
      {
        field: 'reverting restores it',
        expected: true,
        actual: restored === before
      }
    ])
    expect(after).not.toBe(before)
    expect(restored).toBe(before)
  })
})
