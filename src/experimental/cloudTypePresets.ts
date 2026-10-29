// Cloud-type presets: named skies assembled only from knobs that already exist
// (CloudLayer fields, DensityProfile, coverage), so a preset moves numbers and
// not compiled shape, apart from the structure facts it may change
// Upstream ships no such table: an untouched context renders what it rendered
// before this file existed

import type { CloudLayerLike } from '../CloudLayer'
import type { CloudLayers } from '../CloudLayers'
import type { DensityProfileLike } from '../DensityProfile'

// The four lanes, in `context.cloudLayers` order (weather channels r, g, b, a)
export type CloudTypeLayers = readonly [
  CloudLayerLike,
  CloudLayerLike,
  CloudLayerLike,
  CloudLayerLike
]

export interface CloudTypePreset {
  // `context.coverage`, the global cloud fraction in [0, 1]
  readonly coverage: number
  // One entry per lane, in the channel order the shader samples
  readonly layers: CloudTypeLayers
}

export const cloudTypePresetNames = [
  'fairWeatherCumulus',
  'stratocumulusDeck',
  'overcastSheet',
  'highCirrus',
  'groundFog',
  'mixedSky'
] as const

export type CloudTypePresetName = (typeof cloudTypePresetNames)[number]

// An empty lane: height 0 is what CloudLayers.structure compiles out, so a
// preset spends only the lanes its cloud type needs
const inactiveLane = (channel: 'r' | 'g' | 'b' | 'a'): CloudLayerLike => ({
  channel,
  height: 0
})

// Rises with height, so a cell is thin at its base and dense at its top,
// which is what reads as a cumulus rather than a slab
const risingProfile: DensityProfileLike = {
  expTerm: 0,
  exponent: 0,
  linearTerm: 1,
  constantTerm: 0.1
}

// Nearly even thickness, so a layer reads as a sheet or a deck
const slabProfile: DensityProfileLike = {
  expTerm: 0,
  exponent: 0,
  linearTerm: 0.3,
  constantTerm: 0.7
}

// Dense at the base and thinning upward, for fog on the surface. expTerm 1 is
// the panel's ceiling, so the steepness lives in the exponent
const groundHuggingProfile: DensityProfileLike = {
  expTerm: 1,
  exponent: -3,
  linearTerm: 0,
  constantTerm: 0.1
}

