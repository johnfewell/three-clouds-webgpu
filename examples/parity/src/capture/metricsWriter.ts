// Format and validate metrics.json output for a capture run

// the shape is already defined for the runner. Importing it here
// rather than restating it keeps one definition of what provenance IS
import type { CaptureProvenance } from '../../scripts/captureProvenance.mjs'
// METRICS_VERSION is imported, never redeclared (a local copy made
// this a stale fourth site of the contract). Moving the constant and
// verdict into evaluator.mjs, shared with capture.mjs
import {
  METRICS_VERSION,
  type EvalDetail,
  type FlickerResult,
  type GhostingResult,
  type GpuTimingSummary,
  type Metrics,
  type MotionDirectionResult,
  type MotionVectorResult,
  type PlateStats,
  type SsimAttribution
} from '../metrics'

/**
 * Per-SIDE sequence results. A single shared `flicker`/`ghosting` once made the
 * formatter write side A's numbers as side B's, invisible until a sequence case
 * went through this writer.
 */
export interface SequenceCaptureMetrics {
  flickerA: FlickerResult
  flickerB: FlickerResult
  ghostingA?: GhostingResult
  ghostingB?: GhostingResult
  motionA?: MotionVectorResult | null
  motionB?: MotionVectorResult | null
  motionDirection?: MotionDirectionResult | null
  frameCount: number
}

/**
 * The plate block. `evaluate`'s plate check reads these, so a writer that drops
 * them silently disarms the black-frame gate, which is why the unification
 * cannot be a straight swap onto the old, narrower schema.
 */
export interface PlateSchema {
  A: { mean: number; std: number }
  B: { mean: number; std: number; cloudFraction: number | null }
}

export interface CaptureMetrics {
  caseName: string
  phase: number
  metrics: Metrics
  eval: EvalDetail
  maxDiffDelta: number
  dimensions: { width: number; height: number }
  timing: { captureMs: number; metricsMs: number }
  /** Which readback the metrics came from. ADR-011 requires linear. */
  readback?: string
  plate?: { A: PlateStats; B: PlateStats } | null
  ssimAttribution?: SsimAttribution | null
  /**
   * chain of custody (commit, inputs key, e2e verdict, overrides,
   * served-vs-built digests). It reached capture.log but not metrics.json
   * until this interface declared it: an undeclared field is dropped here.
   */
  provenance?: CaptureProvenance | null
  /**
   * the EFFECTIVE temporalUpscale on each side at capture time, read
   * back from the live objects, not the case declaration. Declared here since
   * this boundary drops undeclared fields. `null` means the
   * probe was unreachable, never "both sides agreed".
   */
  temporalUpscale?: { A: boolean; B: boolean | null } | null
  /** the shaded-fraction receipt of a shadow case, null otherwise */
  shadedFraction?:
    ShadedFractionRecord | ShadedFractionError | ShadedFractionSkipped | null
  /**
   * the packed debug plate's per-channel agreement, or null on a case
   * that declares no atlas gate. Declared for the same re-key reason as the
   * block above: metrics.json is written by formatMetricsJson alone
   */
  atlasChannels?: AtlasChannelRecord | AtlasChannelError | null
  /**
   * fraction of pixels still changing between the last two warm-up
   * frames, per side: the capture's own STATIONARITY record. null when the
   * probe could not be read, and per side for a case with warmup 0.
   *
   * declared HERE, not only in capture.mjs. metrics.json is written by
   * formatMetricsJson alone, so an undeclared field is silently dropped.
   */
  convergence?: { A: number | null; B: number | null } | null
  /**
   * Whether the renderer offered the `subgroups` feature, read page-side from
   * `renderer.hasFeature('subgroups')`. It decides whether the default
   * half-resolution shaft march actually ran, and a receipt that cannot say so
   * is compatible with both paths. null when the probe could not be read, never
   * omitted: an absent key and a false feature are different claims.
   */
  subgroups?: boolean | null
  /**
   * the site-2 PCF radius receipt, or null on a non-shadow case.
   * Declared for the reason above: this writer is a THIRD re-key boundary
   * after capture.mjs's two, and the source guard now covers it too.
   */
  shadowRadius?: {
    laneAbsent: boolean
    error: string | null
    reasons: string[]
    lanePixels: number | null
    framePixels: number | null
    summary: {
      sampled: number
      classified: number
      min: number
      median: number
      p95: number
      max: number
      armedFraction: number
      atCeilingFraction: number
    } | null
  } | null
  sequence?: SequenceCaptureMetrics
  gpuMs?: GpuTimingSummary
}

