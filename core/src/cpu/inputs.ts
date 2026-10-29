// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: src/CloudsContext.ts fields, src/qualityPresets.ts, src/CloudLayers.ts
// The CPU knobs as plain data, with the port's defaults. A fresh object
// equals a fresh CloudsContext field for field (inputs.test.ts)

import { Ellipsoid } from './geodesy'
import { Mat4, Vec2, Vec3 } from './math'

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'lowEnd'

export interface CloudsQuality {
  multiScatteringOctaves: number
  accurateSunSkyLight: boolean
  accuratePhaseFunction: boolean
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  maxRayDistance: number
  perspectiveStepScale: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  maxIterationCountToGround: number
  maxIterationCountToSun: number
  minSecondaryStepSize: number
  secondaryStepScale: number
  maxShadowFilterRadius: number
  maxShadowLengthIterationCount: number
  minShadowLengthStepSize: number
  maxShadowLengthRayDistance: number
  hazeDensityScale: number
  hazeExponent: number
  hazeScatteringCoefficient: number
  hazeAbsorptionCoefficient: number
}

export interface ShadowQuality {
  cascadeCount: number
  mapSize: Vec2
  maxFar: number | null
  farScale: number
  // 0 uniform, 1 logarithmic, 2 practical, as CloudsContext stores it
  splitMode: number
  splitLambda: number
  temporalPass: boolean
  temporalJitter: boolean
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  opticalDepthTailScale: number
  updateInterval: number
}

export interface DensityProfileValues {
  expTerm: number
  exponent: number
  linearTerm: number
  constantTerm: number
}

export interface CloudLayerValues {
  channel: 'r' | 'g' | 'b' | 'a'
  altitude: number
  height: number
  densityScale: number
  shapeAmount: number
  shapeDetailAmount: number
  weatherExponent: number
  shapeAlteringBias: number
  coverageFilterWidth: number
  densityProfile: DensityProfileValues
  shadow: boolean
}

export interface CloudsInputs {
  // Frame
  time: number
  frame: number
  temporalUpscale: boolean
  resolutionScale: number
  lightShafts: boolean
  shapeDetail: boolean
  turbulence: boolean
  haze: boolean

  // Frame of reference and atmosphere
  readonly worldToECEFMatrix: Mat4
  ellipsoid: Ellipsoid
  bottomRadius: number
  correctAltitude: boolean

  // Light. moonlight is experimental.moonlight
  readonly sunDirection: Vec3
  readonly moonDirection: Vec3
  moonGain: number
  readonly moonColor: Vec3
  moonlight: boolean

  // Appearance
  coverage: number
  scatteringCoefficient: number
  absorptionCoefficient: number
  turbulenceDisplacement: number
  skyLightScale: number
  groundBounceScale: number
  powderScale: number
  powderExponent: number

  // Texture placement and wind
  readonly localWeatherRepeat: Vec2
  readonly shapeRepeat: Vec3
  readonly shapeDetailRepeat: Vec3
  readonly turbulenceRepeat: Vec2
  readonly localWeatherOffset: Vec2
  readonly shapeOffset: Vec3
  readonly shapeDetailOffset: Vec3
  readonly localWeatherVelocity: Vec2
  readonly shapeVelocity: Vec3
  readonly shapeDetailVelocity: Vec3

  readonly cloudLayers: [
    CloudLayerValues,
    CloudLayerValues,
    CloudLayerValues,
    CloudLayerValues
  ]
  readonly clouds: CloudsQuality
  readonly shadow: ShadowQuality
}

// The `high` preset, which every CloudsContext starts from
function highQuality(): { clouds: CloudsQuality; shadow: ShadowQuality } {
  return {
    clouds: {
      multiScatteringOctaves: 8,
      accurateSunSkyLight: true,
      accuratePhaseFunction: false,
      maxIterationCount: 500,
      minStepSize: 50,
      maxStepSize: 1000,
      maxRayDistance: 2e5,
      perspectiveStepScale: 1.01,
      minDensity: 1e-5,
      minExtinction: 1e-5,
      minTransmittance: 1e-2,
      maxIterationCountToGround: 3,
      maxIterationCountToSun: 2,
      minSecondaryStepSize: 100,
      secondaryStepScale: 2,
      maxShadowFilterRadius: 6,
      maxShadowLengthIterationCount: 500,
      minShadowLengthStepSize: 50,
      maxShadowLengthRayDistance: 2e5,
      hazeDensityScale: 3e-5,
      hazeExponent: 1e-3,
      hazeScatteringCoefficient: 0.9,
      hazeAbsorptionCoefficient: 0.5
    },
    shadow: {
      cascadeCount: 3,
      mapSize: new Vec2(512, 512),
      maxFar: null,
      farScale: 1,
      splitMode: 2,
      splitLambda: 0.6,
      temporalPass: true,
      temporalJitter: true,
      maxIterationCount: 50,
      minStepSize: 100,
      maxStepSize: 1000,
      minDensity: 1e-5,
      minExtinction: 1e-5,
      minTransmittance: 1e-4,
      opticalDepthTailScale: 2,
      updateInterval: 2
    }
  }
}

interface PresetDelta {
  lightShafts?: boolean
  shapeDetail?: boolean
  turbulence?: boolean
  haze?: boolean
  resolutionScale?: number
  // only lowEnd sets it, the others leave the input's own value
  temporalUpscale?: boolean
  clouds?: Partial<CloudsQuality>
  shadow?: Partial<Omit<ShadowQuality, 'mapSize'>> & { mapSize?: number }
}

