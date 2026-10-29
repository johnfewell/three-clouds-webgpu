// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  DataTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector4
} from 'three'
import { float, texture as tslTexture, uniform, vec2 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import { cpuSampleWeather, createSampleWeather } from './sampleWeather'

function createPlaceholder2D() {
  const data = new Uint8Array([255, 128, 64, 32])
  const tex = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType)
  tex.minFilter = LinearMipMapLinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

function makeUniforms() {
  const tex = createPlaceholder2D()
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

describe('createSampleWeather', () => {
  it('compiles to WGSL with textureSampleLevel and swizzle', () => {
    const u = makeUniforms()
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
      false
    )
    const node = sampleWeather(vec2(0.5, 0.5), float(1000), float(0))
    const { fragment } = compileWGSL(node)
    expectWGSL(fragment).toContain('textureSampleLevel')
    expect(fragment.length).toBeGreaterThan(0)
  })

  it('compiles to WGSL in shadow mode', () => {
    const u = makeUniforms()
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
      true
    )
    const node = sampleWeather(vec2(0.5, 0.5), float(1000), float(0))
    const { fragment } = compileWGSL(node)
    expectWGSL(fragment).toContain('textureSampleLevel')
  })
})

describe('cpuSampleWeather', () => {
  it('CloudLayers.DEFAULT layer 0: height 1000m → heightFraction ≈ 0.385', () => {
    const result = cpuSampleWeather(
      1000,
      [750, 1500, 3000, 5000],
      [1400, 2200, 4000, 6000],
      [0.8, 0.5, 0.5, 0.5],
      [1, 1, 1, 1],
      [0.35, 0.35, 0.35, 0.35],
      0.3,
      [0.6, 0.6, 0.6, 0.5],
      [1, 1, 1, 1],
      false
    )

    const rows = result.heightFraction.map((hf, i) => ({
      layer: i,
      expected: i === 0 ? 0.385 : 0,
      actual: hf
    }))
    table('heightFraction-default', rows)

    expectClose(result.heightFraction[0], 0.3846, {
      abs: 0.01,
      label: 'layer0 hf'
    })
    expect(result.heightFraction[1]).toBe(0)
    expect(result.heightFraction[2]).toBe(0)
    expect(result.heightFraction[3]).toBe(0)
  })

  it('height below all layers → heightFraction all zero', () => {
    const result = cpuSampleWeather(
      0,
      [750, 1500, 3000, 5000],
      [1400, 2200, 4000, 6000],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [0.35, 0.35, 0.35, 0.35],
      0.3,
      [0.6, 0.6, 0.6, 0.5],
      [1, 1, 1, 1],
      false
    )

    for (let i = 0; i < 4; i++) {
      expect(result.heightFraction[i], `layer ${i}`).toBe(0)
    }
  })

  it('height above layer 0 → heightFraction[0] = 1', () => {
    const result = cpuSampleWeather(
      2000,
      [750, 1500, 3000, 5000],
      [1400, 2200, 4000, 6000],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [0.35, 0.35, 0.35, 0.35],
      0.3,
      [0.6, 0.6, 0.6, 0.5],
      [1, 1, 1, 1],
      false
    )

    expect(result.heightFraction[0]).toBe(1)
    expectClose(result.heightFraction[1], 0.714, {
      abs: 0.01,
      label: 'layer1 hf'
    })
  })

  it('density values are in [0,1]', () => {
    const result = cpuSampleWeather(
      1000,
      [750, 1500, 3000, 5000],
      [1400, 2200, 4000, 6000],
      [0.8, 0.5, 0.5, 0.5],
      [1, 1, 1, 1],
      [0.35, 0.35, 0.35, 0.35],
      0.3,
      [0.6, 0.6, 0.6, 0.5],
      [1, 1, 1, 1],
      false
    )

    const rows = result.density.map((d, i) => ({
      layer: i,
      expected: 0,
      actual: d
    }))
    table('density-default', rows)

    for (let i = 0; i < 4; i++) {
      expect(result.density[i], `layer ${i}`).toBeGreaterThanOrEqual(0)
      expect(result.density[i], `layer ${i}`).toBeLessThanOrEqual(1)
    }
  })

  it('shadow mode zeroes masked layers', () => {
    const result = cpuSampleWeather(
      1000,
      [750, 1500, 3000, 5000],
      [1400, 2200, 4000, 6000],
      [0.8, 0.5, 0.5, 0.5],
      [1, 1, 1, 1],
      [0.35, 0.35, 0.35, 0.35],
      0.3,
      [0.6, 0.6, 0.6, 0.5],
      [1, 0, 0, 0],
      true
    )

    const noShadow = cpuSampleWeather(
      1000,
      [750, 1500, 3000, 5000],
      [1400, 2200, 4000, 6000],
      [0.8, 0.5, 0.5, 0.5],
      [1, 1, 1, 1],
      [0.35, 0.35, 0.35, 0.35],
      0.3,
      [0.6, 0.6, 0.6, 0.5],
      [1, 1, 1, 1],
      false
    )

    expect(result.density[0]).toBe(noShadow.density[0])
  })
})
