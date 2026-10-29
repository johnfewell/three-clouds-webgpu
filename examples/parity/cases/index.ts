// Parity case registry: the 55-case ladder as typed data
// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// ADR-011: frozen-feature neutralisation, every case is a delta from case 1

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'

export type DebugView =
  | 'none'
  | 'cascades'
  | 'shadow-map'
  | 'checker-uv'
  | 'sample-count'
  | 'front-depth'

export interface CasePose {
  readonly position: readonly [number, number, number]
  readonly lookAt: readonly [number, number, number]
}

export interface CaseState {
  readonly enabled: boolean
  readonly qualityPreset: QualityPreset
  readonly resolutionScale: number
  readonly shapeDetail: boolean
  readonly turbulence: boolean
  readonly coverage: number
  readonly multiScatteringOctaves: number
  readonly accurateSunSkyLight: boolean
  readonly accuratePhaseFunction: boolean
  readonly layers: number
  readonly correctAltitude: boolean
  readonly temporalUpscale: boolean
  readonly lightShafts: boolean
  readonly shadow: boolean
  readonly shadowCascadeCount: number
  readonly shadowMapSize: number
  readonly haze: boolean
  readonly groundBounceScale: number
  readonly maxIterationCountToGround: number
  readonly debug: DebugView
  // Case 46: CONSTRUCTION-time on both sides. Side A passes it to the
  // WebGLRenderer, and side B's CloudsPassNode:594 reads it back every update,
  // so a context knob would be reverted each frame
  readonly logarithmicDepthBuffer: boolean
  // Case 45: construction-time like the two
  // above. Both packages expose the same generators, so this is a real A/B of
  // generated-vs-baked rather than a B-only assertion
  readonly proceduralTextures: boolean
}

export interface SequenceConfig {
  readonly frames: number
  readonly dt: number
  // Sequence-only state, applied after the still frame: velocity is
  // meaningless to one frame. localWeatherVelocity defaults to ZERO on both
  // sides, so `wind` and `shadow-both-moving` never moved without it
  readonly state?: {
    readonly localWeatherVelocity?: readonly [number, number]
  }
  /**
   * Camera drift in ECEF metres/second, applied only across the sequence
   *. Absent means static, which is what every case did before this.
   *
   * With sun and camera static the shadow reprojection matrix is the identity
   * (CloudsPassNode.ts:1505), so the shadow velocity pass emits zero whatever
   * it computes, which is why the dimensional fix was unprovable.
   */
  readonly cameraVelocity?: readonly [number, number, number]
  /**
   * Sun drift in DEGREES PER SECOND as [elevation, azimuth], applied only
   * across the sequence (the sun half).
   *
   * The sharper of the two reprojection inputs at a low sun: shadow LENGTH goes
   * as cot(elevation). Applied ABSOLUTELY from the base sun (base + v*t(N)),
   * with both sides handed the SAME angles, so any divergence is a real port
   * difference rather than two harnesses integrating separately.
   */
  readonly sunVelocity?: readonly [number, number]
}

