// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Vector2 } from 'three'

/**
 * The bundled presets. A preset is a whole set of fields, not a rank:
 * setting one overwrites every field it names, so mix presets by applying two
 * and then setting the fields you care about. `lowEnd` is a fallback for
 * low-end or contended GPUs, not a look, and is never the default.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'lowEnd'

/** The march-side fields a preset sets, grouped as the reference groups them */
export interface CloudsPresetFields {
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

/** The shadow-map fields a preset sets */
export interface ShadowPresetFields {
  cascadeCount: number
  mapSize: Vector2
  // null is the reference's effective value: CloudsEffect.ts:250-254 builds
  // CascadedShadowMaps with cascadeCount/mapSize/splitLambda only, so maxFar
  // keeps its class default and the shadow range is camera.far * farScale
  maxFar: number | null
  farScale: number
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
  // Port-only: render the cloud shadow map every N frames (1 is the
  // reference). The default 2 halves the largest cloud cost, and the ~100-frame
  // accumulation hides it except a one-frame lag at a moving view's edge
  updateInterval: number
}

/**
 * What a preset needs to write into, which `CloudsContext` implements. A plain
 * object with these members works too.
 */
export interface QualityPresetTarget {
  resolutionScale: number
  lightShafts: boolean
  shapeDetail: boolean
  turbulence: boolean
  haze: boolean
  temporalUpscale?: boolean
  lightShaftsHalfResolution?: boolean
  clouds: CloudsPresetFields
  shadow: ShadowPresetFields
}

const appliedQualityPresets = new WeakMap<QualityPresetTarget, QualityPreset>()

export function getAppliedQualityPreset(
  target: QualityPresetTarget
): QualityPreset | undefined {
  return appliedQualityPresets.get(target)
}

/** One complete set of preset values */
export interface QualityPresetValues {
  resolutionScale: number
  lightShafts: boolean
  shapeDetail: boolean
  turbulence: boolean
  haze: boolean
  // Only lowEnd sets these. The four original presets leave the target's
  // own value alone, as they always have
  temporalUpscale?: boolean
  lightShaftsHalfResolution?: boolean
  clouds: CloudsPresetFields
  shadow: ShadowPresetFields
}

/**
 * The four key lists partition `CloudsContext.clouds` and
 * `CloudsContext.shadow` by which uniform block each field reaches, which is
 * what decides whether a change is a plain uniform write or a graph rebuild.
 * They are exported so a caller can drive a preset field it does not know by
 * name, and the parity harness enumerates the same partition.
 */

/** `clouds` fields that are march uniforms, rewritten every frame */
export const cloudsUniformKeys = [
  'maxIterationCount',
  'minStepSize',
  'maxStepSize',
  'maxRayDistance',
  'perspectiveStepScale',
  'minDensity',
  'minExtinction',
  'minTransmittance',
  'maxIterationCountToSun',
  'maxIterationCountToGround',
  'minSecondaryStepSize',
  'secondaryStepScale',
  'maxShadowFilterRadius',
  'maxShadowLengthIterationCount',
  'minShadowLengthStepSize',
  'maxShadowLengthRayDistance',
  'hazeDensityScale',
  'hazeExponent',
  'hazeScatteringCoefficient',
  'hazeAbsorptionCoefficient'
] as const

/**
 * `clouds` fields that are compile-time material parameters, so a change
 * rebuilds the graph
 */
export const cloudsMaterialParameterKeys = [
  'multiScatteringOctaves',
  'accurateSunSkyLight',
  'accuratePhaseFunction'
] as const

/** `shadow` fields that are per-frame shadow-march uniforms */
export const shadowUniformKeys = [
  'maxIterationCount',
  'minStepSize',
  'maxStepSize',
  'minDensity',
  'minExtinction',
  'minTransmittance',
  'opticalDepthTailScale'
] as const

/** `shadow` field that is a compile-time material parameter */
export const shadowMaterialParameterKeys = ['temporalJitter'] as const

/** `shadow` field that configures the resolve pass rather than the march */
export const shadowPassParameterKeys = ['temporalPass'] as const

/** `shadow` fields owned by the cascaded shadow maps rather than the pass */
export const shadowMapsParameterKeys = [
  'cascadeCount',
  'mapSize',
  'maxFar',
  'farScale',
  'splitMode',
  'splitLambda'
] as const

const values: QualityPresetValues = {
  resolutionScale: 1,
  lightShafts: true,
  shapeDetail: true,
  turbulence: true,
  haze: true,
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
    mapSize: /*#__PURE__*/ new Vector2(512, 512),
    // Cite: CloudsEffect.ts:250-254, which passes cascadeCount, mapSize and
    // splitLambda only, so the reference keeps the null default. A cap here
    // shrank cascade 0 ~1700x and disarmed the ground PCF
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

/**
 * The values `high` is. Every `CloudsContext` starts from these, and a
 * preset spreads them, so this object is the single place a default is written.
 */
export const defaults: QualityPresetValues = values

// eslint-disable-next-line no-comment-slop/no-trailing-period -- verbatim upstream TODO
// TODO(port): We cloud decrease multi-scattering octaves for lower quality presets, but it leads to a loss of higher frequency scattering, making it darker overall, which suggests the need for a fudge factor to scale the radiance.
/**
 * Every bundled preset. `high` is {@link defaults} itself, so the object is
 * shared and must not be mutated by a caller.
 *
 * Use {@link applyQualityPreset}, or set `CloudsContext.qualityPreset`, rather
 * than assigning a preset onto the context: the graph-shape fields
 * (`multiScatteringOctaves`, `accurateSunSkyLight`, `accuratePhaseFunction`)
 * use forwarding setters on `CloudsContext.clouds` to bump `graphVersion`.
 */
export const qualityPresets: Record<QualityPreset, QualityPresetValues> = {
  low: {
    ...defaults,
    lightShafts: false,
    shapeDetail: false,
    turbulence: false,
    clouds: {
      ...defaults.clouds,
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
      ...defaults.shadow,
      maxIterationCount: 25,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      minTransmittance: 1e-2,
      cascadeCount: 2,
      mapSize: /*#__PURE__*/ new Vector2(256, 256)
    }
  },
  medium: {
    ...defaults,
    lightShafts: false,
    turbulence: false,
    clouds: {
      ...defaults.clouds,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      accurateSunSkyLight: false,
      maxIterationCountToSun: 2,
      maxIterationCountToGround: 1
    },
    shadow: {
      ...defaults.shadow,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      mapSize: /*#__PURE__*/ new Vector2(256, 256)
    }
  },
  high: defaults,
  ultra: {
    ...defaults,
    clouds: {
      ...defaults.clouds,
      minStepSize: 10
    },
    shadow: {
      ...defaults.shadow,
      mapSize: /*#__PURE__*/ new Vector2(1024, 1024)
    }
  },
  // The perf map's c4, judged 2026-10-09 as acceptable only as a fallback for
  // low-end or contended GPUs. Opt-in, never the default
  lowEnd: {
    ...defaults,
    resolutionScale: 0.5,
    temporalUpscale: true,
    lightShaftsHalfResolution: true,
    turbulence: false,
    haze: false,
    clouds: {
      ...defaults.clouds,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      accurateSunSkyLight: false,
      maxIterationCountToSun: 0,
      maxIterationCountToGround: 0,
      minStepSize: 200
    },
    shadow: {
      ...defaults.shadow,
      minDensity: 1e-4,
      minExtinction: 1e-4,
      cascadeCount: 1,
      updateInterval: 4,
      mapSize: /*#__PURE__*/ new Vector2(128, 128)
    }
  }
}

/**
 * Write every field of one preset onto a target, in place. The top-level
 * props go to the target itself, `clouds` and `shadow` into its two shorthand
 * objects. Copies map dimensions into the target's own vector.
 *
 * On a `CloudsContext`, this also records the last applied preset. Later
 * overrides leave that name unchanged. An unknown name throws `RangeError`
 * listing the supported presets before any configuration changes.
 *
 * @remarks
 * Domain: the keys of qualityPresets, applied before local overrides
 * Mutation: uses context setters, changed graph fields invalidate history
 * Ownership: copies mapSize values without sharing the preset's mutable vector
 */
export function applyQualityPreset(
  target: QualityPresetTarget,
  name: QualityPreset
): void {
  if (typeof name !== 'string' || !Object.hasOwn(qualityPresets, name)) {
    throw new RangeError(
      `Unknown quality preset ${JSON.stringify(name)}; ` +
        `expected one of: ${Object.keys(qualityPresets).join(', ')}`
    )
  }
  writeQualityPresetValues(target, qualityPresets[name])
  appliedQualityPresets.set(target, name)
}

/**
 * Write one complete value set onto a target the way a preset does, without
 * recording a preset name. The governor's level 1 and its level 0 restore use
 * it, and `applyQualityPreset` is this plus the name.
 */
export function writeQualityPresetValues(
  target: QualityPresetTarget,
  values: QualityPresetValues
): void {
  const { clouds, shadow, ...props } = values
  const { mapSize, ...shadowFields } = shadow
  Object.assign(target, props)
  Object.assign(target.clouds, clouds)
  Object.assign(target.shadow, shadowFields)
  target.shadow.mapSize.copy(mapSize)
}
