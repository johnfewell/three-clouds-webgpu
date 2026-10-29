import { Matrix4, Vector2, type Vector3 } from 'three'
import {
  qualityPresets,
  REFERENCE_MODE,
  type ExperimentalCloudOptions
} from 'three-clouds-webgpu'

import { effectiveState, type CaseDefinition } from '../cases/index'
import { asDebugView } from './debugViews'
import type { ParityCamera } from './parityCamera'
import { applyDebugView, type SideAHandle } from './sideA'
import type { SideBHandle } from './sideB'

export interface ParityKnobs {
  // the layer COUNT reaches the sides as a knob, not a PARITY_KEYS
  // entry, because applying it means rewriting four layer slots rather than
  // assigning one property
  layers: number
  haze: boolean
  maxIterationCountToGround: number
  shadow: boolean
  lightShafts: boolean
  temporalUpscale: boolean
  accuratePhaseFunction: boolean
  debug: string
  enabled: boolean
}

// ADR-011: later-phase features OFF. `enabled` is a phase-0 key and stays ON: a
// disabled side B draws only the atmosphere plate
export const NEUTRALISED_KNOBS: ParityKnobs = {
  layers: 3,
  haze: false,
  maxIterationCountToGround: 0,
  shadow: false,
  lightShafts: false,
  temporalUpscale: false,
  accuratePhaseFunction: false,
  debug: 'none',
  enabled: true
}

export interface ParityCase {
  name: string
  width: number
  height: number
  pixelRatio: number
  time: number
  frame: number
  warmup: number
  sun: { elevation: number; azimuth: number }
  camera: (cam: ParityCamera) => void
  // The world→ECEF frame both sides install on every consumer (case 28
  // `ecef-rotated`; identity everywhere else). ADR-011: pinned explicitly, not
  // defaulted, so neither side can silently keep a stale frame
  worldToECEF: Matrix4
  knobs: Partial<ParityKnobs>
  lighting: 'post' | 'lights'
}

export const PHASE0_CASES: ParityCase[] = [
  {
    name: 'baseline-medium',
    width: 1280,
    height: 720,
    pixelRatio: 1,
    time: 0,
    frame: 0,
    warmup: 64,
    sun: { elevation: 45, azimuth: 180 },
    camera: cam => {
      cam.position.set(0, 6438137, 0)
      cam.lookAt(0, 6358137, 0)
    },
    worldToECEF: new Matrix4(),
    knobs: { ...NEUTRALISED_KNOBS },
    lighting: 'post'
  },
  {
    name: 'orbit-140km',
    width: 320,
    height: 180,
    pixelRatio: 1,
    time: 0,
    frame: 0,
    warmup: 64,
    sun: { elevation: 45, azimuth: 180 },
    camera: cam => {
      cam.position.set(0, 6378137 + 140000, 0)
      cam.lookAt(0, 6378137, 0)
    },
    worldToECEF: new Matrix4(),
    knobs: { ...NEUTRALISED_KNOBS },
    lighting: 'post'
  },
  {
    name: 'inside-deck',
    width: 320,
    height: 180,
    pixelRatio: 1,
    time: 0,
    frame: 0,
    warmup: 64,
    sun: { elevation: 45, azimuth: 180 },
    camera: cam => {
      cam.position.set(0, 6378137 + 5000, 0)
      cam.lookAt(6378137 + 5000, 0, 0)
    },
    worldToECEF: new Matrix4(),
    knobs: { ...NEUTRALISED_KNOBS },
    lighting: 'post'
  },
  {
    name: 'baseline-low',
    width: 1280,
    height: 720,
    pixelRatio: 1,
    time: 0,
    frame: 0,
    warmup: 64,
    // azimuth 90 put the sun BELOW the horizon here, so every capture
    // measured a black frame (measured: baseline-medium's sun fixed it, camera
    // changes did not). Elevation stays 30, distinct from baseline-medium's 45
    sun: { elevation: 30, azimuth: 180 },
    camera: cam => {
      cam.position.set(0, 6378137 + 8000, 0)
      cam.lookAt(0, 6358137, 0)
    },
    worldToECEF: new Matrix4(),
    knobs: { ...NEUTRALISED_KNOBS },
    lighting: 'post'
  },
  {
    name: 'surface-up',
    width: 1280,
    height: 720,
    pixelRatio: 1,
    time: 0,
    frame: 0,
    warmup: 64,
    sun: { elevation: 60, azimuth: 0 },
    camera: cam => {
      cam.position.set(0, 6378137 + 100, 0)
      cam.lookAt(0, 6378137 + 50000, 0)
    },
    worldToECEF: new Matrix4(),
    knobs: { ...NEUTRALISED_KNOBS },
    lighting: 'post'
  },
  {
    name: 'horizon-graze',
    width: 1280,
    height: 720,
    pixelRatio: 1,
    time: 0,
    frame: 0,
    warmup: 64,
    sun: { elevation: 5, azimuth: 270 },
    camera: cam => {
      cam.position.set(0, 6378137 + 8000, 0)
      cam.lookAt(6378137, 0, 0)
    },
    worldToECEF: new Matrix4(),
    knobs: { ...NEUTRALISED_KNOBS },
    lighting: 'post'
  }
]

