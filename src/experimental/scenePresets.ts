// Whole-scene presets: a time of day, a cloud type, coverage, exposure and
// haze in one call. Opt-in and additive, so an untouched context keeps the
// digest main compiled

import { defaults } from '../qualityPresets'
import type { CirrusDeckParams } from './cirrusDeck'
import { cloudShapeDefaults, type CloudShapeParams } from './cloudShape'
import {
  applyCloudTypePreset,
  type CloudTypeLayers,
  type CloudTypePresetName,
  type CloudTypePresetTarget
} from './cloudTypePresets'
import {
  convectiveProfileDefaults,
  type ConvectiveProfileParams
} from './convectiveProfile'
import type { ExperimentalCloudOptions } from './options'
import {
  resolveTimeOfDay,
  syncCelestialDirections,
  type CelestialDirections,
  type CelestialSink,
  type TimeOfDayRequest
} from './timeOfDay'

export const scenePresetNames = [
  'partlyCloudy',
  'fluffy',
  'pixar',
  'stunningSunset',
  'moonlitNight',
  'hazy',
  'thunderstorm',
  'stormyEvening'
] as const

export type ScenePresetName = (typeof scenePresetNames)[number]

/**
 * A sky, assembled from existing knobs. `timeOfDay` is local solar time as a
 * fraction of a day, so 0.5 is local noon for every longitude, and what the sun
 * does with it depends on the observer's latitude and the date: 0.75 is sunset
 * at any latitude on an equinox, and earlier or later by up to an hour either
 * side of it.
 */
export interface ScenePreset {
  readonly cloudType: CloudTypePresetName
  readonly timeOfDay: number
  /** `context.coverage`, the global cloud fraction in [0, 1] */
  readonly coverage: number
  /** Relative tone-mapping exposure multiplier where 1 is the story baseline */
  readonly exposure: number
  /** Whether the haze layer is marched alongside the clouds */
  readonly haze: boolean
  /** Optional per-lane overrides applied on top of `cloudType` */
  readonly layers?: CloudTypeLayers
  /** Optional `context.cloudShape` overrides */
  readonly cloudShape?: Partial<CloudShapeParams>
  /** Optional `context.convectiveProfile` overrides */
  readonly convectiveProfile?: Partial<ConvectiveProfileParams>
  /** Optional `context.cirrusDeck` scalar overrides */
  readonly cirrusDeck?: Partial<
    Pick<
      CirrusDeckParams,
      'altitude' | 'strength' | 'scale' | 'velocityU' | 'velocityV'
    >
  >
  /** Optional `context.localWeatherOffset` UV shift */
  readonly localWeatherOffset?: readonly [number, number]
  /** Optional `context.moonGain` for moonlit skies */
  readonly moonGain?: number
  /** Optional `context.moonColor` RGB tint for moonlit skies */
  readonly moonColor?: readonly [number, number, number]
  /** Optional `context.skyLightScale` override */
  readonly skyLightScale?: number
  /** Optional `context.groundBounceScale` override */
  readonly groundBounceScale?: number
  /** Optional `context.powderScale` override */
  readonly powderScale?: number
  /** Optional `context.clouds.hazeDensityScale` override */
  readonly hazeDensityScale?: number
  /**
   * Experimental options the preset needs, written through the context's setter
   * so a preset pays the graph rebuild that option costs.
   * `applyReferenceMode` afterwards pins them back off
   */
  readonly experimental?: Partial<ExperimentalCloudOptions>
}

const inactiveLane = (channel: 'r' | 'g' | 'b' | 'a') => ({
  channel,
  height: 0
})

const risingProfile = {
  expTerm: 0,
  exponent: 0,
  linearTerm: 1,
  constantTerm: 0.1
}

const uniformProfile = {
  expTerm: 0,
  exponent: 0,
  linearTerm: 0.2,
  constantTerm: 0.8
}

