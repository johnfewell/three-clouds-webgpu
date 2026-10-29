// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  vec3,
  vec4
} from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import {
  cpuSampleMedia,
  createSampleMedia,
  DETAIL_FADE_MIP,
  DETAIL_MEAN,
  DETAIL_POW6_MEAN,
  detailFadeStrength,
  detailLotteryWeight
} from './sampleShape'

function createPlaceholder2D() {
  const data = new Uint8Array([128, 128, 128, 255])
  const tex = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType)
  tex.minFilter = LinearMipMapLinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

function createPlaceholder3D() {
  const data = new Uint8Array([128])
  const tex = new Data3DTexture(data, 1, 1, 1)
  tex.format = RedFormat
  tex.type = UnsignedByteType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.wrapR = RepeatWrapping
  tex.needsUpdate = true
  return tex
}

function makeUniforms() {
  return {
    shapeTexture: tslTexture3D(createPlaceholder3D()),
    shapeRepeat: uniform(new Vector3(0.0003, 0.0003, 0.0003)),
    shapeOffset: uniform(new Vector3(0, 0, 0)),
    shapeAmounts: uniform(new Vector4(1, 1, 1, 1)),
    shapeDetailTexture: tslTexture3D(createPlaceholder3D()),
    shapeDetailRepeat: uniform(new Vector3(0.001, 0.001, 0.001)),
    shapeDetailOffset: uniform(new Vector3(0, 0, 0)),
    shapeDetailAmounts: uniform(new Vector4(1, 1, 1, 1)),
    turbulenceTexture: tslTexture(createPlaceholder2D()),
    turbulenceRepeat: uniform(new Vector2(20, 20)),
    turbulenceDisplacement: uniform(350),
    localWeatherRepeat: uniform(new Vector2(100, 100)),
    localWeatherOffset: uniform(new Vector2(0, 0)),
    densityScales: uniform(new Vector4(0.2, 0.2, 0.003, 0.2)),
    densityProfileExpTerms: uniform(new Vector4(0, 0, 0, 0)),
    densityProfileExponents: uniform(new Vector4(0, 0, 0, 0)),
    densityProfileLinearTerms: uniform(new Vector4(0.75, 0.75, 0.75, 0.75)),
    densityProfileConstantTerms: uniform(new Vector4(0.25, 0.25, 0.25, 0.25)),
    scatteringCoefficient: uniform(1),
    absorptionCoefficient: uniform(0)
  }
}

const DEFAULT_PROFILE_EXP: [number, number, number, number] = [0, 0, 0, 0]
const DEFAULT_PROFILE_EXPONENTS: [number, number, number, number] = [0, 0, 0, 0]
const DEFAULT_PROFILE_LINEAR: [number, number, number, number] = [
  0.75, 0.75, 0.75, 0.75
]
const DEFAULT_PROFILE_CONST: [number, number, number, number] = [
  0.25, 0.25, 0.25, 0.25
]
const DEFAULT_DENSITY_SCALES: [number, number, number, number] = [
  0.2, 0.2, 0.003, 0.2
]

function callCpu(overrides: {
  weatherDensity?: [number, number, number, number]
  weatherHeightFraction?: [number, number, number, number]
  shapeValue?: number
  shapeAmounts?: [number, number, number, number]
  densityScales?: [number, number, number, number]
  scatteringCoefficient?: number
  absorptionCoefficient?: number
  shapeDetail?: boolean
  shapeDetailFade?: boolean
  detailValue?: number
  shapeDetailAmounts?: [number, number, number, number]
  mipLevel?: number
  jitter?: number
}) {
  return cpuSampleMedia(
    overrides.weatherDensity ?? [0.8, 0.8, 0.8, 0.8],
    overrides.weatherHeightFraction ?? [0.3, 0.3, 0.3, 0.3],
    overrides.shapeValue ?? 0.5,
    overrides.shapeAmounts ?? [1, 1, 1, 1],
    overrides.densityScales ?? DEFAULT_DENSITY_SCALES,
    DEFAULT_PROFILE_EXP,
    DEFAULT_PROFILE_EXPONENTS,
    DEFAULT_PROFILE_LINEAR,
    DEFAULT_PROFILE_CONST,
    overrides.scatteringCoefficient ?? 1,
    overrides.absorptionCoefficient ?? 0,
    {
      shapeDetail: overrides.shapeDetail ?? false,
      shapeDetailFade: overrides.shapeDetailFade ?? false,
      detailValue: overrides.detailValue,
      shapeDetailAmounts: overrides.shapeDetailAmounts,
      mipLevel: overrides.mipLevel ?? 0,
      jitter: overrides.jitter ?? 0.5
    }
  )
}

