// The shadow march drops its weather read when no layer casts a shadow: the
// mask zeroes that read, so the fetch is pure cost. These pin that the read
// leaves only in that case, and that every graph with a caster is untouched

import { beforeEach, describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { shadowWGSLForLayers } from '../../test/helpers/marchWGSLDigest'

const count = (wgsl: string, needle: string) => wgsl.split(needle).length - 1

// The weather map is a 2D texture, and the jitter, shape and detail volumes
// are texture_3d. Counted as a delta, so other 2D bindings do not matter
const WEATHER_BINDING = 'texture_2d<f32>'
const SAMPLE = 'textureSampleLevel('

function shape(wgsl: string) {
  return {
    weatherBindings: count(wgsl, WEATHER_BINDING),
    samples: count(wgsl, SAMPLE)
  }
}

describe('shadow march weather read when no layer casts a shadow', () => {
  beforeEach(() => {
    setCurrentSpec('shadowWeatherSkip')
  })

  test('the read leaves exactly when every lane has shadow off', () => {
    const casting = shadowWGSLForLayers(() => {})
    const none = shadowWGSLForLayers(layers => {
      for (let i = 0; i < 4; i++) layers[i]!.shadow = false
    })
    const a = shape(casting)
    const b = shape(none)
    log('shadow-weather-read', [
      { config: 'default (lanes 0 and 1 cast)', ...a },
      { config: 'no lane casts', ...b }
    ])
    expect(a.weatherBindings).toBeGreaterThan(0)
    expect(b.weatherBindings).toBe(a.weatherBindings - 1)
    // One sample site and nothing else: the shape and detail reads stay
    expect(b.samples).toBe(a.samples - 1)
  })

  test('keeps the read when pow would run, so the skip stays exact', () => {
    // pow(0, e) is not defined for every e, so the product with the zero mask
    // is only known to be +0 when the exponent is the identity
    const withPow = shadowWGSLForLayers(layers => {
      for (let i = 0; i < 4; i++) layers[i]!.shadow = false
      layers[0]!.weatherExponent = 2
    })
    const casting = shape(shadowWGSLForLayers(() => {}))
    log('shadow-weather-read-pow', [
      { config: 'default', ...casting },
      { config: 'no caster, exponent 2', ...shape(withPow) }
    ])
    expect(shape(withPow)).toEqual(casting)
  })

  test('any single caster compiles the same shader as the default', () => {
    const casting = shadowWGSLForLayers(() => {})
    const oneCaster = shadowWGSLForLayers(layers => {
      for (let i = 0; i < 4; i++) layers[i]!.shadow = i === 2
    })
    log('shadow-weather-read-caster', [
      { config: 'lane 2 casts only', identical: oneCaster === casting }
    ])
    expect(oneCaster).toBe(casting)
  })
})