// ── ParityState + PARITY_KEYS + adapters ──
// Outside the key loop, each applied where noted: camera, sun, worldToECEF,
// enabled, time/frame, textures, warmup, temporalAntialiasing (B-only)

export interface ParityStateClouds {
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  maxRayDistance: number
  perspectiveStepScale: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  maxIterationCountToSun: number
  maxIterationCountToGround: number
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
  multiScatteringOctaves: number
  accurateSunSkyLight: boolean
  accuratePhaseFunction: boolean
}

export interface ParityStateShadow {
  cascadeCount: number
  mapSize: Vector2
  // null on BOTH sides: the reference never sets maxFar either, so its CSM
  // keeps CascadedShadowMaps' own null default
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
  // Port-only, side B only. The value is REFERENCE_MODE.shadowUpdateInterval,
  // applied at case load so the ladder runs at the reference's cadence whatever
  // the public default is (ADR-011)
  updateInterval?: number
}

export interface ParityState {
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

  // Outside PARITY_KEYS (the sides disable clouds differently), but typed on
  // ParityState so `probe.set({enabled})` is checked: through an `any` cast it
  // silently did nothing on both sides (test 12)
  enabled: boolean

  // Reference mode, side B only, pinned at case load so the ladder cannot move
  // when a public default does (docs/design/standalone-defaults.md §7). Not
  // PARITY_KEYS: side A has no counterpart and `set()` must move one on purpose
  lightShaftsHalfResolution?: boolean
  experimental?: ExperimentalCloudOptions

  // Same shape as `enabled`: both sides apply it, by different mechanisms, and
  // neither was reachable through set(). Case setup was the only path in
  debug: string

  clouds: ParityStateClouds
  shadow: ParityStateShadow
}

export type ParityKeyPhase = 0 | 1 | 2 | 3 | 4

export interface ParityKeyEntry {
  key: string
  phase: ParityKeyPhase
  type: 'scalar' | 'boolean' | 'vector2' | 'vector3' | 'matrix4'
  nested?: 'clouds' | 'shadow'
}

