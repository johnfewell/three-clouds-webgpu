// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Data3DTexture, DataTexture, Texture } from 'three'

import { log } from '../test/helpers/log'
import { CloudsContext } from './CloudsContext'
import {
  createParameterUniforms,
  disposePlaceholders,
  updateParameterUniforms
} from './parameterUniforms'
import { defaults } from './qualityPresets'

describe('parameterUniforms', () => {
  test('defaults match parameters.glsl uniform table', () => {
    const ctx = new CloudsContext()
    const u = createParameterUniforms(ctx)

    const table: Array<{ name: string; expected: unknown; actual: unknown }> = [
      {
        name: 'resolution',
        expected: '0,0',
        actual: `${u.resolution.value.x},${u.resolution.value.y}`
      },
      { name: 'frame', expected: 0, actual: u.frame.value },
      {
        name: 'scatteringCoefficient',
        expected: 1,
        actual: u.scatteringCoefficient.value
      },
      {
        name: 'absorptionCoefficient',
        expected: 0,
        actual: u.absorptionCoefficient.value
      },
      {
        name: 'minDensity',
        expected: defaults.clouds.minDensity,
        actual: u.minDensity.value
      },
      {
        name: 'minExtinction',
        expected: defaults.clouds.minExtinction,
        actual: u.minExtinction.value
      },
      {
        name: 'minTransmittance',
        expected: defaults.clouds.minTransmittance,
        actual: u.minTransmittance.value
      },
      { name: 'coverage', expected: 0.3, actual: u.coverage.value },
      {
        name: 'turbulenceDisplacement',
        expected: 350,
        actual: u.turbulenceDisplacement.value
      },
      {
        name: 'hazeDensityScale',
        expected: 3e-5,
        actual: u.hazeDensityScale.value
      },
      { name: 'hazeExponent', expected: 1e-3, actual: u.hazeExponent.value },
      {
        name: 'hazeScatteringCoefficient',
        expected: 0.9,
        actual: u.hazeScatteringCoefficient.value
      },
      {
        name: 'hazeAbsorptionCoefficient',
        expected: 0.5,
        actual: u.hazeAbsorptionCoefficient.value
      }
    ]
    console.table(table)
    for (const row of table) {
      expect(row.actual).toEqual(row.expected)
    }

    disposePlaceholders(u.placeholders)
  })

  test('repeat vectors share context instances; offsets use derived vectors', () => {
    const ctx = new CloudsContext()
    const u = createParameterUniforms(ctx)

    expect(u.localWeatherRepeat.value).toBe(ctx.localWeatherRepeat)
    expect(u.localWeatherOffset.value).toBe(ctx.derivedLocalWeatherOffset)
    expect(u.shapeRepeat.value).toBe(ctx.shapeRepeat)
    expect(u.shapeOffset.value).toBe(ctx.derivedShapeOffset)
    expect(u.shapeDetailRepeat.value).toBe(ctx.shapeDetailRepeat)
    expect(u.shapeDetailOffset.value).toBe(ctx.derivedShapeDetailOffset)
    expect(u.turbulenceRepeat.value).toBe(ctx.turbulenceRepeat)

    disposePlaceholders(u.placeholders)
  })

  test('placeholder textures when no textures assigned', () => {
    const ctx = new CloudsContext()
    const u = createParameterUniforms(ctx)

    expect(u.localWeatherTexture.value).toBe(u.placeholders.localWeather)
    expect(u.shapeTexture.value).toBe(u.placeholders.shape)
    expect(u.shapeDetailTexture.value).toBe(u.placeholders.shapeDetail)
    expect(u.turbulenceTexture.value).toBe(u.placeholders.turbulence)
    // stbnTexture uses lazy init, always a real texture via createJitterTexture
    expect(u.stbnTexture.value).toBeInstanceOf(Data3DTexture)

    expect(u.placeholders.localWeather).toBeInstanceOf(DataTexture)
    expect(u.placeholders.turbulence).toBeInstanceOf(DataTexture)
    expect(u.placeholders.shape).toBeInstanceOf(Data3DTexture)
    expect(u.placeholders.shapeDetail).toBeInstanceOf(Data3DTexture)

    disposePlaceholders(u.placeholders)
  })

  test('assigning a texture changes .value, not graph identity', () => {
    const ctx = new CloudsContext()
    ctx.stbnTexture = null
    const u = createParameterUniforms(ctx)

    const realTex = new Texture()
    ctx.localWeatherTexture = realTex
    updateParameterUniforms(u, ctx)

    expect(u.localWeatherTexture.value).toBe(realTex)

    realTex.dispose()
    disposePlaceholders(u.placeholders)
  })

  test('updateParameterUniforms syncs scalar values from context', () => {
    const ctx = new CloudsContext()
    const u = createParameterUniforms(ctx)

    ctx.frame = 42
    ctx.coverage = 0.8
    ctx.scatteringCoefficient = 2
    ctx.absorptionCoefficient = 0.5
    ctx.turbulenceDisplacement = 500
    ctx.clouds.minDensity = 1e-4
    ctx.clouds.minExtinction = 1e-4
    ctx.clouds.minTransmittance = 1e-1

    updateParameterUniforms(u, ctx)

    expect(u.frame.value).toBe(42)
    expect(u.coverage.value).toBe(0.8)
    expect(u.scatteringCoefficient.value).toBe(2)
    expect(u.absorptionCoefficient.value).toBe(0.5)
    expect(u.turbulenceDisplacement.value).toBe(500)
    expect(u.minDensity.value).toBe(1e-4)
    expect(u.minExtinction.value).toBe(1e-4)
    expect(u.minTransmittance.value).toBe(1e-1)

    disposePlaceholders(u.placeholders)
  })

  // the haze uniforms were never written after creation, so a runtime
  // change of ctx.clouds.haze* reached the shader only through a rebuild
  test('updateParameterUniforms syncs the haze parameters from context', () => {
    const ctx = new CloudsContext()
    const u = createParameterUniforms(ctx)

    ctx.clouds.hazeDensityScale = 0
    ctx.clouds.hazeExponent = 2e-3
    ctx.clouds.hazeScatteringCoefficient = 0.7
    ctx.clouds.hazeAbsorptionCoefficient = 0.25

    updateParameterUniforms(u, ctx)

    const rows = [
      {
        name: 'hazeDensityScale',
        expected: 0,
        actual: u.hazeDensityScale.value
      },
      { name: 'hazeExponent', expected: 2e-3, actual: u.hazeExponent.value },
      {
        name: 'hazeScatteringCoefficient',
        expected: 0.7,
        actual: u.hazeScatteringCoefficient.value
      },
      {
        name: 'hazeAbsorptionCoefficient',
        expected: 0.25,
        actual: u.hazeAbsorptionCoefficient.value
      }
    ]
    log('parameterUniforms:haze-sync', rows)
    for (const row of rows) expect(row.actual, row.name).toBe(row.expected)

    disposePlaceholders(u.placeholders)
  })

  test('disposePlaceholders cleans up', () => {
    const ctx = new CloudsContext()
    ctx.stbnTexture = null
    const u = createParameterUniforms(ctx)

    expect(() => disposePlaceholders(u.placeholders)).not.toThrow()
  })
})