// What each preset changes from `high`
const PRESET_DELTAS: Record<QualityPreset, PresetDelta> = {
  low: {
    lightShafts: false,
    shapeDetail: false,
    turbulence: false,
    clouds: {
      accurateSunSkyLight: false,
      maxIterationCount: 200,
      minStepSize: 100,
      maxRayDistance: 1e5,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      minTransmittance: 1e-1,
      maxIterationCountToGround: 0,
      maxIterationCountToSun: 1
    },
    shadow: {
      maxIterationCount: 25,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      minTransmittance: 1e-2,
      cascadeCount: 2,
      mapSize: 256
    }
  },
  medium: {
    lightShafts: false,
    turbulence: false,
    clouds: {
      minDensity: 1e-4,
      minExtinction: 1e-4,
      accurateSunSkyLight: false,
      maxIterationCountToSun: 2,
      maxIterationCountToGround: 1
    },
    shadow: { minDensity: 1e-4, minExtinction: 1e-4, mapSize: 256 }
  },
  high: {},
  ultra: { clouds: { minStepSize: 10 }, shadow: { mapSize: 1024 } },
  lowEnd: {
    resolutionScale: 0.5,
    temporalUpscale: true,
    turbulence: false,
    haze: false,
    clouds: {
      minDensity: 1e-4,
      minExtinction: 1e-4,
      accurateSunSkyLight: false,
      maxIterationCountToSun: 0,
      maxIterationCountToGround: 0,
      minStepSize: 200
    },
    shadow: {
      minDensity: 1e-4,
      minExtinction: 1e-4,
      cascadeCount: 1,
      updateInterval: 4,
      mapSize: 128
    }
  }
}

// applyQualityPreset: every field the preset names, written in place. A
// preset is a whole set, so it resets what another preset changed
export function applyQualityPreset(
  inputs: CloudsInputs,
  name: QualityPreset
): CloudsInputs {
  const high = highQuality()
  const delta = PRESET_DELTAS[name]
  inputs.resolutionScale = delta.resolutionScale ?? 1
  inputs.lightShafts = delta.lightShafts ?? true
  inputs.shapeDetail = delta.shapeDetail ?? true
  inputs.turbulence = delta.turbulence ?? true
  inputs.haze = delta.haze ?? true
  if (delta.temporalUpscale !== undefined)
    inputs.temporalUpscale = delta.temporalUpscale
  Object.assign(inputs.clouds, high.clouds, delta.clouds)
  const { mapSize, ...shadowDelta } = delta.shadow ?? {}
  Object.assign(inputs.shadow, high.shadow, shadowDelta, {
    mapSize: inputs.shadow.mapSize
  })
  const size = mapSize ?? high.shadow.mapSize.x
  inputs.shadow.mapSize.set(size, size)
  return inputs
}

function layer(values: Partial<CloudLayerValues>): CloudLayerValues {
  return {
    channel: 'r',
    altitude: 0,
    height: 0,
    densityScale: 0.2,
    shapeAmount: 1,
    shapeDetailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    shadow: false,
    ...values,
    densityProfile: {
      expTerm: 0,
      exponent: 0,
      linearTerm: 0.75,
      constantTerm: 0.25,
      ...values.densityProfile
    }
  }
}

// CloudLayers.DEFAULT
export function defaultCloudLayers(): CloudsInputs['cloudLayers'] {
  return [
    layer({ channel: 'r', altitude: 750, height: 650, shadow: true }),
    layer({ channel: 'g', altitude: 1000, height: 1200, shadow: true }),
    layer({
      channel: 'b',
      altitude: 7500,
      height: 500,
      densityScale: 0.003,
      shapeAmount: 0.4,
      shapeDetailAmount: 0,
      coverageFilterWidth: 0.5
    }),
    layer({ channel: 'a' })
  ]
}

export function createCloudsInputs(): CloudsInputs {
  const { clouds, shadow } = highQuality()
  return {
    time: 0,
    frame: 0,
    temporalUpscale: true,
    resolutionScale: 1,
    lightShafts: true,
    shapeDetail: true,
    turbulence: true,
    haze: true,
    worldToECEFMatrix: new Mat4(),
    ellipsoid: Ellipsoid.WGS84,
    bottomRadius: 6360000,
    correctAltitude: true,
    sunDirection: new Vec3(),
    moonDirection: new Vec3(),
    moonGain: 1,
    moonColor: new Vec3(1, 1, 1),
    moonlight: false,
    coverage: 0.3,
    scatteringCoefficient: 1,
    absorptionCoefficient: 0,
    turbulenceDisplacement: 350,
    skyLightScale: 1,
    groundBounceScale: 1,
    powderScale: 0.8,
    powderExponent: 150,
    localWeatherRepeat: new Vec2(100, 100),
    shapeRepeat: new Vec3(0.0003, 0.0003, 0.0003),
    shapeDetailRepeat: new Vec3(0.006, 0.006, 0.006),
    turbulenceRepeat: new Vec2(20, 20),
    localWeatherOffset: new Vec2(),
    shapeOffset: new Vec3(),
    shapeDetailOffset: new Vec3(),
    localWeatherVelocity: new Vec2(),
    shapeVelocity: new Vec3(),
    shapeDetailVelocity: new Vec3(),
    cloudLayers: defaultCloudLayers(),
    clouds,
    shadow
  }
}