export const PARITY_KEYS: readonly ParityKeyEntry[] = [
  { key: 'coverage', phase: 1, type: 'scalar' },
  { key: 'scatteringCoefficient', phase: 1, type: 'scalar' },
  { key: 'absorptionCoefficient', phase: 1, type: 'scalar' },
  { key: 'turbulenceDisplacement', phase: 1, type: 'scalar' },
  { key: 'skyLightScale', phase: 1, type: 'scalar' },
  { key: 'groundBounceScale', phase: 4, type: 'scalar' },
  { key: 'powderScale', phase: 1, type: 'scalar' },
  { key: 'powderExponent', phase: 1, type: 'scalar' },
  { key: 'scatterAnisotropy1', phase: 4, type: 'scalar' },
  { key: 'scatterAnisotropy2', phase: 4, type: 'scalar' },
  { key: 'scatterAnisotropyMix', phase: 4, type: 'scalar' },
  { key: 'correctAltitude', phase: 1, type: 'boolean' },

  { key: 'resolutionScale', phase: 1, type: 'scalar' },
  { key: 'temporalUpscale', phase: 2, type: 'boolean' },
  { key: 'lightShafts', phase: 3, type: 'boolean' },
  { key: 'shapeDetail', phase: 1, type: 'boolean' },
  { key: 'turbulence', phase: 1, type: 'boolean' },
  { key: 'haze', phase: 4, type: 'boolean' },

  { key: 'localWeatherRepeat', phase: 1, type: 'vector2' },
  { key: 'localWeatherOffset', phase: 1, type: 'vector2' },
  { key: 'shapeRepeat', phase: 1, type: 'vector3' },
  { key: 'shapeOffset', phase: 1, type: 'vector3' },
  { key: 'shapeDetailRepeat', phase: 1, type: 'vector3' },
  { key: 'shapeDetailOffset', phase: 1, type: 'vector3' },
  { key: 'turbulenceRepeat', phase: 1, type: 'vector2' },
  { key: 'localWeatherVelocity', phase: 1, type: 'vector2' },
  { key: 'shapeVelocity', phase: 1, type: 'vector3' },
  { key: 'shapeDetailVelocity', phase: 1, type: 'vector3' },

  { key: 'maxIterationCount', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'minStepSize', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'maxStepSize', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'maxRayDistance', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'perspectiveStepScale', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'minDensity', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'minExtinction', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'minTransmittance', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'maxIterationCountToSun', phase: 1, type: 'scalar', nested: 'clouds' },
  {
    key: 'maxIterationCountToGround',
    phase: 1,
    type: 'scalar',
    nested: 'clouds'
  },
  { key: 'minSecondaryStepSize', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'secondaryStepScale', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'maxShadowFilterRadius', phase: 3, type: 'scalar', nested: 'clouds' },
  {
    key: 'maxShadowLengthIterationCount',
    phase: 3,
    type: 'scalar',
    nested: 'clouds'
  },
  {
    key: 'minShadowLengthStepSize',
    phase: 3,
    type: 'scalar',
    nested: 'clouds'
  },
  {
    key: 'maxShadowLengthRayDistance',
    phase: 3,
    type: 'scalar',
    nested: 'clouds'
  },
  { key: 'hazeDensityScale', phase: 4, type: 'scalar', nested: 'clouds' },
  { key: 'hazeExponent', phase: 4, type: 'scalar', nested: 'clouds' },
  {
    key: 'hazeScatteringCoefficient',
    phase: 4,
    type: 'scalar',
    nested: 'clouds'
  },
  {
    key: 'hazeAbsorptionCoefficient',
    phase: 4,
    type: 'scalar',
    nested: 'clouds'
  },
  { key: 'multiScatteringOctaves', phase: 1, type: 'scalar', nested: 'clouds' },
  { key: 'accurateSunSkyLight', phase: 1, type: 'boolean', nested: 'clouds' },
  { key: 'accuratePhaseFunction', phase: 4, type: 'boolean', nested: 'clouds' },

  { key: 'cascadeCount', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'mapSize', phase: 3, type: 'vector2', nested: 'shadow' },
  { key: 'maxFar', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'farScale', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'splitMode', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'splitLambda', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'temporalPass', phase: 3, type: 'boolean', nested: 'shadow' },
  { key: 'temporalJitter', phase: 3, type: 'boolean', nested: 'shadow' },
  { key: 'maxIterationCount', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'minStepSize', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'maxStepSize', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'minDensity', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'minExtinction', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'minTransmittance', phase: 3, type: 'scalar', nested: 'shadow' },
  { key: 'opticalDepthTailScale', phase: 3, type: 'scalar', nested: 'shadow' }
] as const

