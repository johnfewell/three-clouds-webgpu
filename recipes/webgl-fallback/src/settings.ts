import type { Matrix4, Vector2, Vector3 } from 'three'
import type {
  CloudsPresetFields,
  ShadowPresetFields
} from 'three-clouds-webgpu'

/**
 * One settings object for both libraries. Every key is a WebGL CloudsEffect
 * property name that the WebGPU CloudsContext kept verbatim: the 66 rows the
 * migration table marks ported, so either branch is a plain assignment.
 */
export interface CloudSettings {
  coverage: number
  scatteringCoefficient: number
  absorptionCoefficient: number
  turbulenceDisplacement: number
  skyLightScale: number
  groundBounceScale: number
  powderScale: number
  powderExponent: number
  scatterAnisotropy1: number
  scatterAnisotropy2: number
  scatterAnisotropyMix: number
  correctAltitude: boolean
  resolutionScale: number
  temporalUpscale: boolean
  lightShafts: boolean
  shapeDetail: boolean
  turbulence: boolean
  haze: boolean
  localWeatherRepeat: Vector2
  localWeatherOffset: Vector2
  shapeRepeat: Vector3
  shapeOffset: Vector3
  shapeDetailRepeat: Vector3
  shapeDetailOffset: Vector3
  turbulenceRepeat: Vector2
  localWeatherVelocity: Vector2
  shapeVelocity: Vector3
  shapeDetailVelocity: Vector3
  clouds: Partial<CloudsPresetFields>
  shadow: Partial<ShadowPresetFields>
}

// A plain { x, y } or { x, y, z } is accepted wherever a vector is: the
// target's own vector copies from it
type Loose<T> = T extends Vector2
  ? Vector2 | { x: number; y: number }
  : T extends Vector3
    ? Vector3 | { x: number; y: number; z: number }
    : T

export type PartialSettings = {
  [K in keyof CloudSettings]?: K extends 'clouds' | 'shadow'
    ? { [F in keyof CloudSettings[K]]?: Loose<CloudSettings[K][F]> }
    : Loose<CloudSettings[K]>
}

/** The keys above as the migration table lists them, nested ones dotted */
export const SETTINGS_KEYS = [
  'coverage',
  'scatteringCoefficient',
  'absorptionCoefficient',
  'turbulenceDisplacement',
  'skyLightScale',
  'groundBounceScale',
  'powderScale',
  'powderExponent',
  'scatterAnisotropy1',
  'scatterAnisotropy2',
  'scatterAnisotropyMix',
  'correctAltitude',
  'resolutionScale',
  'temporalUpscale',
  'lightShafts',
  'shapeDetail',
  'turbulence',
  'haze',
  'localWeatherRepeat',
  'localWeatherOffset',
  'shapeRepeat',
  'shapeOffset',
  'shapeDetailRepeat',
  'shapeDetailOffset',
  'turbulenceRepeat',
  'localWeatherVelocity',
  'shapeVelocity',
  'shapeDetailVelocity',
  'clouds.maxIterationCount',
  'clouds.minStepSize',
  'clouds.maxStepSize',
  'clouds.maxRayDistance',
  'clouds.perspectiveStepScale',
  'clouds.minDensity',
  'clouds.minExtinction',
  'clouds.minTransmittance',
  'clouds.maxIterationCountToSun',
  'clouds.maxIterationCountToGround',
  'clouds.minSecondaryStepSize',
  'clouds.secondaryStepScale',
  'clouds.maxShadowFilterRadius',
  'clouds.maxShadowLengthIterationCount',
  'clouds.minShadowLengthStepSize',
  'clouds.maxShadowLengthRayDistance',
  'clouds.hazeDensityScale',
  'clouds.hazeExponent',
  'clouds.hazeScatteringCoefficient',
  'clouds.hazeAbsorptionCoefficient',
  'clouds.multiScatteringOctaves',
  'clouds.accurateSunSkyLight',
  'clouds.accuratePhaseFunction',
  'shadow.cascadeCount',
  'shadow.mapSize',
  'shadow.maxFar',
  'shadow.farScale',
  'shadow.splitMode',
  'shadow.splitLambda',
  'shadow.temporalPass',
  'shadow.temporalJitter',
  'shadow.maxIterationCount',
  'shadow.minStepSize',
  'shadow.maxStepSize',
  'shadow.minDensity',
  'shadow.minExtinction',
  'shadow.minTransmittance',
  'shadow.opticalDepthTailScale'
] as const

/**
 * Knobs the WebGPU port added and the WebGL original has no counterpart for.
 * A settings object may carry them. The WebGL branch warns once and ignores
 * each rather than throwing.
 */
export const PORT_ONLY_KEYS = [
  'time',
  'frame',
  'experimental',
  'debug',
  'cloudTypes',
  'qualityGovernor'
] as const

export type Backend = 'webgpu' | 'webgl'

// The WebGL original stores splitMode as a name, the port as an index
const SPLIT_MODE_NAMES = ['uniform', 'logarithmic', 'practical'] as const

interface Copyable {
  copy: (value: unknown) => unknown
}

function isCopyable(value: unknown): value is Copyable {
  return (
    typeof value === 'object' &&
    value != null &&
    typeof (value as { copy?: unknown }).copy === 'function'
  )
}

function write(target: Record<string, unknown>, key: string, value: unknown) {
  const current = target[key]
  if (isCopyable(current) && typeof value === 'object' && value != null) {
    current.copy(value)
  } else {
    target[key] = value
  }
}

const warned = new Set<string>()

/**
 * Write a settings object onto either library's clouds object: a WebGL
 * `CloudsEffect` or a WebGPU `CloudsContext`. Vectors and matrices are copied
 * into the target's own instances, nested `clouds` and `shadow` fields are
 * written one by one, and the WebGL branch ignores port-only keys with one
 * warning per key.
 */
export function applySettings(
  target: object,
  settings: PartialSettings & Partial<Record<string, unknown>>,
  backend: Backend
): void {
  const bag = target as Record<string, unknown>
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue
    if ((PORT_ONLY_KEYS as readonly string[]).includes(key)) {
      if (backend === 'webgl') {
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(
            `[clouds] "${key}" is a WebGPU-only setting; the WebGL fallback ignores it`
          )
        }
        continue
      }
      write(bag, key, value)
      continue
    }
    if (key === 'clouds' || key === 'shadow') {
      const nested = bag[key] as Record<string, unknown> | undefined
      if (nested == null) continue
      for (const [field, fieldValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (fieldValue === undefined) continue
        if (key === 'shadow' && field === 'splitMode' && backend === 'webgl') {
          nested[field] =
            typeof fieldValue === 'number'
              ? (SPLIT_MODE_NAMES[fieldValue] ?? 'practical')
              : fieldValue
          continue
        }
        write(nested, field, fieldValue)
      }
      continue
    }
    write(bag, key, value)
  }
}

export type { Matrix4 }
