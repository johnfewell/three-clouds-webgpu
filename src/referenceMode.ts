// Reference mode: the port's knobs on the original's behaviour
//
// Not ported code, and it has no upstream counterpart, because the values below
// are deviations the port invented. Design and evidence:
// docs/design/standalone-defaults.md §7

import type { CloudsContext } from './CloudsContext'
import { cloudShapeKey, type CloudShapeParams } from './experimental/cloudShape'
import {
  experimentalDefaults,
  type ExperimentalCloudOptions
} from './experimental/options'
import { defaults } from './qualityPresets'

// The port marches light shafts once per 2x2 quad of march fragments when the
// device offers subgroups, and ships that on. The reference marches per
// fragment (cloudsFragment.ts:139-152)
export const PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION = true

// The reference renders and resolves the cloud shadow map on every update
// (ShadowPass.ts:124-140). The port's cadence default is
// defaults.shadow.updateInterval, which is 2
export const REFERENCE_SHADOW_UPDATE_INTERVAL = 1

// Every experimental option is off: the original has none. Written out, never
// spread from experimentalDefaults, because a spread is a remembered copy and
// the first promotion moved the ladder with it
export const REFERENCE_EXPERIMENTAL: Readonly<ExperimentalCloudOptions> =
  Object.freeze({
    cloudFrontRefinement: false,
    computeResolve: false,
    windReprojection: false,
    distantCloudShadows: false,
    directionalSkylight: false,
    distantShapeDetailFade: false,
    cloudTypeMap: false,
    evolvingWeather: false,
    proceduralWeather: false,
    convectiveProfile: false,
    rainShafts: false,
    moonlight: false,
    lightning: false,
    cloudEnvironment: false,
    staticMode: false,
    cirrusDeck: false,
    shadowRoundRobin: false
  })

// Every shape control is zero: the original has none of the four. Written out
// rather than spread from cloudShapeDefaults, for the reason above
export const REFERENCE_CLOUD_SHAPE: Readonly<CloudShapeParams> = Object.freeze({
  baseShadowStrength: 0,
  baseShadowHeight: 0.3,
  horizonCoverageAmount: 0,
  horizonCoverageStart: 8000,
  horizonCoverageRamp: 40000,
  windSkewEast: 0,
  windSkewNorth: 0,
  erosionShape: 0
})

export interface ReferenceModePins {
  readonly shadowUpdateInterval: number
  readonly lightShaftsHalfResolution: boolean
  readonly experimental: ExperimentalCloudOptions
  readonly cloudShape: Readonly<CloudShapeParams>
}

export const REFERENCE_MODE: ReferenceModePins = Object.freeze({
  shadowUpdateInterval: REFERENCE_SHADOW_UPDATE_INTERVAL,
  lightShaftsHalfResolution: false,
  experimental: REFERENCE_EXPERIMENTAL,
  cloudShape: REFERENCE_CLOUD_SHAPE
})

// Every path applyReferenceMode writes, as a consumer reads it. A port-only
// default missing from this list is one reference mode silently fails to pin,
// so the tests assert this list and the writes agree in both directions
export const REFERENCE_MODE_PORT_ONLY_PATHS: readonly string[] = Object.freeze([
  'shadow.updateInterval',
  'lightShaftsHalfResolution',
  // One write, so one path: the knobs are a plain object a caller assigns
  'cloudShape',
  ...Object.keys(experimentalDefaults).map(key => `experimental.${key}`)
])

// What the context currently holds on the port-only paths. Same shape as
// REFERENCE_MODE, so a caller can compare the two field by field
export function referenceModePins(ctx: CloudsContext): ReferenceModePins {
  return {
    shadowUpdateInterval: ctx.shadow.updateInterval,
    lightShaftsHalfResolution: ctx.lightShaftsHalfResolution,
    experimental: { ...ctx.experimental },
    cloudShape: { ...ctx.cloudShape }
  }
}

// Write-through, not an override layer: plain assignments, so this is exactly
// what a caller could have set by hand. One-way, because the values to restore
// move with the library's defaults
export function applyReferenceMode(ctx: CloudsContext): boolean {
  let changed = false
  // A governor's next step would overwrite the pins below, so it goes first
  if (ctx.qualityGovernor?.enabled === true) {
    ctx.qualityGovernor.disarm()
    changed = true
  }
  if (ctx.shadow.updateInterval !== REFERENCE_MODE.shadowUpdateInterval) {
    ctx.shadow.updateInterval = REFERENCE_MODE.shadowUpdateInterval
    changed = true
  }
  if (
    ctx.lightShaftsHalfResolution !== REFERENCE_MODE.lightShaftsHalfResolution
  ) {
    ctx.lightShaftsHalfResolution = REFERENCE_MODE.lightShaftsHalfResolution
    changed = true
  }
  // Assigned unconditionally: the setter merges, so it is already idempotent
  ctx.experimental = { ...REFERENCE_MODE.experimental }
  if (cloudShapeKey(ctx.cloudShape) !== cloudShapeKey(REFERENCE_CLOUD_SHAPE)) {
    ctx.cloudShape = { ...REFERENCE_CLOUD_SHAPE }
    changed = true
  }
  return changed
}

// The way back out, reading the port's defaults so a default change moves this
// with it. A caller's own option is left alone, unless reference mode holds it
// away from the library default, which the way back then has to undo
export function applyPortDefaults(ctx: CloudsContext): boolean {
  let changed = false
  const interval = defaults.shadow.updateInterval
  if (ctx.shadow.updateInterval !== interval) {
    ctx.shadow.updateInterval = interval
    changed = true
  }
  if (
    ctx.lightShaftsHalfResolution !== PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION
  ) {
    ctx.lightShaftsHalfResolution = PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION
    changed = true
  }
  const restore: Partial<ExperimentalCloudOptions> = {}
  for (const key of Object.keys(experimentalDefaults) as Array<
    keyof ExperimentalCloudOptions
  >) {
    if (
      REFERENCE_EXPERIMENTAL[key] !== experimentalDefaults[key] &&
      ctx.experimental[key] !== experimentalDefaults[key]
    ) {
      restore[key] = experimentalDefaults[key]
    }
  }
  if (Object.keys(restore).length > 0) {
    ctx.experimental = { ...ctx.experimental, ...restore }
    changed = true
  }
  return changed
}