const topHeavyProfile = {
  expTerm: 0,
  exponent: 0,
  linearTerm: 1,
  constantTerm: 0
}

const continuousConvective: Partial<ConvectiveProfileParams> = {
  anvilCenter: 0.86,
  anvilWidth: 0.14,
  anvilStrength: 0.7,
  cellsPerWeatherTile: 6,
  cellThreshold: 0,
  cellSoftness: 0.01,
  cellDensity: 0
}

// Partly cloudy: afternoon 14:59 solar time, 49% coverage, scattered fair-weather
// cumulus with smaller distant puffs (operator pick: variant B)
const partlyCloudy: ScenePreset = {
  cloudType: 'fairWeatherCumulus',
  timeOfDay: 0.624,
  coverage: 0.49,
  exposure: 1,
  haze: true,
  hazeDensityScale: 1.8e-5,
  cloudShape: {
    baseShadowStrength: 0.42,
    baseShadowHeight: 0.32
  },
  layers: [
    {
      channel: 'r',
      altitude: 900,
      height: 1100,
      densityScale: 0.22,
      shapeAmount: 1,
      shapeDetailAmount: 0.95,
      weatherExponent: 1.05,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.42,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'g',
      altitude: 2300,
      height: 800,
      densityScale: 0.12,
      shapeAmount: 0.9,
      shapeDetailAmount: 0.85,
      weatherExponent: 1.15,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.42,
      densityProfile: risingProfile,
      shadow: true
    },
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Fluffy: afternoon 14:59 solar time, 60% coverage, soft rounded cumulus puffs
// with wide open sky around the sun (operator pick: variant A)
const fluffy: ScenePreset = {
  cloudType: 'stratocumulusDeck',
  timeOfDay: 0.624,
  coverage: 0.6,
  exposure: 1,
  haze: true,
  hazeDensityScale: 1.8e-5,
  powderScale: 0.9,
  cloudShape: {
    baseShadowStrength: 0.2,
    baseShadowHeight: 0.3,
    erosionShape: -0.18
  },
  localWeatherOffset: [0.18, 0.42],
  layers: [
    {
      channel: 'r',
      altitude: 1350,
      height: 1450,
      densityScale: 0.28,
      shapeAmount: 0.92,
      shapeDetailAmount: 0.72,
      weatherExponent: 1.4,
      shapeAlteringBias: 0.38,
      coverageFilterWidth: 0.34,
      densityProfile: risingProfile,
      shadow: true
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Pixar: afternoon 14:59 solar time, 47% coverage, towering convective cumulus
// congestus over a lower cumulus deck with a soft high veil (operator pick: variant C)
const pixar: ScenePreset = {
  cloudType: 'mixedSky',
  timeOfDay: 0.624,
  coverage: 0.47,
  exposure: 1,
  haze: true,
  hazeDensityScale: 3e-5,
  skyLightScale: 1.15,
  powderScale: 0.82,
  cloudShape: {
    baseShadowStrength: 0.45,
    baseShadowHeight: 0.38,
    erosionShape: -0.15
  },
  experimental: { cirrusDeck: true },
  cirrusDeck: {
    altitude: 9500,
    strength: 0.35,
    scale: 45000
  },
  layers: [
    {
      channel: 'r',
      altitude: 1300,
      height: 1000,
      densityScale: 0.22,
      shapeAmount: 0.9,
      shapeDetailAmount: 0.85,
      weatherExponent: 0.95,
      shapeAlteringBias: 0.36,
      coverageFilterWidth: 0.46,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'g',
      altitude: 1800,
      height: 3200,
      densityScale: 0.26,
      shapeAmount: 0.88,
      shapeDetailAmount: 0.92,
      weatherExponent: 1.15,
      shapeAlteringBias: 0.42,
      coverageFilterWidth: 0.44,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'b',
      altitude: 6800,
      height: 600,
      densityScale: 0.025,
      shapeAmount: 0.75,
      shapeDetailAmount: 0.6,
      weatherExponent: 1.2,
      shapeAlteringBias: 0.45,
      coverageFilterWidth: 0.38,
      densityProfile: risingProfile,
      shadow: false
    },
    inactiveLane('a')
  ]
}

// Stunning sunset: 17:40 solar time, 1.46x exposure, 47% coverage, warm low sun
// lighting broken cumulus and altocumulus banks (operator pick: variant C)
const stunningSunset: ScenePreset = {
  cloudType: 'fairWeatherCumulus',
  timeOfDay: 0.736,
  coverage: 0.47,
  exposure: 1.46,
  haze: true,
  hazeDensityScale: 3.2e-5,
  localWeatherOffset: [0.08, 0.14],
  cloudShape: {
    baseShadowStrength: 0.35,
    baseShadowHeight: 0.35
  },
  layers: [
    {
      channel: 'r',
      altitude: 1600,
      height: 1000,
      densityScale: 0.18,
      shapeAmount: 1,
      shapeDetailAmount: 0.95,
      weatherExponent: 1.05,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.42,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'r',
      altitude: 2900,
      height: 850,
      densityScale: 0.08,
      shapeAmount: 0.9,
      shapeDetailAmount: 0.88,
      weatherExponent: 1.35,
      shapeAlteringBias: 0.38,
      coverageFilterWidth: 0.35,
      densityProfile: risingProfile,
      shadow: true
    },
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Moonlit night: 04:02 solar time, 60% coverage, dark clouds with silver edges
// lit by the moon (operator pick: variant B)
const moonlitNight: ScenePreset = {
  cloudType: 'fairWeatherCumulus',
  timeOfDay: 0.168,
  coverage: 0.6,
  exposure: 1,
  haze: false,
  moonGain: 4.5e5,
  moonColor: [0.58, 0.78, 1.35],
  skyLightScale: 0.25,
  groundBounceScale: 0.05,
  powderScale: 0.45,
  localWeatherOffset: [0.32, 0.99],
  cloudShape: {
    baseShadowStrength: 0.35,
    baseShadowHeight: 0.3
  },
  experimental: { moonlight: true },
  layers: [
    {
      channel: 'r',
      altitude: 1350,
      height: 1300,
      densityScale: 0.16,
      shapeAmount: 1,
      shapeDetailAmount: 0.92,
      weatherExponent: 1.45,
      shapeAlteringBias: 0.35,
      coverageFilterWidth: 0.32,
      densityProfile: risingProfile,
      shadow: true
    },
    inactiveLane('g'),
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Hazy: 10:51 solar time, 50% coverage, soft diffuse stratiform veil over a
// thick milky grey-blue horizon mist band (operator pick: variant A)
const hazy: ScenePreset = {
  cloudType: 'overcastSheet',
  timeOfDay: 0.452,
  coverage: 0.5,
  exposure: 1,
  haze: true,
  hazeDensityScale: 3.2e-4,
  skyLightScale: 1.1,
  powderScale: 0.4,
  localWeatherOffset: [0.21, 0.29],
  cloudShape: {
    baseShadowStrength: 0,
    erosionShape: -0.35
  },
  experimental: { cirrusDeck: true },
  cirrusDeck: {
    altitude: 9000,
    strength: 0.35,
    scale: 50000
  },
  layers: [
    {
      channel: 'r',
      altitude: 1800,
      height: 1200,
      densityScale: 0.035,
      shapeAmount: 0.75,
      shapeDetailAmount: 0.35,
      weatherExponent: 0.75,
      shapeAlteringBias: 0.38,
      coverageFilterWidth: 0.55,
      densityProfile: uniformProfile,
      shadow: false
    },
    {
      channel: 'g',
      altitude: 3600,
      height: 1000,
      densityScale: 0.015,
      shapeAmount: 0.65,
      shapeDetailAmount: 0.3,
      weatherExponent: 0.65,
      shapeAlteringBias: 0.42,
      coverageFilterWidth: 0.6,
      densityProfile: uniformProfile,
      shadow: false
    },
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Thunderstorm: 10:51 solar time, 0.52x exposure, 64% coverage, dark grey low
// storm deck with bright horizon gaps and subtle undulations overhead (operator pick: variant A)
const thunderstorm: ScenePreset = {
  cloudType: 'overcastSheet',
  timeOfDay: 0.452,
  coverage: 0.64,
  exposure: 0.52,
  haze: true,
  hazeDensityScale: 4.8e-5,
  skyLightScale: 0.55,
  groundBounceScale: 0.08,
  powderScale: 0.65,
  cloudShape: {
    baseShadowStrength: 1.2,
    baseShadowHeight: 0.45
  },
  convectiveProfile: continuousConvective,
  experimental: { convectiveProfile: true },
  layers: [
    {
      channel: 'r',
      altitude: 900,
      height: 1400,
      densityScale: 0.38,
      shapeAmount: 0.92,
      shapeDetailAmount: 0.85,
      weatherExponent: 0.95,
      shapeAlteringBias: 0.38,
      coverageFilterWidth: 0.38,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'g',
      altitude: 2300,
      height: 3000,
      densityScale: 0.16,
      shapeAmount: 0.88,
      shapeDetailAmount: 0.8,
      weatherExponent: 0.65,
      shapeAlteringBias: 0.42,
      coverageFilterWidth: 0.44,
      densityProfile: risingProfile,
      shadow: true
    },
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

// Stormy evening: 10:51 solar time, 1.00x exposure, 65% coverage, dark low
// storm cloud bank silhouetted beneath a bright pale-amber upper overcast sheet
const stormyEvening: ScenePreset = {
  cloudType: 'overcastSheet',
  timeOfDay: 0.452,
  coverage: 0.65,
  exposure: 1,
  haze: true,
  hazeDensityScale: 4.5e-5,
  skyLightScale: 0.95,
  groundBounceScale: 0.08,
  powderScale: 0.85,
  cloudShape: {
    baseShadowStrength: 0.5,
    baseShadowHeight: 0.35
  },
  layers: [
    {
      channel: 'r',
      altitude: 850,
      height: 950,
      densityScale: 0.32,
      shapeAmount: 0.96,
      shapeDetailAmount: 0.9,
      weatherExponent: 1.4,
      shapeAlteringBias: 0.34,
      coverageFilterWidth: 0.32,
      densityProfile: risingProfile,
      shadow: true
    },
    {
      channel: 'g',
      altitude: 3200,
      height: 1400,
      densityScale: 0.022,
      shapeAmount: 0.72,
      shapeDetailAmount: 0.55,
      weatherExponent: 0.4,
      shapeAlteringBias: 0.48,
      coverageFilterWidth: 0.55,
      densityProfile: topHeavyProfile,
      shadow: false
    },
    inactiveLane('b'),
    inactiveLane('a')
  ]
}

export const scenePresets: Record<ScenePresetName, ScenePreset> = {
  partlyCloudy,
  fluffy,
  pixar,
  stunningSunset,
  moonlitNight,
  hazy,
  thunderstorm,
  stormyEvening
}

export function isScenePresetName(value: unknown): value is ScenePresetName {
  return (
    typeof value === 'string' &&
    (scenePresetNames as readonly string[]).includes(value)
  )
}

/**
 * What a preset writes on the clouds side. `CloudsContext` satisfies it, and
 * so does a plain object, because every field is a property the preset already
 * knows how to set. Experimental options merge rather than replace, so a preset
 * that wants one option does not silently clear the caller's other choices.
 */
export interface ScenePresetTarget extends CloudTypePresetTarget {
  haze: boolean
  experimental: ExperimentalCloudOptions
  cloudShape?: CloudShapeParams
  convectiveProfile?: ConvectiveProfileParams
  cirrusDeck?: CirrusDeckParams
  localWeatherOffset?: { set: (x: number, y: number) => unknown }
  moonGain?: number
  moonColor?: { set: (r: number, g: number, b: number) => unknown }
  skyLightScale?: number
  groundBounceScale?: number
  powderScale?: number
  clouds?: {
    hazeDensityScale: number
  }
}

/** The instant and the place, plus where the sun and moon go */
export interface ScenePresetRequest extends TimeOfDayRequest {
  readonly sinks: CelestialSink | readonly CelestialSink[]
}

/** What a preset left behind, so a caller can light from it without recomputing */
export interface AppliedScenePreset {
  readonly preset: ScenePreset
  /** The instant the preset's time of day resolved to */
  readonly date: Date
  readonly directions: CelestialDirections
}

function applyPresetScattering(
  target: ScenePresetTarget,
  preset: ScenePreset
): void {
  if (target.moonGain !== undefined) {
    target.moonGain = preset.moonGain ?? 1
  }
  if (target.moonColor !== undefined) {
    const [r, g, b] = preset.moonColor ?? [1, 1, 1]
    target.moonColor.set(r, g, b)
  }
  if (target.skyLightScale !== undefined) {
    target.skyLightScale = preset.skyLightScale ?? 1
  }
  if (target.groundBounceScale !== undefined) {
    target.groundBounceScale = preset.groundBounceScale ?? 1
  }
  if (target.powderScale !== undefined) {
    target.powderScale = preset.powderScale ?? 0.8
  }
}

function applyPresetShapeAndHaze(
  target: ScenePresetTarget,
  preset: ScenePreset
): void {
  if (target.cloudShape !== undefined) {
    target.cloudShape = { ...cloudShapeDefaults, ...preset.cloudShape }
  }
  if (target.convectiveProfile !== undefined) {
    target.convectiveProfile = {
      ...convectiveProfileDefaults,
      ...preset.convectiveProfile
    }
  }
  if (target.cirrusDeck !== undefined && preset.cirrusDeck !== undefined) {
    Object.assign(target.cirrusDeck, preset.cirrusDeck)
  }
  if (target.localWeatherOffset !== undefined) {
    const [u, v] = preset.localWeatherOffset ?? [0, 0]
    target.localWeatherOffset.set(u, v)
  }
  if (target.clouds !== undefined) {
    target.clouds.hazeDensityScale =
      preset.hazeDensityScale ?? defaults.clouds.hazeDensityScale
  }
}

/**
 * Write a whole scene: cloud type, coverage, haze, the experimental options it
 * needs, then the sun and moon for its time of day at the caller's place. One
 * call because a preset applied halfway is a different sky, and the half that
 * is missing is the half nobody looks at.
 *
 * The cloud-type preset is applied first, so its lanes and coverage are in
 * place before this preset's layers and coverage overwrite them.
 */
export function applyScenePreset(
  target: ScenePresetTarget,
  name: ScenePresetName,
  request: ScenePresetRequest
): AppliedScenePreset {
  const preset = scenePresets[name]
  if (preset == null) {
    throw new RangeError(
      `unknown scene preset ${JSON.stringify(name)}, expected one of ${scenePresetNames.join(', ')}`
    )
  }
  const date =
    request.timeOfDay === undefined
      ? new Date(request.date)
      : resolveTimeOfDay(request.date, request.timeOfDay, request.location)
  applyCloudTypePreset(target, preset.cloudType)
  if (preset.layers != null) {
    target.cloudLayers.set(preset.layers)
  }
  target.coverage = preset.coverage
  target.haze = preset.haze
  applyPresetScattering(target, preset)
  applyPresetShapeAndHaze(target, preset)
  target.experimental = {
    ...target.experimental,
    convectiveProfile: false,
    moonlight: false,
    cirrusDeck: false,
    ...preset.experimental
  }
  const directions = syncCelestialDirections(request.sinks, {
    date,
    location: request.location
  })
  return { preset, date, directions }
}