/** One side of the shaded-fraction receipt as the runner writes it (rounded) */
export interface ShadedFractionSideRecord {
  fraction: number
  meanOn: number
  meanOff: number
  rise: number
  classified: number
}

/** The shaded-fraction receipt plus its verdict, as written to metrics.json */
export interface ShadedFractionRecord {
  A: ShadedFractionSideRecord
  B: ShadedFractionSideRecord
  /** NOT a comparison under 'b-only', where side A has no consumer */
  ratio: number
  /**
   * the policy the capture graded under, so verify-results re-grades
   * case 35 the way it was captured. Absent on evidence captured before it
   * existed, which means 'ratio'
   */
  compare?: 'ratio' | 'b-only'
  flagsOff: { A: boolean[]; B: boolean[] | null }
  flagsRestored: { A: boolean[]; B: boolean[] | null }
  reasons: string[]
}

/** the packed debug plate's per-channel agreement */
export interface AtlasChannelRecord {
  A: { r: number; g: number; b: number }
  B: { r: number; g: number; b: number }
  /** B.mean / A.mean for all three, gated or not */
  ratio: { r: number; g: number; b: number }
  deviation: { r: number; g: number; b: number }
  /** Only these are scored. An absent entry is a capture-time refusal */
  gated: ('r' | 'g' | 'b')[]
  tolerance: number
  reasons: string[]
}

export interface AtlasChannelError {
  error: string
}

/** The receipt could not be taken (probe missing / threw): a hard fail */
export interface ShadedFractionError {
  error: string
}

/** The case declared the receipt not applicable, with the reason (registry) */
export interface ShadedFractionSkipped {
  skipped: string
}

export interface CaptureEnv {
  chrome: string
  adapter: string
  os: string
  gpu: string
}

export function formatMetricsJson(m: CaptureMetrics): string {
  const base: Record<string, unknown> = {
    case: m.caseName,
    phase: m.phase,
    readback: m.readback ?? 'linear',
    metricsVersion: METRICS_VERSION,
    ssim: round6(m.metrics.ssim),
    deMean: round2(m.metrics.deMean),
    deP95: round2(m.metrics.deP95),
    histDist: round6(m.metrics.histDist),
    plate:
      m.plate == null
        ? null
        : {
            A: { mean: round6(m.plate.A.mean), std: round6(m.plate.A.std) },
            B: {
              mean: round6(m.plate.B.mean),
              std: round6(m.plate.B.std),
              cloudFraction:
                m.plate.B.cloudFraction == null
                  ? null
                  : round6(m.plate.B.cloudFraction)
            }
          },
    provenance: m.provenance ?? null,
    // null = probe unreachable, NOT 'the sides agreed'
    temporalUpscale: m.temporalUpscale ?? null,
    ssimAttribution: m.ssimAttribution ?? null,
    shadedFraction: m.shadedFraction ?? null,
    // null = the case declares no atlas gate. A REFUSAL is an object
    // whose reasons[] says why, same rule as shadowRadius above
    atlasChannels: m.atlasChannels ?? null,
    convergence: m.convergence ?? null,
    // null = not a shadow case. A REFUSAL is not null: it arrives as
    // an object whose reasons[] says why, because a receipt that cannot record
    // its own refusal is the thing this task keeps rediscovering
    shadowRadius: m.shadowRadius ?? null,
    // null = the probe was unreachable, NOT 'the device lacked subgroups'
    subgroups: m.subgroups ?? null,
    result: m.eval.result,
    reasons: m.eval.reasons,
    maxDiffDelta: round6(m.maxDiffDelta),
    width: m.dimensions.width,
    height: m.dimensions.height,
    captureMs: Math.round(m.timing.captureMs),
    metricsMs: Math.round(m.timing.metricsMs)
  }
  if (m.sequence) {
    const seq: Record<string, unknown> = {
      frameCount: m.sequence.frameCount,
      flickerA: {
        mean: round2(m.sequence.flickerA.mean),
        max: round2(m.sequence.flickerA.max)
      },
      flickerB: {
        mean: round2(m.sequence.flickerB.mean),
        max: round2(m.sequence.flickerB.max)
      }
    }
    if (m.sequence.ghostingA) {
      seq.ghostingA = {
        mean: round2(m.sequence.ghostingA.deMean),
        p95: round2(m.sequence.ghostingA.deP95)
      }
    }
    if (m.sequence.ghostingB) {
      seq.ghostingB = {
        mean: round2(m.sequence.ghostingB.deMean),
        p95: round2(m.sequence.ghostingB.deP95)
      }
    }
    seq.motionA = formatMotionVector(m.sequence.motionA)
    seq.motionB = formatMotionVector(m.sequence.motionB)
    seq.motionDirection = formatMotionDirection(m.sequence.motionDirection)
    base.sequence = seq
  }
  if (m.gpuMs) {
    base.gpuMs = formatGpuTimingSummary(m.gpuMs)
  }
  return JSON.stringify(base, null, 2)
}

