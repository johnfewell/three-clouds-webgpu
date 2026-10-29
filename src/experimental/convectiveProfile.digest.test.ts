// The point of an opt-in feature is that the graph it is off must be the graph
// that shipped, and a digest of the compiled shader is the only evidence that
// holds. Both halves of the proof, why these two samplers and not the whole
// fragment, and how the literals were taken: docs/design/cloud-types.md §7

// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { createHash } from 'node:crypto'
import { float, vec2, vec3, vec4 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'
import { createSampleMedia } from '../density/sampleShape'
import { createSampleWeather } from '../density/sampleWeather'
import { createLayerUniforms, updateLayerUniforms } from '../layerUniforms'
import {
  createParameterUniforms,
  updateParameterUniforms
} from '../parameterUniforms'
import {
  buildConvectiveDeps,
  createConvectiveUniforms,
  type ConvectiveDeps
} from './convectiveProfile'

// Both literals are main's samplers, recomputed from a clean main tree at
// 5d1fd367, after normalizeWGSL began stripping the revision banner and struct ids
// Recompute from main, never from this branch
const MAIN_WEATHER_SHA256 =
  '54290227eaf68913b03a6624604ada0d6227b023c007816a01a788072447e89a'

const MAIN_MEDIA_SHA256 =
  'c79cc3132ab80131e6c3086496fe9e9e5e3b997cf9cafd64d9471e08798207cc'

interface PassInternals {
  convectiveDeps: (
    ctx: unknown,
    layerU: unknown,
    paramU: unknown
  ) => ConvectiveDeps | null
}

// The two samplers CloudsPassNode.ts builds, arguments read off a default
// context so the list under test is the list at the call site
function defaultSamplers(convective: ConvectiveDeps | null) {
  const ctx = clouds({ sceneDepth: null }).cloudsContext
  const layerU = createLayerUniforms()
  updateLayerUniforms(layerU, ctx)
  const paramU = createParameterUniforms(ctx)
  updateParameterUniforms(paramU, ctx)

  const weather = createSampleWeather(
    paramU.localWeatherTexture,
    paramU.localWeatherRepeat,
    paramU.localWeatherOffset,
    layerU.minLayerHeights,
    layerU.maxLayerHeights,
    layerU.weatherExponents,
    layerU.shapeAlteringBiases,
    paramU.coverage,
    layerU.coverageFilterWidths,
    layerU.shadowLayerMask,
    ctx.cloudLayers.localWeatherChannels,
    false,
    ctx.cloudLayers.structure,
    // weatherSampler comes before this seam so null keeps the
    // default path so this digest still measures convection alone
    null,
    convective
  )

  const media = createSampleMedia(
    paramU.shapeTexture,
    paramU.shapeRepeat,
    paramU.shapeOffset,
    layerU.shapeAmounts,
    paramU.shapeDetailTexture,
    paramU.shapeDetailRepeat,
    paramU.shapeDetailOffset,
    layerU.shapeDetailAmounts,
    paramU.turbulenceTexture,
    paramU.turbulenceRepeat,
    paramU.turbulenceDisplacement,
    paramU.localWeatherRepeat,
    paramU.localWeatherOffset,
    layerU.densityScales,
    layerU.densityProfileExpTerms,
    layerU.densityProfileExponents,
    layerU.densityProfileLinearTerms,
    layerU.densityProfileConstantTerms,
    ctx.turbulence,
    ctx.shapeDetail,
    ctx.experimental.distantShapeDetailFade,
    ctx.cloudLayers.structure,
    convective
  )

  // One fixed sample site each, so a difference in a digest is a difference in
  // the emitted graph and not in the inputs
  const weatherWGSL = normalizeWGSL(
    compileWGSL(
      weather(vec2(0.5, 0.5), float(1000), float(0.5), vec4(0.4, 0.4, 0.4, 0))
    ).fragment
  )
  const mediaWGSL = normalizeWGSL(
    compileWGSL(
      media(
        vec4(0.6, 0.6, 0.6, 0),
        vec4(0.4, 0.4, 0.4, 0),
        vec3(0, 6361000, 0),
        vec2(0.5, 0.5),
        float(0.2),
        float(0.5)
      )
    ).fragment
  )
  return {
    weather: sha256(weatherWGSL),
    media: sha256(mediaWGSL),
    weatherWGSL,
    mediaWGSL
  }
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

const withTower = (over: { anvilStrength?: number } = {}): ConvectiveDeps => {
  const pass = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  // A 1.2 to 10.2 km tower on lane 3, so the shoulder is not ramped away
  ctx.cloudLayers[3]!.altitude = 1200
  ctx.cloudLayers[3]!.height = 9000
  ctx.convectiveProfile.anvilStrength =
    over.anvilStrength ?? ctx.convectiveProfile.anvilStrength
  const layerU = createLayerUniforms()
  updateLayerUniforms(layerU, ctx)
  const uniforms = createConvectiveUniforms(ctx.convectiveProfile)
  const paramU = createParameterUniforms(ctx)
  updateParameterUniforms(paramU, ctx)
  return buildConvectiveDeps(
    {
      expTerms: layerU.densityProfileExpTerms,
      exponents: layerU.densityProfileExponents,
      linearTerms: layerU.densityProfileLinearTerms,
      constantTerms: layerU.densityProfileConstantTerms
    },
    layerU.minLayerHeights,
    layerU.maxLayerHeights,
    paramU.localWeatherRepeat,
    uniforms
  )
}

describe('convection is gated on the flag, not on a zero', () => {
  it('the pass supplies no deps until the flag is on', () => {
    // The digests below prove the shaders, this proves the seam. A gate that
    // returned a zeroed dep instead of null would leave them passing
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    const layerU = createLayerUniforms()
    updateLayerUniforms(layerU, ctx)
    const paramU = createParameterUniforms(ctx)
    updateParameterUniforms(paramU, ctx)
    const off = (pass as unknown as PassInternals).convectiveDeps(
      ctx,
      layerU,
      paramU
    )
    ctx.experimental = { convectiveProfile: true }
    const on = (pass as unknown as PassInternals).convectiveDeps(
      ctx,
      layerU,
      paramU
    )

    log('convective deps', { offIsNull: off === null, onType: typeof on })

    expect(off).toBeNull()
    expect(on).not.toBeNull()
  })
})

describe('convection is byte-identical to main when off', () => {
  it("the weather sampler without convection is main's weather sampler", () => {
    const { weather } = defaultSamplers(null)
    log('convection off, weather digest', {
      digest: weather,
      matchesMain: weather === MAIN_WEATHER_SHA256
    })
    expect(MAIN_WEATHER_SHA256).not.toBe('')
    expect(weather).toBe(MAIN_WEATHER_SHA256)
  })

  it("the media sampler without convection is main's media sampler", () => {
    const { media } = defaultSamplers(null)
    log('convection off, media digest', {
      digest: media,
      matchesMain: media === MAIN_MEDIA_SHA256
    })
    expect(MAIN_MEDIA_SHA256).not.toBe('')
    expect(media).toBe(MAIN_MEDIA_SHA256)
  })

  it('the weather sampler with convection emits a different graph', () => {
    // Without this the test above could be passing because the argument is
    // dropped on the way in, or because the guarded block emits nothing
    const { weather } = defaultSamplers(withTower())
    log('convection on, weather digest', {
      digest: weather,
      differsFromMain: weather !== MAIN_WEATHER_SHA256
    })
    expect(weather).not.toBe(MAIN_WEATHER_SHA256)
  })

  it('the media sampler with convection emits a different graph', () => {
    const { media } = defaultSamplers(withTower())
    log('convection on, media digest', {
      digest: media,
      differsFromMain: media !== MAIN_MEDIA_SHA256
    })
    expect(media).not.toBe(MAIN_MEDIA_SHA256)
  })

  it('each term reaches only the sampler that owns it', () => {
    // Placement from design doc section 3.3, on the emitted text rather than a
    // digest, because the strengths are uniforms and a digest cannot see them
    // Perlin's lattice is a floor()
    const on = defaultSamplers(withTower())
    const off = defaultSamplers(null)
    const expCalls = (m: string) => (m.match(/exp\(/g) ?? []).length

    log('term placement', {
      weatherFloorsOn: on.weatherWGSL.includes('floor('),
      weatherFloorsOff: off.weatherWGSL.includes('floor('),
      mediaFloorsOn: on.mediaWGSL.includes('floor('),
      mediaFloorsOff: off.mediaWGSL.includes('floor('),
      weatherExpOn: expCalls(on.weatherWGSL),
      mediaExpOn: expCalls(on.mediaWGSL),
      mediaExpOff: expCalls(off.mediaWGSL)
    })

    // The cell mask is a coverage term, so the weather sampler grows Perlin's
    // lattice when it is on, and the media sampler never grows it at all
    expect(off.weatherWGSL).not.toContain('floor(')
    expect(on.weatherWGSL).toContain('floor(')
    expect(on.mediaWGSL).not.toContain('floor(')
    // The shoulder is a vertical law, so the media sampler grows an exp()
    // beyond the one getLayerDensity already had, and the weather sampler
    // grows none
    expect(expCalls(on.mediaWGSL)).toBeGreaterThan(expCalls(off.mediaWGSL))
    expect(expCalls(on.weatherWGSL)).toBe(expCalls(off.weatherWGSL))
  })

  it('a zero-strength shoulder changes no graph, because strength is a uniform', () => {
    // Stated rather than asserted the other way round: the terms are not
    // graph-separable because their strengths are uniforms, so a caller who
    // wants cells without anvils tunes anvilStrength to 0 at no rebuild cost
    const full = defaultSamplers(withTower())
    const zeroed = defaultSamplers(withTower({ anvilStrength: 0 }))

    log('anvilStrength = 0', {
      weatherSame: full.weather === zeroed.weather,
      mediaSame: full.media === zeroed.media
    })

    expect(zeroed.weather).toBe(full.weather)
    expect(zeroed.media).toBe(full.media)
  })
})