// a placeholder's filters decide the sampling instruction once, at
// build. Nearest/Nearest emits `textureLoad`, and a later `.value` swap to a
// Linear texture never recompiles

// The placeholders inherited Nearest, and no plate or unit test could see it,
// so these pin the emitted instruction
describe('placeholder filters decide the sampling instruction', () => {
  async function compile3D(tex: Data3DTexture): Promise<string> {
    const { compileWGSL } = await import('../test/helpers/compileWGSL')
    const { Fn, texture3D, vec3, vec4 } = await import('three/tsl')
    const node = texture3D(tex)
    ;(node as unknown as { updateMatrix: boolean }).updateMatrix = false
    return compileWGSL(Fn(() => vec4(node.sample(vec3(0.5, 0.5, 0.5)).r))())
      .fragment
  }

  async function compile2D(tex: Texture): Promise<string> {
    const { compileWGSL } = await import('../test/helpers/compileWGSL')
    const { Fn, texture, vec2, vec4 } = await import('three/tsl')
    return compileWGSL(Fn(() => vec4(texture(tex).sample(vec2(0.5, 0.5)).r))())
      .fragment
  }

  test('the cloud volumes are FILTERED, not point-sampled', async () => {
    const u = createParameterUniforms(new CloudsContext())
    const wgsl = await compile3D(u.placeholders.shapeDetail)

    expect(wgsl, 'shape/shapeDetail must sample, not load').toMatch(
      /textureSample/
    )
    expect(wgsl).not.toMatch(/textureLoad/)
    disposePlaceholders(u.placeholders)
  })

  test('weather and turbulence are FILTERED', async () => {
    const u = createParameterUniforms(new CloudsContext())
    const wgsl = await compile2D(u.placeholders.turbulence)

    expect(wgsl).toMatch(/textureSample/)
    expect(wgsl).not.toMatch(/textureLoad/)
    disposePlaceholders(u.placeholders)
  })

  test('STBN stays POINT-sampled, by citation not by accident', async () => {
    // createJitterTexture sets Nearest (loadBakedCloudTextures.ts:124-125):
    // interpolating blue noise would blend away its decorrelation, so this is
    // the one read that should load rather than sample
    const { createJitterTexture } =
      await import('./textures/loadBakedCloudTextures')
    const wgsl = await compile3D(createJitterTexture())
    expect(wgsl).toMatch(/textureLoad/)
  })
})

