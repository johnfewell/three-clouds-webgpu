// Types for ciE2eVerdict.mjs: plain JS so the node CLI and its TypeScript test
// share one implementation, the same arrangement as freshBuild.d.ts,
// verify-results.d.mts and thresholdSchema.d.mts

export interface E2eVerdict {
  status: 'green' | 'red' | 'stale' | 'missing' | 'dirty' | 'partial'
  detail: string
}

/**
 * Prints the receipt verdict for the current inputs and returns the exit code.
 *
 * Only `red` (a receipt recording actual test failures) returns 1. Every other
 * non-green status returns 0 with a warning: the bench not having caught up is
 * not this commit's red, but it must never read as a pass.
 */
export function reportVerdict(verdict: E2eVerdict, key: string | null): number