describe('createSampleMedia', () => {
  it('compiles to WGSL without turbulence or detail', () => {
    const u = makeUniforms()
    const sampleMedia = createSampleMedia(
      u.shapeTexture,
      u.shapeRepeat,
      u.shapeOffset,
      u.shapeAmounts,
      u.shapeDetailTexture,
      u.shapeDetailRepeat,
      u.shapeDetailOffset,
      u.shapeDetailAmounts,
      u.turbulenceTexture,
      u.turbulenceRepeat,
      u.turbulenceDisplacement,
      u.localWeatherRepeat,
      u.localWeatherOffset,
      u.densityScales,
      u.densityProfileExpTerms,
      u.densityProfileExponents,
      u.densityProfileLinearTerms,
      u.densityProfileConstantTerms,
      false,
      false,
      false
    )
    const node = sampleMedia(
      vec4(0.8),
      vec4(0.3),
      vec3(6371000, 0, 0),
      vec2(0.5, 0.5),
      float(0),
      float(0.5)
    )
    const { fragment } = compileWGSL(node)
    expect(fragment.length).toBeGreaterThan(0)
    expectWGSL(fragment).toContain('clamp')
    expect(fragment.match(/textureSampleLevel/g)).toHaveLength(1)
    expect(fragment).not.toMatch(/textureSample\(/)
  })

  it('turbulence=false variant binds no turbulence texture', () => {
    const u = makeUniforms()
    const sampleMedia = createSampleMedia(
      u.shapeTexture,
      u.shapeRepeat,
      u.shapeOffset,
      u.shapeAmounts,
      u.shapeDetailTexture,
      u.shapeDetailRepeat,
      u.shapeDetailOffset,
      u.shapeDetailAmounts,
      u.turbulenceTexture,
      u.turbulenceRepeat,
      u.turbulenceDisplacement,
      u.localWeatherRepeat,
      u.localWeatherOffset,
      u.densityScales,
      u.densityProfileExpTerms,
      u.densityProfileExponents,
      u.densityProfileLinearTerms,
      u.densityProfileConstantTerms,
      false,
      false,
      false
    )
    const node = sampleMedia(
      vec4(0.8),
      vec4(0.3),
      vec3(6371000, 0, 0),
      vec2(0.5, 0.5),
      float(0),
      float(0.5)
    )
    const { fragment } = compileWGSL(node)
    const turbCount = (fragment.match(/turbulence/gi) ?? []).length
    expect(turbCount, 'no turbulence references when flag off').toBe(0)
    expect(fragment).not.toMatch(/textureSample\(/)
  })

  it('pins the implicit turbulence sampler exception', () => {
    const u = makeUniforms()
    const sampleMedia = createSampleMedia(
      u.shapeTexture,
      u.shapeRepeat,
      u.shapeOffset,
      u.shapeAmounts,
      u.shapeDetailTexture,
      u.shapeDetailRepeat,
      u.shapeDetailOffset,
      u.shapeDetailAmounts,
      u.turbulenceTexture,
      u.turbulenceRepeat,
      u.turbulenceDisplacement,
      u.localWeatherRepeat,
      u.localWeatherOffset,
      u.densityScales,
      u.densityProfileExpTerms,
      u.densityProfileExponents,
      u.densityProfileLinearTerms,
      u.densityProfileConstantTerms,
      true,
      true,
      false
    )
    const node = sampleMedia(
      vec4(0.8),
      vec4(0.3),
      vec3(6371000, 0, 0),
      vec2(0.5, 0.5),
      float(0),
      float(0.5)
    )
    const { fragment } = compileWGSL(node)
    expect(fragment.length).toBeGreaterThan(0)
    // ONE fetch per volume. Main reads 3 and 2: three emits no select, it emits
    // an if/else, so the detail branch rematerialised shape and turbulence on
    // its else arm, once per march iteration per texel
    expect(fragment.match(/textureSampleLevel/g)).toHaveLength(2)
    expect(fragment.match(/textureSample\(/g)).toHaveLength(1)
  })

  it('samples each volume once, not once per detail branch arm', () => {
    // clouds.glsl:135-140 samples shape ONCE, before the detail if, and the
    // branch reuses density without touching it. An unwrapped density made
    // three's if/else rematerialise the whole chain, fetches included
    const u = makeUniforms()
    const media = createSampleMedia(
      u.shapeTexture,
      u.shapeRepeat,
      u.shapeOffset,
      u.shapeAmounts,
      u.shapeDetailTexture,
      u.shapeDetailRepeat,
      u.shapeDetailOffset,
      u.shapeDetailAmounts,
      u.turbulenceTexture,
      u.turbulenceRepeat,
      u.turbulenceDisplacement,
      u.localWeatherRepeat,
      u.localWeatherOffset,
      u.densityScales,
      u.densityProfileExpTerms,
      u.densityProfileExponents,
      u.densityProfileLinearTerms,
      u.densityProfileConstantTerms,
      true,
      true,
      false
    )
    const withDetail = compileWGSL(
      media(
        vec4(0.8),
        vec4(0.3),
        vec3(6371000, 0, 0),
        vec2(0.5, 0.5),
        float(0),
        float(0.5)
      )
    ).fragment
    // One fetch call site per volume. On main this reads 5: shape twice and
    // turbulence twice, both copies inside the detail branch's else arm
    const counts = {
      'level-explicit fetches (shape + shapeDetail)': (
        withDetail.match(/textureSampleLevel/g) ?? []
      ).length,
      'implicit fetches (turbulence)': (
        withDetail.match(/textureSample\(/g) ?? []
      ).length,
      'total fetch call sites': (withDetail.match(/textureSample\w*\(/g) ?? [])
        .length
    }
    table('sampleMedia fetch counts', [
      {
        field: 'shape + shapeDetail',
        expected: 2,
        actual: counts['level-explicit fetches (shape + shapeDetail)']
      },
      {
        field: 'turbulence',
        expected: 1,
        actual: counts['implicit fetches (turbulence)']
      },
      {
        field: 'total call sites',
        expected: 3,
        actual: counts['total fetch call sites']
      }
    ])
    expect(counts['level-explicit fetches (shape + shapeDetail)']).toBe(2)
    expect(counts['implicit fetches (turbulence)']).toBe(1)
    expect(counts['total fetch call sites']).toBe(3)
  })
})

describe('createSampleMedia distant shape-detail fade', () => {
  function build(fade: boolean) {
    const u = makeUniforms()
    return createSampleMedia(
      u.shapeTexture,
      u.shapeRepeat,
      u.shapeOffset,
      u.shapeAmounts,
      u.shapeDetailTexture,
      u.shapeDetailRepeat,
      u.shapeDetailOffset,
      u.shapeDetailAmounts,
      u.turbulenceTexture,
      u.turbulenceRepeat,
      u.turbulenceDisplacement,
      u.localWeatherRepeat,
      u.localWeatherOffset,
      u.densityScales,
      u.densityProfileExpTerms,
      u.densityProfileExponents,
      u.densityProfileLinearTerms,
      u.densityProfileConstantTerms,
      true,
      true,
      fade
    )(
      vec4(0.8),
      vec4(0.3),
      vec3(6371000, 0, 0),
      vec2(0.5, 0.5),
      float(1.3),
      float(0.8)
    )
  }

  it('emits the reference lottery with the fade off and the fade with it on', () => {
    const off = compileWGSL(build(false)).fragment
    const on = compileWGSL(build(true)).fragment
    // clouds.glsl:186-190 is `mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5`,
    // and three lowers the select to an if, so match the condition not a select
    const lottery = /\* 0\.5 \) \+ \( \( .*? - 0\.5 \) \* 0\.5 \) \) < 0\.5/
    // The knee is the LEFT operand of a subtraction, so it does not collide
    // with the `(jitter - 0.5)` the lottery itself contains
    const knee = new RegExp(`\\b${DETAIL_FADE_MIP} - `)
    table('shape detail lod', [
      {
        field: 'off keeps the lottery',
        expected: true,
        actual: lottery.test(off)
      },
      {
        field: 'on drops the lottery',
        expected: false,
        actual: lottery.test(on)
      },
      { field: 'on emits the knee', expected: true, actual: knee.test(on) },
      { field: 'off emits no knee', expected: false, actual: knee.test(off) },
      { field: 'off and on differ', expected: true, actual: off !== on },
      {
        field: 'on fades toward the mean detail',
        expected: true,
        actual: on.includes(String(DETAIL_POW6_MEAN))
      }
    ])
    expect(on).toContain(String(DETAIL_POW6_MEAN))
    expect(off).not.toContain(String(DETAIL_POW6_MEAN))
    expect(off).toMatch(lottery)
    expect(on).not.toMatch(lottery)
    expect(on).toMatch(knee)
    expect(off).not.toMatch(knee)
    expect(off).not.toBe(on)
  })

  it('keeps the detail where the lottery already kept it and drops it past the fade mip', () => {
    const rows = [0, 0.1, 0.25, 0.5, 0.75, 1.5].map(mipLevel => ({
      mipLevel,
      expected: Math.max(0, Math.min(1, 1 - mipLevel / DETAIL_FADE_MIP)),
      actual: detailFadeStrength(mipLevel)
    }))
    table('detailFadeStrength', rows)
    for (const r of rows) {
      expect(r.actual, `mipLevel ${r.mipLevel}`).toBeCloseTo(r.expected, 12)
    }
    // 1 up close, 0 from DETAIL_FADE_MIP on
    expect(detailFadeStrength(0)).toBe(1)
    for (const mipLevel of [0.5, 0.75, 1.5, 6]) {
      expect(detailFadeStrength(mipLevel), `mipLevel ${mipLevel}`).toBe(0)
    }
    // the fade must bite before the lottery does, or it is not a fade at all
    expect(detailFadeStrength(0.4)).toBeLessThan(1)
  })
})

describe('cpuSampleMedia', () => {
  it('remap chain at hf=0.3, shape=0.5, detail=0.5 → positive density', () => {
    const result = callCpu({
      weatherDensity: [0.8, 0.8, 0.8, 0.8],
      weatherHeightFraction: [0.3, 0.3, 0.3, 0.3],
      shapeValue: 0.5,
      shapeDetail: true,
      detailValue: 0.5,
      shapeDetailAmounts: [1, 1, 1, 1],
      mipLevel: 0,
      jitter: 0.5
    })

    const rows = result.weight.map((w, i) => ({
      layer: i,
      expected: 0.25,
      actual: w
    }))
    table('sampleMedia-remap-chain', rows)

    expect(result.density).toBeGreaterThan(0)
    expect(result.scattering).toBeGreaterThan(0)
  })

  it('shape=0 erases density', () => {
    const result = callCpu({ shapeValue: 0.0 })
    expectClose(result.scattering, 0, { label: 'shape=0 erases density' })
  })

  it('zero weather density → zero output', () => {
    const result = callCpu({ weatherDensity: [0, 0, 0, 0] })
    expectClose(result.scattering, 0, { label: 'zero weather' })
    expectClose(result.extinction, 0, { label: 'zero weather ext' })
  })

  it('absorption adds to extinction beyond scattering', () => {
    const result = callCpu({
      scatteringCoefficient: 1,
      absorptionCoefficient: 0.5
    })
    expect(result.extinction).toBeGreaterThan(result.scattering)
    expectClose(result.extinction - result.scattering, result.density * 0.5, {
      label: 'absorption ratio',
      abs: 1e-6
    })
  })

  it('stochastic cutoff: mip=0 active, mip=1.5 inactive', () => {
    const active = callCpu({
      shapeDetail: true,
      detailValue: 0.3,
      shapeDetailAmounts: [1, 1, 1, 1],
      mipLevel: 0,
      jitter: 0.5
    })
    const cutoff = callCpu({
      shapeDetail: true,
      detailValue: 0.3,
      shapeDetailAmounts: [1, 1, 1, 1],
      mipLevel: 1.5,
      jitter: 0.5
    })

    const rows = [
      { case: 'active', expected: 0, actual: active.scattering },
      { case: 'cutoff', expected: 0, actual: cutoff.scattering }
    ]
    table('sampleMedia-stochastic-cutoff', rows)

    expect(active.scattering).not.toBeCloseTo(cutoff.scattering, 5)
  })

  // Trilinear samples of the baked detail volume, 4 per axis per texel, so the
  // statistics are the ones the shader's LinearFilter reads
  function bakedDetailSamples(stride: number): number[] {
    const n = 32
    const bytes = readFileSync(
      resolve(import.meta.dirname, '../../assets/shape_detail.bin')
    )
    expect(bytes.length).toBe(n * n * n)
    const at = (x: number, y: number, z: number) =>
      bytes[(((z + n) % n) * n + ((y + n) % n)) * n + ((x + n) % n)]! / 255
    const out: number[] = []
    for (let i = 0; i < n * n * n * 64; i += stride) {
      const sub = i % 64
      const cell = (i - sub) / 64
      const p = [
        (cell % n) + ((sub % 4) + 0.5) / 4 - 0.5,
        (Math.floor(cell / n) % n) +
          ((Math.floor(sub / 4) % 4) + 0.5) / 4 -
          0.5,
        Math.floor(cell / (n * n)) + (Math.floor(sub / 16) + 0.5) / 4 - 0.5
      ]
      const [x0, y0, z0] = p.map(Math.floor) as [number, number, number]
      const [fx, fy, fz] = [p[0]! - x0, p[1]! - y0, p[2]! - z0]
      let v = 0
      for (let c = 0; c < 8; c++) {
        const [dx, dy, dz] = [c & 1, (c >> 1) & 1, (c >> 2) & 1]
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
        v += w * at(x0 + dx, y0 + dy, z0 + dz)
      }
      out.push(v)
    }
    return out
  }

  it("the mean constants are the baked detail volume's statistics", () => {
    const samples = bakedDetailSamples(1)
    const mean = samples.reduce((a, v) => a + v, 0) / samples.length
    const pow6 = samples.reduce((a, v) => a + v ** 6, 0) / samples.length
    table('baked detail statistics', [
      { field: 'E[v]', expected: DETAIL_MEAN, actual: mean },
      { field: 'E[v^6]', expected: DETAIL_POW6_MEAN, actual: pow6 }
    ])
    expectClose(mean, DETAIL_MEAN, { label: 'E[v]', abs: 1e-4 })
    expectClose(pow6, DETAIL_POW6_MEAN, { label: 'E[v^6]', abs: 1e-4 })
  })

  // The fade must remove the per-pixel variance without thinning the cloud, so
  // its mean over the detail volume must equal the reference lottery's mean
  // over the detail volume and the jitter
  it('fade keeps the reference mean density at every distance', () => {
    const details = bakedDetailSamples(512)
    const jitters = Array.from({ length: 32 }, (_, i) => (i + 0.5) / 32)
    const cases = [
      { weather: 0.6, hf: 0.3 },
      { weather: 0.7, hf: 0.3 },
      { weather: 0.6, hf: 0.1 },
      { weather: 0.65, hf: 0.5 }
    ]
    const rows = []
    for (const { weather, hf } of cases) {
      for (const mipLevel of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.75]) {
        const sample = (fade: boolean, detailValue: number, jitter: number) =>
          callCpu({
            weatherDensity: [weather, weather, weather, weather],
            weatherHeightFraction: [hf, hf, hf, hf],
            shapeDetail: true,
            shapeDetailFade: fade,
            detailValue,
            mipLevel,
            jitter
          }).density
        let lottery = 0
        let fade = 0
        for (const d of details) {
          for (const j of jitters) lottery += sample(false, d, j)
          fade += sample(true, d, 0.5)
        }
        lottery /= details.length * jitters.length
        fade /= details.length
        const noDetail = callCpu({
          weatherDensity: [weather, weather, weather, weather],
          weatherHeightFraction: [hf, hf, hf, hf],
          mipLevel
        }).density
        rows.push({ weather, hf, mipLevel, lottery, fade, noDetail })
        expectClose(fade, lottery, {
          label: `weather ${weather} hf ${hf} mip ${mipLevel}`,
          rel: 0.01
        })
      }
    }
    table('mean density, lottery vs fade', rows)
    // The detail lifts the density well above the shape alone in this range,
    // which is why fading it to zero brightened the distant deck
    const mid = rows.find(
      r => r.weather === 0.6 && r.hf === 0.3 && r.mipLevel === 0.75
    )!
    expect(mid.lottery).toBeGreaterThan(mid.noDetail * 1.3)
  })

  it('fade output past the knee does not depend on the detail or the jitter', () => {
    for (const mipLevel of [DETAIL_FADE_MIP, 0.75, 1.2, 2]) {
      const at = (detailValue: number, jitter: number) =>
        callCpu({
          weatherDensity: [0.6, 0.6, 0.6, 0.6],
          shapeDetail: true,
          shapeDetailFade: true,
          detailValue,
          mipLevel,
          jitter
        }).density
      const ref = at(0.3, 0.1)
      for (const [d, j] of [
        [0.9, 0.1],
        [0.5, 0.9],
        [0.7, 0.4]
      ] as const) {
        expect(at(d, j), `mip ${mipLevel} detail ${d} jitter ${j}`).toBe(ref)
      }
    }
    // Up close it is the reference detail exactly
    for (const d of [0.3, 0.6, 0.9]) {
      const near = (fade: boolean) =>
        callCpu({
          weatherDensity: [0.6, 0.6, 0.6, 0.6],
          shapeDetail: true,
          shapeDetailFade: fade,
          detailValue: d,
          mipLevel: 0
        }).density
      expect(near(true), `detail ${d}`).toBe(near(false))
    }
  })

  it("detailLotteryWeight is the reference lottery's hit rate", () => {
    const jitters = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000)
    const rows = [0, 0.5, 0.75, 1, 1.25, 1.5, 2].map(mipLevel => ({
      mipLevel,
      expected:
        jitters.filter(j => mipLevel * 0.5 + (j - 0.5) * 0.5 < 0.5).length /
        jitters.length,
      actual: detailLotteryWeight(mipLevel)
    }))
    table('detailLotteryWeight', rows)
    for (const r of rows) {
      expectClose(r.actual, r.expected, {
        label: `mip ${r.mipLevel}`,
        abs: 2e-3
      })
    }
  })

  it('weights sum to 1 when density is non-zero', () => {
    const result = callCpu({
      weatherDensity: [0.9, 0.9, 0.9, 0.9],
      densityScales: [0.2, 0.2, 0.2, 0.2],
      shapeValue: 0.8
    })
    const sum =
      result.weight[0] + result.weight[1] + result.weight[2] + result.weight[3]
    expectClose(sum, 1, { label: 'weight sum', abs: 1e-6 })
  })

  it('equal weather density → equal weights', () => {
    const result = callCpu({
      weatherDensity: [0.8, 0.8, 0.8, 0.8],
      densityScales: [0.2, 0.2, 0.2, 0.2],
      shapeValue: 0.5
    })

    const rows = result.weight.map((w, i) => ({
      layer: i,
      expected: 0.25,
      actual: w
    }))
    table('sampleMedia-equal-weights', rows)

    expectClose(result.weight[0], 0.25, { label: 'w0', abs: 1e-6 })
    expectClose(result.weight[1], 0.25, { label: 'w1', abs: 1e-6 })
  })
})