const isVector = (e: ParityKeyEntry): boolean =>
  e.type === 'vector2' || e.type === 'vector3' || e.type === 'matrix4'

/** Anything with a three-style .copy(), which is how vector/matrix keys apply */
interface Copyable {
  copy: (value: unknown) => unknown
}

function isCopyable(v: unknown): v is Copyable {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { copy?: unknown }).copy === 'function'
  )
}

type PropertyBag = Record<string, unknown>

function asBag(v: unknown): PropertyBag | null {
  return typeof v === 'object' && v !== null ? (v as PropertyBag) : null
}

// One key loop drives both sides, so property types are heterogeneous and
// known only from PARITY_KEYS. unknown + narrowing keeps that honest: scalars
// are written through, vectors/matrices copied into the existing instance
/**
 * Top-level keys that are legitimately NOT PARITY_KEYS entries. Both are
 * adapter exceptions documented on ParityState. Pinned by a test so a third
 * cannot be added without a deliberate edit.
 */
export const PARITY_SET_EXCEPTIONS = ['enabled', 'debug'] as const

const NESTED_GROUPS = ['clouds', 'shadow'] as const

/**
 * Refuse a state partial that cannot be applied.
 *
 * `p.set` arrives through page.evaluate with its type erased. A nested key
 * passed FLAT was dropped in silence and read back the OLD value, so a PCF
 * probe "measured" its own noise floor (4f2434e).
 *
 * It was NOT caught by a re-measurement, contrary to 4f2434e's postscript (a
 * false all-clear). A silent no-op in a knob-setter manufactures
 * agreement and never announces itself in a number, hence this validator.
 */
export function validateParityStatePartial(partial: object): void {
  // A key name is NOT unique across groups (`maxIterationCount` is in both
  // `clouds` and `shadow`), so this maps a key to the SET of owning groups
  // Keyed by name alone, a correctly formed call would be rejected
  const flat = new Set<string>()
  const groupsOf = new Map<string, Set<string>>()
  for (const entry of PARITY_KEYS) {
    if (entry.nested != null) {
      const set = groupsOf.get(entry.key) ?? new Set<string>()
      set.add(entry.nested)
      groupsOf.set(entry.key, set)
    } else {
      flat.add(entry.key)
    }
  }
  const groups = new Set<string>(NESTED_GROUPS)
  const allowed = new Set<string>(PARITY_SET_EXCEPTIONS)

  for (const [key, value] of Object.entries(partial as PropertyBag)) {
    if (groups.has(key)) {
      const inner = asBag(value)
      if (inner == null) {
        throw new Error(
          `parity set: '${key}' must be an object of ${key} keys, got ${typeof value}`
        )
      }
      for (const innerKey of Object.keys(inner)) {
        const owners = groupsOf.get(innerKey)
        if (owners?.has(key) !== true) {
          throw new Error(
            owners != null
              ? `parity set: '${innerKey}' belongs to ${[...owners]
                  .map(g => `'${g}'`)
                  .join(
                    ' / '
                  )}, not '${key}' — use { ${[...owners][0]!}: { ${innerKey}: ... } }`
              : `parity set: unknown ${key} key '${innerKey}'`
          )
        }
      }
      continue
    }
    if (flat.has(key) || allowed.has(key)) continue

    const owners = groupsOf.get(key)
    if (owners != null) {
      const paths = [...owners]
        .map(g => `{ ${g}: { ${key}: ... } }`)
        .join(' or ')
      throw new Error(
        `parity set: '${key}' is a nested key and was passed FLAT, which applies ` +
          `NOTHING and leaves the old value in place — use ${paths}`
      )
    }
    throw new Error(
      `parity set: unknown key '${key}' — not in PARITY_KEYS and not one of ` +
        `${PARITY_SET_EXCEPTIONS.join(', ')}`
    )
  }
}