export interface CaseDefinition {
  readonly name: string
  readonly number: number
  readonly variant?: string
  readonly phase: 0 | 1 | 2 | 3 | 4
  readonly pose: CasePose
  readonly sun: { readonly elevation: number; readonly azimuth: number }
  readonly time: number
  readonly frame: number
  readonly warmup: number
  readonly state: Partial<CaseState>
  readonly sequence?: SequenceConfig
  /**
   * Rotation of the world→ECEF frame, in degrees about the ECEF **Y** axis,
   * absent or 0 = identity. Case 28 `ecef-rotated`'s delta: the frame both
   * sides transform through, not a `CloudsEffect` knob or `CaseState` key.
   *
   * Y because every ladder pose lies on +Y, so the camera's ECEF position is
   * untouched and the case isolates the frame transform (ray directions,
   * weather sampling, aerial perspective). `cases.test.ts` asserts the axis.
   */
  readonly ecefRotationY?: number
  readonly scene: 'synthetic' | 'world'
  readonly lookOnly?: boolean
  /**
   * the shaded-fraction receipt is taken on every case whose
   * effective state casts a shadow. A case may DECLARE it inapplicable, with
   * the reason, when shadow is a prerequisite rather than the subject (ground
   * bounce) or the subject IS the atlas (debug views). The runner writes
   * `{ skipped: reason }`. An undeclared shadow case with no shadow FAILS.
   */
  readonly shadedFractionReceipt?: {
    readonly skip?: string
    /**
     * how the two sides' fractions are compared. `ratio` (default)
     * is correct wherever BOTH sides shade the same pixels from the same
     * consumer. `b-only` is case 35 only: side A has no consumer, so the
     * ratio is not a comparison. ADR-011 Amendment 13
     */
    readonly compare?: 'ratio' | 'b-only'
  }
  /**
   * the channels of a packed debug plate that DECIDE RENDERING, and
   * the per-channel agreement each must hold to. Every channel is measured;
   * only these are gated. A case declares this when the view packs a quantity
   * no consumer reads beside the ones it does (ADR-011 Amendment 6).
   */
  readonly atlasChannelGate?: {
    readonly channels: readonly ('r' | 'g' | 'b')[]
    readonly tolerance: number
    readonly reason: string
  }
  readonly hardwareSkip?: string
  /**
   * ADR-013 Amendment 6: side B reads the atmosphere's scattering LUT on every
   * case, except a case that declares a standing exception here, with its
   * measured reason. The register is kept to what a qualification ladder
   * showed to need it (cases.test.ts pins its membership).
   */
  readonly atmosphereException?: {
    readonly mode: 'raymarch-256'
    readonly reason: string
  }
  readonly backend?: 'webgpu' | 'webgl2'
  readonly camera?: 'perspective' | 'orthographic'
  readonly lighting?: 'post' | 'lights'
}

// Phase assignment for each parity key: a phase-N case must not change
// keys with phase > N away from their BASE_STATE value
export const PARITY_KEYS_PHASE: Record<keyof CaseState, number> = {
  enabled: 0,
  qualityPreset: 1,
  resolutionScale: 1,
  shapeDetail: 1,
  turbulence: 1,
  coverage: 1,
  multiScatteringOctaves: 1,
  accurateSunSkyLight: 1,
  layers: 1,
  correctAltitude: 1,
  maxIterationCountToGround: 1,
  temporalUpscale: 2,
  lightShafts: 3,
  shadow: 3,
  shadowCascadeCount: 3,
  shadowMapSize: 3,
  haze: 4,
  accuratePhaseFunction: 4,
  groundBounceScale: 4,
  debug: 4,
  logarithmicDepthBuffer: 4,
  proceduralTextures: 4
}

const ER = 6378137

const POSE_ORBIT_60KM: CasePose = {
  position: [0, ER + 60000, 0],
  lookAt: [0, ER - 20000, 0]
}

const POSE_ORBIT_140KM: CasePose = {
  position: [0, ER + 140000, 0],
  lookAt: [0, ER, 0]
}

const POSE_INSIDE_DECK: CasePose = {
  position: [0, ER + 5000, 0],
  lookAt: [ER + 5000, 0, 0]
}

const POSE_BELOW_DECK_1KM: CasePose = {
  position: [0, ER + 1000, 0],
  lookAt: [0, ER + 10000, 0]
}

const POSE_SURFACE_UP: CasePose = {
  position: [0, ER + 100, 0],
  lookAt: [0, ER + 50000, 0]
}

// Case 35's only light-reactive receiver is the 500 m sphere at the Tokyo
// anchor, outside the frustum from POSE_ORBIT_60KM. This looks radially down
// at it from 60 km: hundreds of receiver pixels, no horizon readback
const POSE_SHADOW_RECEIVER: CasePose = {
  position: [-3991973, 3385439, 3736223],
  lookAt: [-3956051, 3354975, 3702378]
}