export function formatEnvJson(env: CaptureEnv): string {
  return JSON.stringify(env, null, 2)
}

export interface SequenceSideFlicker {
  mean: number
  max: number
}

export interface SequenceSideGhosting {
  mean: number
  p95: number
}

export interface SequenceSchema {
  frameCount: number
  flickerA: SequenceSideFlicker
  flickerB: SequenceSideFlicker
  ghostingA?: SequenceSideGhosting
  ghostingB?: SequenceSideGhosting
  motionA?: MotionVectorResult | null
  motionB?: MotionVectorResult | null
  motionDirection?: MotionDirectionResult | null
}

export interface GpuMsSideSchema {
  medianMs: number
  passes: Record<string, number>
  sampleCount: number
}

export interface GpuMsSchema {
  sideA: GpuMsSideSchema | null
  sideB: GpuMsSideSchema | null
  sideAReason?: string
  sideBReason?: string
}

export interface MetricsSchema {
  metricsVersion: number
  case: string
  readback?: string
  /** chain of custody, null only when the runner supplied none */
  provenance?: CaptureProvenance | null
  /** effective temporalUpscale per side; null = probe unreachable */
  temporalUpscale?: { A: boolean; B: boolean | null } | null
  plate?: PlateSchema | null
  ssimAttribution?: Record<string, unknown> | null
  shadedFraction?:
    ShadedFractionRecord | ShadedFractionError | ShadedFractionSkipped | null
  /** null unless the case declares an atlas-channel gate */
  atlasChannels?: AtlasChannelRecord | AtlasChannelError | null
  convergence?: { A: number | null; B: number | null } | null
  /** renderer `subgroups` support at capture time; null = not probed */
  subgroups?: boolean | null
  phase: number
  ssim: number
  deMean: number
  deP95: number
  histDist: number
  result: string
  reasons: string[]
  maxDiffDelta: number
  width: number
  height: number
  captureMs: number
  metricsMs: number
  sequence?: SequenceSchema
  gpuMs?: GpuMsSchema
}

