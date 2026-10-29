// The e2e probe's surface, as a type. `(window as any)` made every access
// legal: `enabled` silently did nothing and p4 read an unpublished
// `__parity.lighting` whose assertion could not fail. An explicit cast, not a
// `declare global`, so it composes with harnessGate.ts's declaration

import type { CloudShadowProbePixels } from '../src/cloudShadowProbe'
import type { GpuTimingSummary } from '../src/metrics/gpuTiming'
import type {
  MotionDirectionResult,
  MotionVectorResult
} from '../src/metrics/sequence'
import type { ParityCase, ParityState } from '../src/parityState'
import type { HarnessParams } from '../src/routing'
import type { SideBHandle } from '../src/sideB'

export interface ProbeStats {
  frame: number
  time: number
  frameMs: number | null
  passes: {
    atlas: number
    march: number
    shadowLength: number
  }
  targets: Array<{
    id: number
    name: string
    width: number
    height: number
    depth: number
    attachments: number
    format: string
  }>
}

export interface ProbePixels {
  width: number
  height: number
  data: Float32Array
}

export interface ProbeShadowRayExtents {
  extent: ProbeScalarField[]
  ulpAllowance: ProbeScalarField[]
}

export interface ProbeAtlas {
  width: number
  height: number
  depth: number
  temporalPass: boolean
  maxShadowRayExtentUnit: number
  source: 'raw' | 'history'
  layers: ProbePixels[]
  rayExtents: ProbeShadowRayExtents
}

/** side A's atlas readback. See ParityProbe.readShadowAtlasA */
export interface ProbeAtlasA {
  width: number
  height: number
  depth: number
  temporalPass: boolean
  maxShadowRayExtentUnit: number
  source: 'raw' | 'history'
  layers: ProbePixels[]
  rayExtents: ProbeShadowRayExtents
  // Errors pending before the read. 0x506 is reported and the texels stay
  preexistingGlErrors: number[]
  /**
   * Stated, not implied: side A's atlas stores `frontDepth` in METRES and side
   * B's in UNIT SPACE (`metres * worldToUnit`). Comparing the red channels as
   * raw numbers is a 6371x error, and the debug views that scale the channel
   * differ by the same factor for the same reason. RGBA16F saturates A's
   * 1e6 m miss at 65504
   */
  atlasUnits: 'metres'
  ms: number
}

export interface ProbeScalarField {
  width: number
  height: number
  data: Float32Array
}

export interface ProbeShadowKnobs {
  cascadeCount: number
  mapSize: [number, number]
  // null is a legal reading: neither side sets maxFar, so both keep the CSM's
  // own null default and the shadow range is camera.far * farScale
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
}

/**
 * Mirrors the object main.ts publishes as `window.__parity`.
 *
 * NOT enforced against that object here. The remaining drift is one-way: a
 * member REMOVED from the probe but kept here reintroduces the `lighting` bug.
 * Closing it needs `satisfies ParityProbe` in main.ts (recorded on the probe).
 */
export interface ParityVelocityStats {
  present: boolean
  texels: number
  meanMag: number
  maxMag: number
  nonZeroFrac: number
}

export interface ParityProbe {
  readonly caseName: string
  readonly pc: ParityCase
  readonly params: HarnessParams
  readonly errors: string[]
  readonly warnings: string[]

  readonly sideBHandle: SideBHandle | null
  // Side A's handle and the two canvases are published but unused by any spec
  // Typed `unknown` on purpose: whoever needs one should widen it deliberately
  // and get checked, rather than inherit a blanket `any`
  readonly sideAHandle: unknown
  readonly canvasA: unknown
  readonly canvasB: unknown

  /** The whole point of the type: an unknown key is a compile error */
  set: (partial: Partial<ParityState>) => void

  // `shadow` is a per-LAYER flag, not a ParityState key, so `set({ shadow })`
  // silently did nothing (test 12). These return the flags READ
  // BACK. `lightShafts` is routed, but routed is not the same as took effect
  /**
   * READ-ONLY. The effective temporalUpscale on each side at capture
   * time. Not a setter: it records which configuration produced a number, so a
   * configuration difference cannot pass for a mechanism (the case-vs-live-state precedent).
   */
  readTemporalUpscale: () => { A: boolean; B: boolean | null }

  setShadow: (value: boolean) => { A: boolean[]; B: boolean[] | null }
  setLayerShadows: (values: readonly boolean[]) => {
    A: boolean[]
    B: boolean[] | null
  }
  setLightShafts: (value: boolean) => { A: boolean; B: boolean | null }
  readShadowKnobs: () => {
    A: ProbeShadowKnobs
    B: ProbeShadowKnobs | null
  }