function applyKeys(
  target: PropertyBag,
  state: PropertyBag,
  keys: readonly ParityKeyEntry[]
): void {
  for (const entry of keys) {
    // Second line of defence for callers that skip validateParityStatePartial:
    // a nested key at the TOP level means the flat form, and skipping it is the
    // Defect. Refuse instead.
    if (entry.nested != null && state[entry.key] !== undefined) {
      throw new Error(
        `parity applyKeys: '${entry.key}' was passed flat but belongs to ` +
          `'${entry.nested}' — use { ${entry.nested}: { ${entry.key}: ... } }`
      )
    }
    const source = entry.nested != null ? asBag(state[entry.nested]) : state
    if (source == null) continue
    const value = source[entry.key]
    if (value === undefined) continue

    const dest = entry.nested != null ? asBag(target[entry.nested]) : target
    if (dest == null) continue

    if (isVector(entry)) {
      const vec = dest[entry.key]
      if (isCopyable(vec)) {
        vec.copy(value)
      }
    } else {
      dest[entry.key] = value
    }
  }
}

// Side A's frame lock: ParityCloudsEffect.frameOverride pins the frame and
// Δtime = 0 stops wind offsets accumulating. The override is set in applyCase,
// not here, since the adapters only handle knobs
const SPLIT_MODE_NAMES = ['uniform', 'logarithmic', 'practical'] as const

export function applyToA(
  state: Partial<ParityState>,
  sideA: SideAHandle
): void {
  const clouds = sideA.clouds as unknown as PropertyBag
  applyKeys(clouds, state, PARITY_KEYS)

  // `enabled`. Side A's clouds arrive as the ATMOSPHERE OVERLAY the
  // aerial effect composites (SKIP_RENDERING is defined), so disabling cuts
  // that overlay. skipRendering stays true either way
  if (state.enabled != null) {
    sideA.aerial.overlay = state.enabled
      ? ((clouds.atmosphereOverlay ?? null) as typeof sideA.aerial.overlay)
      : null
  }

  if (state.debug != null) {
    applyDebugView(sideA.clouds, state.debug)
  }

  // Our presets store splitMode as a numeric index (0/1/2); the original
  // library expects a string key ('uniform'/'logarithmic'/'practical')
  const cloudsShadow = asBag(clouds.shadow)
  if (state.shadow?.splitMode != null && cloudsShadow != null) {
    const idx = state.shadow.splitMode
    cloudsShadow.splitMode = SPLIT_MODE_NAMES[idx] ?? 'practical'
  }

  if (state.correctAltitude != null) {
    ;(sideA.aerial as unknown as { correctAltitude: boolean }).correctAltitude =
      state.correctAltitude
  }
}

const GRAPH_SHAPE_KEYS = new Set([
  'multiScatteringOctaves',
  'accurateSunSkyLight',
  'accuratePhaseFunction'
])