// Fair-weather cumulus: scattered, sharply lit puffs with flat bases. Low
// coverage and a modest height keep the gaps the eye reads as fair weather
const fairWeatherCumulus: CloudTypePreset = {
  coverage: 0.32,
  layers: [
    {
      channel: 'r',
      altitude: 1600,
      height: 1200,
      densityScale: 0.32,
      shapeAmount: 1,
      shapeDetailAmount: 1,
      weatherExponent: 0.7,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.45,
      densityProfile: risingProfile,
      shadow: true
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Stratocumulus: a broken deck of flat-based lumps. Wider coverage and a
// flatter profile than cumulus, and a weather exponent near 1 so cells stay
// lumped instead of blobby
const stratocumulusDeck: CloudTypePreset = {
  coverage: 0.52,
  layers: [
    {
      channel: 'r',
      altitude: 1300,
      height: 900,
      densityScale: 0.28,
      shapeAmount: 1,
      shapeDetailAmount: 1.1,
      weatherExponent: 0.9,
      shapeAlteringBias: 0.3,
      coverageFilterWidth: 0.35,
      densityProfile: { ...risingProfile, linearTerm: 0.6, constantTerm: 0.4 },
      shadow: true
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Overcast, altostratus: a continuous high sheet that dims the sun without
// hiding it. Coverage near 1 with a low densityScale is what makes it
// translucent, and the flat profile keeps it off the low deck
const overcastSheet: CloudTypePreset = {
  coverage: 0.92,
  layers: [
    {
      channel: 'r',
      altitude: 3400,
      height: 1800,
      densityScale: 0.1,
      shapeAmount: 1,
      shapeDetailAmount: 1.2,
      weatherExponent: 0.5,
      shapeAlteringBias: 0.4,
      coverageFilterWidth: 0.2,
      densityProfile: slabProfile,
      shadow: true
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// High cirrus: a thin, semi-transparent veil at cirrus altitude, NOT fibrous
// The shape texture has no wind shear to make the streaks real cirrus has, and
// design doc 3.5 leaves that to a separate sheared cirrus shell
const highCirrus: CloudTypePreset = {
  coverage: 0.7,
  layers: [
    {
      channel: 'r',
      altitude: 8200,
      height: 700,
      densityScale: 0.012,
      shapeAmount: 0.6,
      shapeDetailAmount: 0.9,
      weatherExponent: 0.6,
      shapeAlteringBias: 0.45,
      coverageFilterWidth: 0.35,
      densityProfile: slabProfile,
      shadow: false
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Ground fog: a dense, shadowless layer on the surface, read as a fog BANK
// rather than radiation fog, because a 90 m layer is thinner than one march
// step at the story's grazing view and integrates to per-pixel noise
const groundFog: CloudTypePreset = {
  coverage: 0.85,
  layers: [
    {
      channel: 'r',
      altitude: 5,
      height: 600,
      densityScale: 0.45,
      shapeAmount: 1,
      shapeDetailAmount: 0.6,
      weatherExponent: 0.85,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.3,
      densityProfile: groundHuggingProfile,
      shadow: false
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Mixed sky: cumulus under a broken mid deck with cirrus over both, which is
// what three lanes are for. Altitudes ascend, the order the shader walks the
// intervals in, and the deck overlaps the cumulus on purpose (design 2.2)
const mixedSky: CloudTypePreset = {
  coverage: 0.45,
  layers: [
    {
      channel: 'r',
      altitude: 1500,
      height: 1100,
      densityScale: 0.3,
      shapeAmount: 1,
      shapeDetailAmount: 1,
      weatherExponent: 0.7,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.45,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'g',
      altitude: 2300,
      height: 900,
      densityScale: 0.15,
      shapeAmount: 0.9,
      shapeDetailAmount: 1.1,
      weatherExponent: 0.9,
      shapeAlteringBias: 0.3,
      coverageFilterWidth: 0.5,
      densityProfile: { ...slabProfile, constantTerm: 0.6 },
      shadow: true
    },
    {
      channel: 'b',
      altitude: 8000,
      height: 700,
      densityScale: 0.025,
      shapeAmount: 0.6,
      shapeDetailAmount: 0.9,
      weatherExponent: 0.6,
      shapeAlteringBias: 0.45,
      coverageFilterWidth: 0.35,
      densityProfile: slabProfile,
      shadow: false
    },
    inactiveLane('a')
  ]
}

export const cloudTypePresets: Record<CloudTypePresetName, CloudTypePreset> = {
  fairWeatherCumulus,
  stratocumulusDeck,
  overcastSheet,
  highCirrus,
  groundFog,
  mixedSky
}

// What a preset may write: `context.coverage` and the four
// `context.cloudLayers` lanes. Anything else would need a renderer change,
// which is what keeps this opt-in and free of render cost by construction
export interface CloudTypePresetTarget {
  readonly cloudLayers: CloudLayers
  coverage: number
}

export function isCloudTypePresetName(
  value: unknown
): value is CloudTypePresetName {
  return (
    typeof value === 'string' &&
    (cloudTypePresetNames as readonly string[]).includes(value)
  )
}

// The density profile as the shader evaluates it (clouds.glsl:107-109, ported
// at src/density/layerDensity.ts:29-32). The CPU twin a preset's profile is
// reasoned about with, so "denser at the top" is a number and not a claim
export function cloudTypeProfileAt(
  profile: DensityProfileLike,
  heightFraction: number
): number {
  return (
    (profile.expTerm ?? 0) *
      Math.exp((profile.exponent ?? 0) * heightFraction) +
    (profile.linearTerm ?? 0) * heightFraction +
    (profile.constantTerm ?? 0)
  )
}

// Write a preset onto a clouds context: the lanes reset to CloudLayer.DEFAULT
// first, so a preset defines a whole sky rather than a delta, and a lane the
// preset leaves implicit cannot keep the altitude or shadow flag it replaced

// Lane values reach the shader through the per-frame layer uniforms, and the
// graph-time facts a preset may change are polled by the context, so this needs
// no graphVersion bump and does not claim one
export function applyCloudTypePreset(
  target: CloudTypePresetTarget,
  name: CloudTypePresetName
): CloudTypePreset {
  const preset = cloudTypePresets[name]
  if (preset == null) {
    throw new RangeError(
      `unknown cloud type preset ${JSON.stringify(name)}, expected one of ${cloudTypePresetNames.join(', ')}`
    )
  }
  target.coverage = preset.coverage
  target.cloudLayers.reset()
  target.cloudLayers.set(preset.layers)
  return preset
}
