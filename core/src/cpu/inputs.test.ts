// The core's defaults and presets against a fresh CloudsContext. A3 starts a
// three-free frame from createCloudsInputs(), so a drifted default would
// silently render a different frame from the three package's

import { CloudsContext } from '../../../src/CloudsContext'
import type { QualityPreset } from '../../../src/qualityPresets'
import { log } from '../../../test/helpers/log'
import {
  applyQualityPreset,
  createCloudsInputs,
  type CloudsInputs
} from './inputs'

type Flat = Record<string, unknown>

// Every field both sides carry, as plain values
function flatten(value: unknown, prefix: string, out: Flat): Flat {
  if (value == null || typeof value !== 'object') {
    out[prefix] = value
    return out
  }
  if ('elements' in value) {
    out[prefix] = Array.from((value as { elements: number[] }).elements)
    return out
  }
  if ('x' in value && 'y' in value) {
    const v = value as { x: number; y: number; z?: number; w?: number }
    out[prefix] = [v.x, v.y, v.z, v.w].filter(c => c !== undefined)
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix === '' ? key : `${prefix}.${key}`, out)
  }
  return out
}

function portView(ctx: CloudsContext): Flat {
  const layers = ctx.cloudLayers.map(l => ({
    channel: l.channel,
    altitude: l.altitude,
    height: l.height,
    densityScale: l.densityScale,
    shapeAmount: l.shapeAmount,
    shapeDetailAmount: l.shapeDetailAmount,
    weatherExponent: l.weatherExponent,
    shapeAlteringBias: l.shapeAlteringBias,
    coverageFilterWidth: l.coverageFilterWidth,
    densityProfile: { ...l.densityProfile },
    shadow: l.shadow
  }))
  return flatten(
    {
      time: ctx.time,
      frame: ctx.frame,
      temporalUpscale: ctx.temporalUpscale,
      resolutionScale: ctx.resolutionScale,
      lightShafts: ctx.lightShafts,
      shapeDetail: ctx.shapeDetail,
      turbulence: ctx.turbulence,
      haze: ctx.haze,
      worldToECEFMatrix: ctx.worldToECEFMatrix,
      ellipsoidRadii: ctx.ellipsoid.radii,
      bottomRadius: ctx.bottomRadius,
      correctAltitude: ctx.correctAltitude,
      sunDirection: ctx.sunDirection,
      moonDirection: ctx.moonDirection,
      moonGain: ctx.moonGain,
      moonColor: ctx.moonColor,
      moonlight: ctx.experimental.moonlight,
      coverage: ctx.coverage,
      scatteringCoefficient: ctx.scatteringCoefficient,
      absorptionCoefficient: ctx.absorptionCoefficient,
      turbulenceDisplacement: ctx.turbulenceDisplacement,
      skyLightScale: ctx.skyLightScale,
      groundBounceScale: ctx.groundBounceScale,
      powderScale: ctx.powderScale,
      powderExponent: ctx.powderExponent,
      localWeatherRepeat: ctx.localWeatherRepeat,
      shapeRepeat: ctx.shapeRepeat,
      shapeDetailRepeat: ctx.shapeDetailRepeat,
      turbulenceRepeat: ctx.turbulenceRepeat,
      localWeatherOffset: ctx.localWeatherOffset,
      shapeOffset: ctx.shapeOffset,
      shapeDetailOffset: ctx.shapeDetailOffset,
      localWeatherVelocity: ctx.localWeatherVelocity,
      shapeVelocity: ctx.shapeVelocity,
      shapeDetailVelocity: ctx.shapeDetailVelocity,
      cloudLayers: layers,
      clouds: ctx.clouds,
      shadow: ctx.shadow
    },
    '',
    {}
  )
}

function coreView(inputs: CloudsInputs): Flat {
  const { ellipsoid, ...rest } = inputs
  return flatten({ ...rest, ellipsoidRadii: ellipsoid.radii }, '', {})
}

function expectSameFields(scope: string, core: Flat, port: Flat): void {
  const keys = [...new Set([...Object.keys(core), ...Object.keys(port)])].sort()
  const differing = keys.filter(
    k => JSON.stringify(core[k]) !== JSON.stringify(port[k])
  )
  log(scope, { fields: keys.length, differing: differing.join(' ') })
  // A comparison over nothing would pass vacuously
  expect(keys.length).toBeGreaterThan(100)
  expect(differing.map(k => [k, core[k], port[k]])).toEqual([])
}

describe('core inputs match a fresh CloudsContext', () => {
  it('defaults, field for field', () => {
    expectSameFields(
      'defaults',
      coreView(createCloudsInputs()),
      portView(new CloudsContext())
    )
  })

  it.each(['low', 'medium', 'high', 'ultra', 'lowEnd'] as QualityPreset[])(
    'the %s preset, applied over another preset',
    name => {
      // From `low` first, so a field a preset forgets to reset shows up
      const ctx = new CloudsContext()
      ctx.qualityPreset = 'low'
      // Fields every preset writes but none changes, dirtied on both sides
      ctx.haze = false
      ctx.resolutionScale = 0.5
      ctx.qualityPreset = name
      const inputs = applyQualityPreset(createCloudsInputs(), 'low')
      inputs.haze = false
      inputs.resolutionScale = 0.5
      applyQualityPreset(inputs, name)
      expectSameFields(`preset-${name}`, coreView(inputs), portView(ctx))
    }
  )
})