// texture nodes with the same value uuid at build share one binding
// (TextureNode.getUniformHash). Shared placeholders merged slots, so detail
// read the shape volume and turbulence the weather map, permanently
describe('each texture slot keeps its own binding', () => {
  async function boundAfterLateAssignment(
    slots: 'volumes' | 'maps'
  ): Promise<{ bound: unknown[]; a: Texture; b: Texture }> {
    const { compileWGSL } = await import('../test/helpers/compileWGSL')
    const { Fn, vec2, vec3, vec4 } = await import('three/tsl')
    const ctx = new CloudsContext()
    const u = createParameterUniforms(ctx)
    const node =
      slots === 'volumes'
        ? Fn(() =>
            vec4(
              u.shapeTexture.sample(vec3(0.5)).r,
              u.shapeDetailTexture.sample(vec3(0.25)).r,
              0,
              1
            )
          )()
        : Fn(() =>
            vec4(
              u.localWeatherTexture.sample(vec2(0.5)).r,
              u.turbulenceTexture.sample(vec2(0.25)).r,
              0,
              1
            )
          )()
    const { boundTextures } = compileWGSL(node)

    // The consumer's textures arrive after the first build
    let a: Texture
    let b: Texture
    if (slots === 'volumes') {
      a = new Data3DTexture(new Uint8Array(8), 2, 2, 2)
      b = new Data3DTexture(new Uint8Array(8), 2, 2, 2)
      ctx.shapeTexture = a as Data3DTexture
      ctx.shapeDetailTexture = b as Data3DTexture
    } else {
      a = new DataTexture(new Uint8Array(16), 2, 2)
      b = new DataTexture(new Uint8Array(16), 2, 2)
      ctx.localWeatherTexture = a
      ctx.turbulenceTexture = b
    }
    updateParameterUniforms(u, ctx)
    const bound = boundTextures()
    disposePlaceholders(u.placeholders)
    return { bound, a, b }
  }

  test('shape and detail bind separately after a late assignment', async () => {
    const { bound, a, b } = await boundAfterLateAssignment('volumes')
    log('late-volumes', {
      shapeBound: bound.includes(a),
      detailBound: bound.includes(b)
    })
    expect(bound).toContain(a)
    expect(bound).toContain(b)
  })

  test('weather and turbulence bind separately after a late assignment', async () => {
    const { bound, a, b } = await boundAfterLateAssignment('maps')
    log('late-maps', {
      weatherBound: bound.includes(a),
      turbulenceBound: bound.includes(b)
    })
    expect(bound).toContain(a)
    expect(bound).toContain(b)
  })

  test('no two texture slots start on the same placeholder', () => {
    const ctx = new CloudsContext()
    ctx.stbnTexture = null
    const u = createParameterUniforms(ctx)
    updateParameterUniforms(u, ctx)
    const values = [
      u.localWeatherTexture.value,
      u.turbulenceTexture.value,
      u.shapeTexture.value,
      u.shapeDetailTexture.value,
      u.stbnTexture.value
    ]
    expect(new Set(values).size).toBe(values.length)
    disposePlaceholders(u.placeholders)
  })
})