// 7900 m, NOT 8000: at exactly maxHeight the ORIGINAL itself is float-chaotic
// on the shell-intersection knife edge. 100 m off it the two sides are
// bit-identical
const POSE_HORIZON_GRAZING: CasePose = {
  position: [0, ER + 7900, 0],
  lookAt: [ER, 0, 0]
}

// ARM BC's off-surface falsifiers need sky
// pixels, which the inside-deck poses lack. 12 km up, above the cirrus top,
// looking along the horizontal: clear sky above, deck and ground below
const POSE_ABOVE_DECK_HORIZON: CasePose = {
  position: [0, ER + 12000, 0],
  lookAt: [250000, ER + 12000, 0]
}

// The only non-equatorial pose (139.7°E, 75°S, 60 km, looking down), for case
// 55's `correctAltitude: false`: uncorrected, the deck clears the
// ground only past |lat| 64.5°, and 75°S keeps the sun up (24.4°)
const POSE_POLAR_SOUTH_60KM: CasePose = {
  position: [-1274794, 1081104, -6196721],
  lookAt: [-1259003, 1067712, -6119447]
}

const SUN_DEFAULT = { elevation: 45, azimuth: 180 }
const SUN_NOON = { elevation: 60, azimuth: 180 }
const SUN_LOW = { elevation: 10, azimuth: 180 }
const SUN_HORIZON = { elevation: 2, azimuth: 180 }
const SUN_TWILIGHT = { elevation: -4, azimuth: 180 }
// 4 deg: inside the narrow band where the shadow PCF radius is non-zero. The
// adaptive factor is remapClamped(dot(sun, up), 0.1, 0), zero at every other
// ladder sun, so PCF never ran. 4 deg gives 0.302
const SUN_GRAZING = { elevation: 4, azimuth: 180 }

// The `surface-up` sun, named because vacuousCases pairs cases with a neutral
// twin on pose AND sun and silently SKIPS what it cannot pair. Sharing it keeps
// haze-on and ground-bounce-on falsifiable
const SUN_SURFACE_UP = { elevation: 60, azimuth: 0 }

// ADR-011: case 1 pins every graph-time feature and neutralises later-phase
// features OFF. This is the baseline for all delta application.
export const BASE_STATE: CaseState = {
  enabled: true,
  qualityPreset: 'medium',
  resolutionScale: 1,
  shapeDetail: true,
  turbulence: false,
  coverage: 0.3,
  multiScatteringOctaves: 8,
  accurateSunSkyLight: false,
  accuratePhaseFunction: false,
  // was 1, but DEFAULT renders THREE active layers (the fourth is
  // zero-thickness) and nothing applied this key. Re-based to what renders, so
  // wiring it changed no committed result (confirmed on hardware)
  layers: 3,
  correctAltitude: true,
  temporalUpscale: false,
  lightShafts: false,
  shadow: false,
  shadowCascadeCount: 3,
  shadowMapSize: 256,
  haze: false,
  groundBounceScale: 0,
  maxIterationCountToGround: 0,
  debug: 'none',
  logarithmicDepthBuffer: false,
  proceduralTextures: false
}

export function effectiveState(c: CaseDefinition): CaseState {
  return { ...BASE_STATE, ...c.state }
}

const SEQ_4S: SequenceConfig = { frames: 16, dt: 0.25 }
const SEQ_TEMPORAL: SequenceConfig = { frames: 16, dt: 1 / 60 }

