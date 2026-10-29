// Types for thresholdSchema.mjs: plain JS so the node CLIs (capture.mjs,
// verify-results.mjs) and the TypeScript evaluator can share ONE
// implementation instead of a fourth copy of the rule. Same
// arrangement as freshBuild.d.ts and verify-results.d.mts

export const GATED_METRICS: readonly string[]

/** work failed, which is routine */
export const EXIT_FAILURES: number
/**
 * the thresholds file failed its own contract, so every gate below it
 * is meaningless. Distinct from EXIT_FAILURES so a caller reading only the exit
 * code cannot mistake a broken instrument for an expected red.
 */
export const EXIT_BROKEN_GATE: number

/**
 * Throws if any `phases[N]` threshold is neither a finite number nor null.
 * Returns the same object so it can wrap a JSON.parse at the load site.
 */
export function validateThresholds<T>(thresholds: T): T

/** Which gated metrics a phase leaves unset (absent or null) */
export function unsetMetrics(
  phaseThresholds: Record<string, unknown> | null | undefined
): string[]