export function validateMetricsJson(json: string): MetricsSchema {
  const obj = JSON.parse(json) as Record<string, unknown>
  const required = [
    'metricsVersion',
    'case',
    'phase',
    'ssim',
    'deMean',
    'deP95',
    'histDist',
    'result',
    'reasons',
    'maxDiffDelta',
    'width',
    'height',
    'captureMs',
    'metricsMs'
  ]
  for (const key of required) {
    if (!(key in obj)) throw new Error(`Missing key: ${key}`)
  }
  if (typeof obj.metricsVersion !== 'number')
    throw new Error('metricsVersion must be number')
  if (typeof obj.case !== 'string') throw new Error('case must be string')
  if (typeof obj.phase !== 'number') throw new Error('phase must be number')
  if (typeof obj.ssim !== 'number') throw new Error('ssim must be number')
  if (!Array.isArray(obj.reasons)) throw new Error('reasons must be array')
  // Typed, but NOT in `required`: that would reject every committed metrics.json
  // written before the field existed. The writer always emits it, and the source
  // guard below is what holds that across capture.mjs's three re-key boundaries
  if (
    obj.subgroups !== undefined &&
    obj.subgroups !== null &&
    typeof obj.subgroups !== 'boolean'
  ) {
    throw new Error('subgroups must be boolean or null')
  }
  if (!['pass', 'fail', 'expected-difference'].includes(obj.result as string)) {
    throw new Error(`Invalid result: ${String(obj.result)}`)
  }
  if (obj.shadedFraction != null) {
    const sf = obj.shadedFraction as Record<string, unknown>
    if (typeof sf.error !== 'string' && typeof sf.skipped !== 'string') {
      if (typeof sf.ratio !== 'number') {
        throw new Error('shadedFraction.ratio must be number')
      }
      if (!Array.isArray(sf.reasons)) {
        throw new Error('shadedFraction.reasons must be array')
      }
    }
  }
  if (obj.atlasChannels != null) {
    const ac = obj.atlasChannels as Record<string, unknown>
    if (typeof ac.error !== 'string') {
      // An empty gated list is a REFUSAL at capture time, not a schema error:
      // the receipt arrives carrying the reason, and this layer must not
      // quietly turn that into a shape complaint
      if (!Array.isArray(ac.gated)) {
        throw new Error('atlasChannels.gated must be array')
      }
      if (!(typeof ac.tolerance === 'number')) {
        throw new Error('atlasChannels.tolerance must be number')
      }
      const ratio = ac.ratio as Record<string, unknown> | undefined
      for (const c of ['r', 'g', 'b']) {
        if (typeof ratio?.[c] !== 'number') {
          throw new Error(`atlasChannels.ratio.${c} must be number`)
        }
      }
      if (!Array.isArray(ac.reasons)) {
        throw new Error('atlasChannels.reasons must be array')
      }
    }
  }
  if (obj.sequence != null) {
    const seq = obj.sequence as Record<string, unknown>
    if (typeof seq.frameCount !== 'number')
      throw new Error('sequence.frameCount must be number')
    const flickerA = seq.flickerA as Record<string, unknown> | undefined
    const flickerB = seq.flickerB as Record<string, unknown> | undefined
    if (
      !flickerA ||
      typeof flickerA.mean !== 'number' ||
      typeof flickerA.max !== 'number'
    ) {
      throw new Error('sequence.flickerA must have numeric mean and max')
    }
    if (
      !flickerB ||
      typeof flickerB.mean !== 'number' ||
      typeof flickerB.max !== 'number'
    ) {
      throw new Error('sequence.flickerB must have numeric mean and max')
    }
    validateMotionVector(seq.motionA, 'sequence.motionA')
    validateMotionVector(seq.motionB, 'sequence.motionB')
    if (seq.motionDirection != null) {
      const direction = seq.motionDirection as Record<string, unknown>
      if (
        typeof direction.aligned !== 'boolean' ||
        typeof direction.comparable !== 'boolean' ||
        (direction.cosine !== null && typeof direction.cosine !== 'number')
      ) {
        throw new Error(
          'sequence.motionDirection must have boolean aligned/comparable and numeric/null cosine'
        )
      }
    }
  }
  return obj as unknown as MetricsSchema
}

function formatMotionVector(
  motion: MotionVectorResult | null | undefined
): MotionVectorResult | null {
  return motion == null
    ? null
    : {
        dx: round2(motion.dx),
        dy: round2(motion.dy),
        score: round6(motion.score)
      }
}

function formatMotionDirection(
  direction: MotionDirectionResult | null | undefined
): MotionDirectionResult | null {
  return direction == null
    ? null
    : {
        aligned: direction.aligned,
        comparable: direction.comparable,
        cosine: direction.cosine == null ? null : round6(direction.cosine)
      }
}

function validateMotionVector(value: unknown, path: string): void {
  if (value == null) return
  const motion = value as Record<string, unknown>
  if (
    typeof motion.dx !== 'number' ||
    typeof motion.dy !== 'number' ||
    typeof motion.score !== 'number'
  ) {
    throw new Error(`${path} must have numeric dx, dy and score`)
  }
}

function formatGpuTimingSummary(summary: GpuTimingSummary): GpuMsSchema {
  const result: GpuMsSchema = {
    sideA: null,
    sideB: null
  }

  if (summary.sideA.available) {
    const r = summary.sideA.report
    result.sideA = {
      medianMs: round2(r.medianMs),
      passes: Object.fromEntries(
        Object.entries(r.passes).map(([k, v]) => [k, round2(v)])
      ),
      sampleCount: r.sampleCount
    }
  } else {
    result.sideAReason = summary.sideA.reason
  }

  if (summary.sideB.available) {
    const r = summary.sideB.report
    result.sideB = {
      medianMs: round2(r.medianMs),
      passes: Object.fromEntries(
        Object.entries(r.passes).map(([k, v]) => [k, round2(v)])
      ),
      sampleCount: r.sampleCount
    }
  } else {
    result.sideBReason = summary.sideB.reason
  }

  return result
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