export const cases: readonly CaseDefinition[] = [
  // ── Phase 0 ─────────────────────────────────────────────
  {
    name: 'baseline-medium',
    number: 1,
    phase: 0,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'orbit-140km',
    number: 2,
    phase: 0,
    pose: POSE_ORBIT_140KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'inside-deck',
    number: 3,
    phase: 0,
    pose: POSE_INSIDE_DECK,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'below-deck-1km',
    number: 4,
    phase: 0,
    pose: POSE_BELOW_DECK_1KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic',
    atmosphereException: {
      mode: 'raymarch-256',
      reason:
        'ADR-013 Amendment 6: the only case the LUT lookup fails. Camera at ' +
        '+1000 m, inside the WebGPU atmosphere lookup near-ground lift ' +
        '(both segment endpoints raised to bottomRadius + 1 % of the ' +
        'atmosphere thickness, ~600 m, then rescaled; upstream ' +
        '@takram/three-atmosphere runtime). histDist 0.0998 raymarched, ' +
        '0.1001 in lookup against the 0.1000 bar (the lookup ladder, ' +
        '2026-09-24 21:45Z); SSIM 0.993468 -> 0.993456, deP95 unchanged.'
    }
  },

  // ── Phase 1 ─────────────────────────────────────────────
  {
    name: 'surface-up',
    number: 5,
    phase: 1,
    pose: POSE_SURFACE_UP,
    sun: SUN_SURFACE_UP,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'horizon-grazing',
    number: 6,
    phase: 1,
    pose: POSE_HORIZON_GRAZING,
    sun: { elevation: 5, azimuth: 270 },
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'sun-noon',
    number: 7,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_NOON,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'sun-low',
    number: 8,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'sun-horizon',
    number: 9,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_HORIZON,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'sun-twilight',
    number: 10,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_TWILIGHT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'coverage-020',
    number: 11,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { coverage: 0.2 },
    scene: 'synthetic'
  },
  {
    name: 'coverage-045',
    number: 12,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { coverage: 0.45 },
    scene: 'synthetic'
  },
  {
    name: 'coverage-070',
    number: 13,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { coverage: 0.7 },
    scene: 'synthetic'
  },
  {
    name: 'coverage-090',
    number: 14,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { coverage: 0.9 },
    scene: 'synthetic'
  },
  {
    name: 'preset-low',
    number: 15,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { qualityPreset: 'low', shapeDetail: false },
    scene: 'synthetic'
  },
  {
    name: 'preset-medium',
    number: 16,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { qualityPreset: 'medium' },
    scene: 'synthetic'
  },
  {
    name: 'preset-high',
    number: 17,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {
      qualityPreset: 'high',
      turbulence: true,
      accurateSunSkyLight: true,
      maxIterationCountToGround: 3
    },
    scene: 'synthetic'
  },
  {
    name: 'preset-ultra',
    number: 18,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {
      qualityPreset: 'ultra',
      turbulence: true,
      accurateSunSkyLight: true,
      maxIterationCountToGround: 3
    },
    scene: 'synthetic'
  },
  {
    name: 'res-050',
    number: 19,
    variant: 'half',
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { resolutionScale: 0.5 },
    scene: 'synthetic'
  },
  {
    name: 'res-100',
    number: 19,
    variant: 'full',
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { resolutionScale: 1 },
    scene: 'synthetic'
  },
  {
    name: 'detail-off',
    number: 20,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shapeDetail: false },
    scene: 'synthetic'
  },
  {
    name: 'turbulence-off',
    number: 21,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { turbulence: false },
    scene: 'synthetic'
  },
  {
    name: 'octaves-1',
    number: 22,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { multiScatteringOctaves: 1 },
    scene: 'synthetic'
  },
  {
    name: 'octaves-4',
    number: 23,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { multiScatteringOctaves: 4 },
    scene: 'synthetic'
  },
  {
    name: 'octaves-8',
    number: 24,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { multiScatteringOctaves: 8 },
    scene: 'synthetic'
  },
  {
    name: 'accurate-sunsky-off',
    number: 25,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { accurateSunSkyLight: false },
    scene: 'synthetic'
  },
  {
    name: 'layers-2',
    number: 26,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { layers: 2 },
    scene: 'synthetic'
  },
  {
    name: 'layers-4',
    number: 27,
    variant: 'no-shadow',
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { layers: 4 },
    scene: 'synthetic'
  },
  {
    name: 'layers-4-shadow',
    number: 27,
    variant: 'shadow',
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { layers: 4, shadow: true },
    scene: 'synthetic'
  },
  // Case 28 is the ECEF-frame axis: identity vs rotated, correctAltitude ON in
  // both. The old correctAltitude off/on pair marched nothing on EITHER side
  // here: the uncorrected deck lay below the ground (7tk). See case 55
  {
    name: 'ecef-identity',
    number: 28,
    variant: 'identity',
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'ecef-rotated',
    number: 28,
    variant: 'rotated',
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    ecefRotationY: 45,
    scene: 'synthetic'
  },
  {
    name: 'wind',
    number: 29,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    // The case is named for wind and had none until the fix: `state: {}` plus a
    // sequence advanced time against a zero velocity, so the "animated" frames
    // were sixteen copies of the still one
    sequence: { ...SEQ_4S, state: { localWeatherVelocity: [0.02, 0.01] } },
    scene: 'synthetic'
  },

  // ── Phase 2 ─────────────────────────────────────────────
  {
    name: 'temporal-on-static',
    number: 30,
    phase: 2,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { temporalUpscale: true },
    sequence: SEQ_TEMPORAL,
    scene: 'synthetic'
  },
  {
    name: 'temporal-on-orbit',
    number: 31,
    phase: 2,
    pose: POSE_ORBIT_140KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { temporalUpscale: true },
    sequence: SEQ_TEMPORAL,
    scene: 'synthetic'
  },
  {
    name: 'temporal-on-wind',
    number: 32,
    phase: 2,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { temporalUpscale: true },
    // named for wind and had none, so it was temporal-on-static at
    // another dt (SSIM identical). Same velocity as case 29 `wind`, so the pair
    // differs ONLY in temporalUpscale
    sequence: { ...SEQ_4S, state: { localWeatherVelocity: [0.02, 0.01] } },
    scene: 'synthetic'
  },
  {
    name: 'temporal-cut',
    number: 33,
    phase: 2,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { temporalUpscale: true },
    sequence: SEQ_TEMPORAL,
    scene: 'synthetic'
  },

  // ── Phase 3 ─────────────────────────────────────────────
  {
    name: 'shadow-plane',
    number: 34,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true },
    scene: 'synthetic'
  },
  {
    name: 'shadow-sphere',
    number: 35,
    phase: 3,
    pose: POSE_SHADOW_RECEIVER,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true },
    scene: 'synthetic',
    // The WebGL reference's SunDirectionalLight and SkyLightProbe have no
    // cloud-shadow consumer. ADR-007 3.2b is therefore a side-B receipt here;
    // p4 proves that its visible receiver darkens when casters are enabled
    lighting: 'lights',
    // side A discards the shadow on the lights path, so the
    // receipt gates side B and keeps both fractions. ADR-011 Amendment 13
    shadedFractionReceipt: { compare: 'b-only' }
  },
  {
    name: 'shadow-both-moving',
    number: 36,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true },
    // Motion is the point, and the only case reaching the shadow
    // velocity pass: 200 m/s camera drift (750 m over the sequence) and 1
    // deg/s sun elevation (10 → 13.75 deg, shadows ~28 % shorter)
    sequence: {
      ...SEQ_4S,
      state: { localWeatherVelocity: [0.02, 0.01] },
      cameraVelocity: [200, 0, 0],
      sunVelocity: [1, 0]
    },
    scene: 'synthetic'
  },
  {
    name: 'shadow-cascades-2x512',
    number: 37,
    variant: '2x512',
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, shadowCascadeCount: 2, shadowMapSize: 512 },
    scene: 'synthetic'
  },
  {
    name: 'shadow-cascades-4x1024',
    number: 37,
    variant: '4x1024',
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, shadowCascadeCount: 4, shadowMapSize: 1024 },
    scene: 'synthetic'
  },
  // Cases 38 and 40 are a matched consumer-policy pair at exactly 60 km. 38
  // forces shafts ON, 40 records the strict `altitude < 60e3` policy selecting
  // OFF. Case 40 shares shadow-plane's effective state, as 38's control
  {
    name: 'shafts-low-sun',
    number: 38,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, lightShafts: true },
    scene: 'synthetic'
  },
  {
    name: 'shafts-inside-deck',
    number: 39,
    phase: 3,
    pose: POSE_INSIDE_DECK,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, lightShafts: true },
    scene: 'synthetic'
  },
  {
    name: 'shafts-orbit-off',
    number: 40,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, lightShafts: false },
    scene: 'synthetic'
  },
  {
    name: 'shadow-temporal',
    number: 41,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, temporalUpscale: true },
    sequence: SEQ_TEMPORAL,
    scene: 'synthetic'
  },

  // ── Phase 4 ─────────────────────────────────────────────
  {
    name: 'haze-on',
    number: 42,
    phase: 4,
    // POSE_SURFACE_UP, not ORBIT_60KM: haze density is
    // 3e-5 * exp(-h / 1000) and early-outs below 1e-7 (above 5704 m). At 100 m
    // it gives an optical depth ~0.027 looking up, well above the fp16 floor
    pose: POSE_SURFACE_UP,
    // Matches the neutral control `surface-up` exactly, so this case HAS a twin
    // in vacuousCases.test.ts. A different sun here would leave it with no
    // twin, and the guard skips what it cannot pair
    sun: SUN_SURFACE_UP,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { haze: true },
    scene: 'synthetic'
  },
  {
    name: 'ground-bounce-on',
    number: 43,
    shadedFractionReceipt: {
      skip: 'shadow: true is the shadowTopHeight gate PREREQUISITE for ground bounce, not the subject of the case. The camera sits at 100 m looking up, so no ground shadow is in frame and the receipt has nothing to measure (mail #673: A 0.00 %, B 0.02 %, ratio 10.7 from dividing two near-zero fractions)'
    },
    phase: 4,
    // Ground bounce needs groundBounceScale AND maxIterationCountToGround > 0
    // (glv3), a caster to lift shadowTopHeight, and a low pose for mipLevel
    // Its delta is still the same, and the evidence is p4's
    pose: POSE_SURFACE_UP,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { groundBounceScale: 1, maxIterationCountToGround: 3, shadow: true },
    scene: 'synthetic'
  },
  {
    name: 'draine-phase',
    number: 44,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { accuratePhaseFunction: true },
    scene: 'synthetic'
  },
  {
    name: 'procedural-textures',
    number: 45,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    // was `state: {}`, identical to a neutral case, so 45 rendered the
    // BAKED textures on both sides and passed for a feature it never exercised
    // s68 makes the generators real, and this makes the case use them
    state: { proceduralTextures: true },
    scene: 'synthetic'
  },
  {
    name: 'log-depth',
    number: 46,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    // DESIGN-NEUTRAL, in KNOWN_VACUOUS: log depth is a round trip,
    // so the march's viewZ is unchanged and no colour plate can show it
    // Evidence is the depth-precision e2e
    state: { logarithmicDepthBuffer: true },
    scene: 'synthetic'
  },
  {
    name: 'debug-cascades',
    number: 47,
    shadedFractionReceipt: {
      skip: "the subject is the shadow atlas; clearing the casters empties the visualisation, so the receipt's brighten premise does not hold (it happened to brighten +24 % — luck, not a receipt)"
    },
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, debug: 'cascades' },
    scene: 'synthetic'
  },
  {
    name: 'debug-shadow-map',
    number: 48,
    shadedFractionReceipt: {
      skip: "the subject is the shadow atlas; clearing the casters DARKENS the view (A rise -0.319), the receipt's brighten premise inverts"
    },
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, debug: 'shadow-map' },
    // gate green and blue, the optical-depth channels. Red is
    // frontDepth, which both sides clamp away. ADR-011 Amendment 13
    atlasChannelGate: {
      channels: ['g', 'b'],
      tolerance: 0.05,
      reason:
        'the channels that decide optical depth; red is the march fallback, ' +
        'clamped by both consumers above the whole plausible distanceToTop'
    },
    scene: 'synthetic'
  },
  {
    name: 'debug-checker-uv',
    number: 49,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { debug: 'checker-uv' },
    scene: 'synthetic'
  },
  {
    name: 'debug-sample-count',
    number: 50,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { debug: 'sample-count' },
    scene: 'synthetic'
  },
  {
    name: 'debug-front-depth',
    number: 51,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { debug: 'front-depth' },
    scene: 'synthetic'
  },
  {
    name: 'world-tiles',
    number: 52,
    phase: 1,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'world',
    lookOnly: true
  },
  // CASE 53 (ortho-camera) IS RETIRED, left as a gap since results
  // are keyed by number. The reference's rays are perspective-only, so an
  // ortho case is a 0.04 deg pinhole on both sides. Revive with ray origins
  {
    name: 'webgl2-backend',
    number: 54,
    phase: 4,
    pose: POSE_ORBIT_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic',
    backend: 'webgl2',
    lookOnly: true,
    hardwareSkip: 'WebGL2 backend not available'
  },
  // ── 55: the correctAltitude axis ───────────────
  // A PAIR sharing POSE_POLAR_SOUTH_60KM and SUN_DEFAULT, differing ONLY by
  // `correctAltitude`, so the diff isolates the correction as 28 does the frame
  {
    name: 'polar-altitude-corrected',
    number: 55,
    variant: 'corrected',
    phase: 1,
    pose: POSE_POLAR_SOUTH_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { correctAltitude: true },
    scene: 'synthetic'
  },
  {
    name: 'polar-altitude-uncorrected',
    number: 55,
    variant: 'uncorrected',
    phase: 1,
    pose: POSE_POLAR_SOUTH_60KM,
    sun: SUN_DEFAULT,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { correctAltitude: false },
    scene: 'synthetic'
  },
  // the only place the shadow PCF runs (see SUN_GRAZING). sun-grazing
  // is its neutral twin: vacuousCases skips unpaired cases, which is how case
  // 35 went unchecked
  {
    name: 'sun-grazing',
    number: 56,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_GRAZING,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'shadow-grazing',
    number: 57,
    phase: 3,
    pose: POSE_ORBIT_60KM,
    sun: SUN_GRAZING,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true },
    scene: 'synthetic'
  },
  // Hole: shafts-inside-deck (39) is at POSE_INSIDE_DECK + SUN_LOW, and
  // the only neutral at that pose uses SUN_DEFAULT, so 39 was never checked
  // This is its control, and deleting it un-checks case 39 again
  {
    name: 'inside-deck-low-sun',
    number: 58,
    phase: 3,
    pose: POSE_INSIDE_DECK,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  // Neutral control for shadow-sphere at the same receiver-visible pose and
  // sun. Without this pair the vacuity sweep silently skips case 35.
  {
    name: 'shadow-sphere-neutral',
    number: 59,
    phase: 3,
    pose: POSE_SHADOW_RECEIVER,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  // Sky-visible pair for ARM BC (3l31): 60 neutral, 61 shadowed/shafts, the
  // sky twin of case 39. Sky packs are deliberately VACUOUS (s=1, od=0), so an
  // F3 red on sky pixels is pack-convention suspicion first (zvyl)
  {
    name: 'sky-horizon-low-sun',
    number: 60,
    phase: 3,
    pose: POSE_ABOVE_DECK_HORIZON,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: {},
    scene: 'synthetic'
  },
  {
    name: 'shafts-sky-horizon',
    number: 61,
    phase: 3,
    pose: POSE_ABOVE_DECK_HORIZON,
    sun: SUN_LOW,
    time: 0,
    frame: 0,
    warmup: 64,
    state: { shadow: true, lightShafts: true },
    scene: 'synthetic'
  }
]

export function caseByName(name: string): CaseDefinition | undefined {
  return cases.find(c => c.name === name)
}

export function casesByNumber(n: number): CaseDefinition[] {
  return cases.filter(c => c.number === n)
}

export function casesByPhase(phase: number): CaseDefinition[] {
  return cases.filter(c => c.phase <= phase)
}