export function applyToB(
  state: Partial<ParityState>,
  sideB: SideBHandle
): void {
  const ctx = sideB.cloudsContext as unknown as PropertyBag
  applyKeys(ctx, state, PARITY_KEYS)

  // `enabled`. Side B disables at the pass: CloudsPassNode returns
  // its dst untouched, so only the clouds drop out, the same end state as
  // nulling side A's overlay
  if (state.enabled != null) {
    sideB.cloudsContext.enabled = state.enabled
  }

  if (state.debug != null) {
    sideB.cloudsContext.debug = asDebugView(state.debug)
  }

  // The graph reads the private field behind each getter, and the nested
  // clouds.* assignment above set only the shorthand, so without this
  // re-apply the pin never reaches the graph. Not redundant after the preset fix
  if (state.clouds != null) {
    for (const gk of GRAPH_SHAPE_KEYS) {
      const v = (state.clouds as unknown as PropertyBag)[gk]
      if (v !== undefined) ctx[gk] = v
    }
  }

  if (state.shadow?.updateInterval != null) {
    sideB.cloudsContext.shadow.updateInterval = state.shadow.updateInterval
  }

  // Reference mode, side B only. Applied only when the state carries the key,
  // so a set() partial that omits one leaves a deliberate value alone
  if (state.lightShaftsHalfResolution != null) {
    sideB.cloudsContext.lightShaftsHalfResolution =
      state.lightShaftsHalfResolution
  }

  if (state.experimental != null) {
    sideB.cloudsContext.experimental = { ...state.experimental }
  }

  if (state.correctAltitude != null) {
    ;(
      sideB.atmosphereContext as unknown as { correctAltitude: boolean }
    ).correctAltitude = state.correctAltitude
  }
}

export function caseToParityCase(cd: CaseDefinition): ParityCase {
  const eff = effectiveState(cd)
  return {
    name: cd.name,
    width: 1280,
    height: 720,
    pixelRatio: 1,
    time: cd.time,
    frame: cd.frame,
    warmup: cd.warmup,
    sun: { ...cd.sun },
    camera: cam => {
      cam.position.fromArray(cd.pose.position)
      const la = cd.pose.lookAt
      cam.lookAt(la[0], la[1], la[2])
    },
    worldToECEF: new Matrix4().makeRotationY(
      (cd.ecefRotationY ?? 0) * (Math.PI / 180)
    ),
    knobs: {
      layers: eff.layers,
      enabled: eff.enabled,
      haze: eff.haze,
      shadow: eff.shadow,
      lightShafts: eff.lightShafts,
      temporalUpscale: eff.temporalUpscale,
      accuratePhaseFunction: eff.accuratePhaseFunction,
      debug: eff.debug,
      maxIterationCountToGround: eff.maxIterationCountToGround
    },
    lighting: cd.lighting ?? 'post'
  }
}

export function buildCaseParityState(cd: CaseDefinition): Partial<ParityState> {
  const eff = effectiveState(cd)
  const preset = qualityPresets[eff.qualityPreset]

  return {
    coverage: eff.coverage,
    correctAltitude: eff.correctAltitude,
    resolutionScale: eff.resolutionScale,
    shapeDetail: eff.shapeDetail,
    turbulence: eff.turbulence,
    haze: eff.haze,
    lightShafts: eff.lightShafts,
    temporalUpscale: eff.temporalUpscale,
    // this line was missing, so case 43's groundBounceScale reached
    // NEITHER side despite being declared everywhere: side A's plate was
    // byte-identical to its neutral control. Not a weak effect, no effect
    groundBounceScale: eff.groundBounceScale,
    // Reference mode. Every port-only default, from the library's one written
    // copy of the values, so a public default cannot move the ladder
    lightShaftsHalfResolution: REFERENCE_MODE.lightShaftsHalfResolution,
    experimental: { ...REFERENCE_MODE.experimental },
    clouds: {
      ...preset.clouds,
      multiScatteringOctaves: eff.multiScatteringOctaves,
      accurateSunSkyLight: eff.accurateSunSkyLight,
      accuratePhaseFunction: eff.accuratePhaseFunction,
      maxIterationCountToGround: eff.maxIterationCountToGround
    },
    shadow: {
      ...preset.shadow,
      cascadeCount: eff.shadowCascadeCount,
      mapSize: new Vector2(eff.shadowMapSize, eff.shadowMapSize),
      updateInterval: REFERENCE_MODE.shadowUpdateInterval
    }
  }
}

export function keyExistsOnTarget(
  target: PropertyBag,
  entry: ParityKeyEntry
): boolean {
  const dest = entry.nested != null ? asBag(target[entry.nested]) : target
  return dest != null && dest[entry.key] !== undefined
}
