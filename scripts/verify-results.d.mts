// Types for verify-results.mjs: plain JS because it is a node CLI, while its
// pure helpers are unit-tested from TypeScript. Same arrangement as
// examples/parity/scripts/freshBuild.d.ts: one implementation, two consumers

import type {
  AcceptedDifference,
  EvalDetail,
  Metrics,
  PhaseThresholds,
  PlateCheck
} from '../examples/parity/src/metrics/evaluator.mjs'

export const SHADED_RATIO_FLOOR: number
export const MIN_SIGNAL_FRACTION: number

export function checkShadedFraction(sf: unknown): string[]

/**
 * the packed debug plate's per-channel agreement. Only the `gated`
 * channels are scored, so the ungated frontDepth divergence can neither fail
 * this nor excuse the ones that decide optical depth
 */
export function checkAtlasChannels(ac: unknown): string[]

/**
 * the capture's own e2e stamp, read at
 * verify time. A RED stamp is a hard fail (never downgradeable by accepted[]);
 * every other state is an annotation, matching the capture-time policy
 */
export function checkE2eReceipt(provenance: unknown): string[]

/**
 * the states a reviewer must SEE but
 * that are not failures (a non-green verdict, the per-run override, the two
 * build skips)
 */
export function e2eReceiptAnnotations(provenance: unknown): string[]

/** Apply verifier-only receipt gates, then the shared threshold evaluator */
export function evaluateCommittedMetrics(
  metrics: Metrics & {
    metricsVersion?: unknown
    shadedFraction?: unknown
  },
  thresholds: PhaseThresholds,
  caseName?: string,
  accepted?: AcceptedDifference[],
  plateCheck?: PlateCheck
): EvalDetail

/**
 * ADR-011 Amendment 9: does a case's verdict lean on its
 * shaded-fraction receipt?
 *
 * Only load-bearing receipts have their provenance checked. A declared skip
 * carries its reason and is not evidence, and a receipt that could not be taken
 * already fails on its own. Pairs with `isPreCorrection`
 */
export function shadedFractionIsLoadBearing(sf: unknown): boolean

/**
 * Was this artifact produced by a build that predates the off-arm
 * correction (f4f5111)?
 *
 * `isAncestorOfFix` tests the fix against the last commit to touch the file.
 * Anything but an explicit `true` (unknown SHA, indeterminate ancestry) counts
 * as PRE: an artifact whose provenance cannot be established is not evidence
 */
export function isPreCorrection(
  lastCommitSha: string | null | undefined,
  isAncestorOfFix: boolean | null | undefined
): boolean

/** cases failed. Routine, and the reason this script exists */
export const EXIT_FAILURES: number
/**
 * the thresholds file failed its own contract, so every gate below it
 * is meaningless. Distinct from EXIT_FAILURES so a caller reading only the exit
 * code cannot mistake a broken instrument for an expected red.
 */
export const EXIT_BROKEN_GATE: number
