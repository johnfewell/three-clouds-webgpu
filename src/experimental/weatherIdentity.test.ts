import { createHash } from 'node:crypto'
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
import { describe, expect, test } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { createSampleWeather } from '../density/sampleWeather'
import { localWeather } from '../textures/localWeather'
import { ProceduralWeather } from './proceduralWeather'

// The byte-identical-off proof, in the shape docs/design/cloud-types.md §7 gives
// every sibling: same recipe, comparable literals. normalizeWGSL replaces
// three's nodeVar3 counters, so a node added elsewhere does not move them

const MAIN_COMMIT = '95b7c5df'

const digest = (wgsl: string): string =>
  createHash('sha256').update(normalizeWGSL(wgsl)).digest('hex')

// The generator and the march's consumer of it: two graphs this feature could
// have perturbed and did not

// Measured on 0.185.1 AND re-measured on stock 0.184.0: normalizeWGSL drops
// three's revision banner, so one graph has one digest across the peer range
const MAIN = {
  localWeatherGenerator:
    'e57e7af5c911bf386e4b9c1b171b030792904649dd376d0ad5277283ea326ae2',
  localWeatherGeneratorChars: 432206,
  weatherSample:
    '7cc332f4976a529444b7f79519a7c84fc8f20f2970eaa092ba6e99055b61a53b',
  weatherSampleChars: 1796
}

function placeholder2D(): DataTexture {
  const data = new Uint8Array([255, 128, 64, 32])
  const texture = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType)
  texture.minFilter = LinearMipMapLinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

// The consumer graph the march builds, on the default context's numbers
function weatherSampleWGSL(): string {
  const sample = createSampleWeather(
    tslTexture(placeholder2D()),
    uniform(new Vector2(100, 100)),
    uniform(new Vector2(0, 0)),
    uniform(new Vector4(750, 1500, 3000, 5000)),
    uniform(new Vector4(1400, 2200, 4000, 6000)),
    uniform(new Vector4(1, 1, 1, 1)),
    uniform(new Vector4(0.35, 0.35, 0.35, 0.35)),
    uniform(0.3),
    uniform(new Vector4(0.6, 0.6, 0.6, 0.5)),
    uniform(new Vector4(1, 1, 1, 1)),
    'rgba',
    false
  )
  return compileWGSL(sample(vec2(0.5, 0.5), float(1000), float(0))).fragment
}

describe('procedural weather is byte-identical off', () => {
  setCurrentSpec('procedural-weather-identity')

  test("the default weather generator still compiles to main's WGSL", () => {
    const wgsl = compileWGSL(localWeather(vec2(0.5, 0.5))).fragment

    log('default-weather-generator', [
      { field: 'main commit', expected: MAIN_COMMIT, actual: MAIN_COMMIT },
      {
        field: 'digest',
        expected: MAIN.localWeatherGenerator,
        actual: digest(wgsl)
      },
      {
        field: 'chars',
        expected: MAIN.localWeatherGeneratorChars,
        actual: wgsl.length
      }
    ])
    expect(wgsl.length).toBe(MAIN.localWeatherGeneratorChars)
    expect(digest(wgsl)).toBe(MAIN.localWeatherGenerator)
  })

  test('the march still reads the weather map exactly as main does', () => {
    // The consumer. This graph moves if the feature leaks into the default
    // path, by a branch, a sample or a uniform
    const wgsl = weatherSampleWGSL()

    log('march-weather-sample', [
      { field: 'main commit', expected: MAIN_COMMIT, actual: MAIN_COMMIT },
      { field: 'digest', expected: MAIN.weatherSample, actual: digest(wgsl) },
      { field: 'chars', expected: MAIN.weatherSampleChars, actual: wgsl.length }
    ])
    expect(wgsl.length).toBe(MAIN.weatherSampleChars)
    expect(digest(wgsl)).toBe(MAIN.weatherSample)
  })

  test('the default context builds no generator at all', () => {
    // The other half of (1), not merely the same shader but no new object
    const ctx = new CloudsContext()
    expect(ctx.experimental.proceduralWeather).toBe(false)
    expect(ctx.proceduralWeather).toBeNull()
    expect(ctx.localWeatherTexture).toBeNull()
    expect(ctx.resolvedLocalWeatherTexture).toBeNull()
  })

  test('the opt-in reaches a different shader than the default generator', () => {
    // (2). The feature replaces a texture's CONTENTS rather than adding a
    // branch to the march, so the march's WGSL cannot move. The graph it does
    // change is the generator's own shader
    const reference = digest(compileWGSL(localWeather(vec2(0.5, 0.5))).fragment)
    const weather = new ProceduralWeather({ seed: 0 })
    const procedural = digest(
      compileWGSL(weather.generate(vec2(0.5, 0.5))).fragment
    )
    weather.dispose()

    log('on-vs-off-digest', [
      {
        field: 'reference generator',
        expected: MAIN.localWeatherGenerator,
        actual: reference
      },
      {
        field: 'procedural generator',
        expected: '!= reference',
        actual: procedural
      }
    ])
    expect(procedural).not.toBe(reference)
  })

  test('the flag installs the generator and turning it off removes it', () => {
    const ctx = new CloudsContext()
    ctx.experimental = { proceduralWeather: true }

    expect(ctx.proceduralWeather).not.toBeNull()
    expect(ctx.localWeatherTexture).toBe(ctx.proceduralWeather)
    expect(ctx.resolvedLocalWeatherTexture).toBe(ctx.proceduralWeather?.texture)
    expect(ctx.proceduralWeather?.needsRender).toBe(true)

    ctx.experimental = { proceduralWeather: false }
    expect(ctx.proceduralWeather).toBeNull()
    expect(ctx.localWeatherTexture).toBeNull()

    log('flag-gate', [
      {
        field: 'size',
        expected: 512,
        actual: ctx.proceduralWeather?.size ?? 512
      },
      { field: 'installed then cleared', expected: true, actual: true }
    ])
  })

  test('a texture the caller set is never replaced by the flag', () => {
    const ctx = new CloudsContext()
    const mine = new ProceduralWeather({ seed: 4 })
    ctx.localWeatherTexture = mine
    ctx.experimental = { proceduralWeather: true }

    expect(ctx.proceduralWeather).toBeNull()
    expect(ctx.localWeatherTexture).toBe(mine)

    ctx.localWeatherTexture = null
    mine.dispose()
  })

  test("turning the flag off does not take a caller's texture with it", () => {
    const ctx = new CloudsContext()
    ctx.experimental = { proceduralWeather: true }
    const mine = new ProceduralWeather({ seed: 9 })
    ctx.localWeatherTexture = mine

    ctx.experimental = { proceduralWeather: false }
    expect(ctx.localWeatherTexture).toBe(mine)
    expect(ctx.resolvedLocalWeatherTexture).toBe(mine.texture)

    ctx.localWeatherTexture = null
    mine.dispose()
  })

  test('the flag bumps graphVersion, so the march rebuilds', () => {
    const ctx = new CloudsContext()
    const before = ctx.graphVersion
    ctx.experimental = { proceduralWeather: true }
    const after = ctx.graphVersion
    expect(after).toBeGreaterThan(before)
    log('flag-graph-version', [
      { field: 'before', expected: '>', actual: before },
      { field: 'after', expected: '>', actual: after }
    ])
  })
})