  /**
   * fraction of pixels that still changed between the last two
   * warm-up frames of the most recent renderOnce, per side. ~0 means settled, a
   * large value a still-moving average. null when warmup was 0.
   *
   * STATIONARITY, not reproducibility: necessary, not sufficient (measured:
   * four stationary states on case 36). The N-run sweep gives reproducibility.
   */
  convergence: () => { A: number | null; B: number | null }
  renderOnce: (
    side: 'A' | 'B',
    opts: {
      time: number
      frame: number
      warmup?: number
      /** defaults true, so warmup N means N frames from cold */
      resetHistory?: boolean
    }
  ) => Promise<void>
  renderSequence: (opts: {
    frames: number
    dt: number
    warmup: number
  }) => Promise<{
    framesA: Float32Array[]
    framesB: Float32Array[]
    width: number
    height: number
  }>
  sequenceInit: (warmup: number) => Promise<void>
  sequenceStep: (
    frame: number,
    dt: number,
    motion?: {
      cameraVelocity?: readonly [number, number, number]
      sunVelocity?: readonly [number, number]
    }
  ) => Promise<{
    width: number
    height: number
    // the applied camera position for BOTH sides plus the expected
    // one. The sides own separate cameras, so whether they landed on the same
    // point is the property under test, returned rather than assumed
    camera: {
      A: [number, number, number]
      B: [number, number, number] | null
      expected: [number, number, number]
    } | null
    // Sun half: the applied angles (degrees) and each side's resulting
    // unit DIRECTION. The runner checks the angles and A against B, since the
    // angles alone would not catch two sides pointing different ways
    sun: {
      elevation: number
      azimuth: number
      A: [number, number, number]
      B: [number, number, number] | null
    } | null
    // per-side plate mean for THIS frame, via
    // the still capture's computePlateStats, so it compares with the committed
    // mean. `B` is null when side B is absent, never a mean of 0
    plateMean: { A: number; B: number | null }
  }>
  // velocity + resolved-shadow readings after each of a sequence
  // frame's two cloudsPass executions. Magnitudes in TEXELS (velocity =
  // (uv - prevUv) * resolution)
  shadowVelocityProbe: (opts: {
    frames: number
    dt: number
    cameraVelocity: [number, number, number]
    cascade?: number
  }) => Promise<Array<{
    frame: number
    afterRender: ParityVelocityStats
    afterRenderLinear: ParityVelocityStats
    resolveAfterRender: number
    resolveAfterRenderLinear: number
    // N vs N+1 decides whether three's FRAME-type dedup suppressed the second
    // pre-pass. Equal ids mean one execution, adjacent ids mean two.
    frameIdRender: number
    frameIdRenderLinear: number
  }> | null>
  sequenceMetrics: (opts: { frames: number; dt: number }) => Promise<{
    flickerA: { mean: number; max: number }
    flickerB: { mean: number; max: number }
    ghostingA: { deMean: number; deP95: number } | null
    ghostingB: { deMean: number; deP95: number } | null
    motionA: MotionVectorResult | null
    motionB: MotionVectorResult | null
    motionDirection: MotionDirectionResult | null
  }>

  readLinear: (side: 'A' | 'B') => Promise<ProbePixels>
  /** Full-frame pre-tonemap scene/atmosphere plate. Clouds must be disabled */
  readSceneLinear: (side: 'A' | 'B') => Promise<ProbePixels>
  readLayer: () => Promise<ProbePixels>
  readDepthVelocity: () => Promise<ProbePixels>
  readShadowAtlas: () => Promise<ProbeAtlas>
  /**
   * side A's raw atlas, per cascade, read through
   * framebufferTextureLayer + readPixels because it is a WebGL array target.
   *
   * The pair is what makes the two atlases comparable: `ProbeAtlas` for side B
   * and this for side A, channel by channel, at the same pose and sun. Without
   * it only the composited plate is available and it cannot separate the aerial
   * post-lighting factor from the optical depth, which enter only as
   * `K · exp(-od)`
   */
  readShadowAtlasA: () => ProbeAtlasA
  readShadowLength: () => Promise<ProbePixels | null>
  /**
   * Step 1: the site-2 PCF radius lane. `null`, never a zero-filled
   * buffer, when side B built no lane, so the capture can REFUSE rather than
   * read a missing instrument as radius 0.
   */
  readShadowRadius: () => Promise<ProbePixels | null>
  /**
   * a ground patch drawn with `cloudShadowAt(positionWorld)` and
   * nothing else. Each texel IS the transmittance a custom material multiplies
   * by, so a material darkening under a cloud is a fact about the numbers
   */
  readCloudShadowProbe: () => Promise<CloudShadowProbePixels>
  sampleShadowOD: (input: {
    texel: readonly [number, number, number, number]
    distanceToTop: number
    distanceOffset?: number
    worldToUnit?: number
  }) => { inCloud: number; ground: number }

  stats: (side: 'A' | 'B') => ProbeStats
  regions: (side: 'A' | 'B') => { sphere: null; plane: null }
  gpuTiming: (frameCount?: number) => Promise<GpuTimingSummary>
}

/**
 * `__parity` is non-optional here by design. The cast asserts what every spec
 * has already established with `waitForFunction(() => __parity != null)`.
 * Making it optional would only push a `!` onto ~70 call sites.
 */
export type ParityWindow = Window & { __parity: ParityProbe }
