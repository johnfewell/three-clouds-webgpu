// the convergence receipt's arithmetic, extracted from main.ts (an
// entry module with side effects cannot be unit tested, and the last inline
// copy drifted), as warmupFramePlan was

/**
 * Half of one fp16 ULP (2^-13 / 2).
 *
 * Below this a pixel cannot be said to have changed in a half-float pipeline,
 * so a smaller threshold would report quantisation as motion and every capture
 * would look unconverged.
 */
export const CONVERGENCE_EPSILON = 6.1035e-5

/**
 * Fraction of pixels whose colour moved between two linear RGBA plates.
 *
 * The capture's receipt about itself: ~0 means the accumulator had settled,
 * a large value means a snapshot of a still-moving average (measured: 71.88 %
 * cold vs ~0 % warm, indistinguishable in the artifact).
 *
 * It measures STATIONARITY, not REPRODUCIBILITY: a green receipt is necessary
 * but not sufficient (measured: four stationary runs, four states on case 36).
 * Reproducibility comes from the N-run sweep, which ADR-011 A6 quotes.
 */
export function changedFraction(
  prev: ArrayLike<number>,
  curr: ArrayLike<number>,
  epsilon: number = CONVERGENCE_EPSILON
): number {
  // The shorter of the two, so a truncated read reports on what it actually has
  // rather than indexing past the end and counting undefined as a change
  const n = Math.floor(Math.min(prev.length, curr.length) / 4)
  if (n === 0) return 0
  let changed = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (
      Math.abs(prev[o]! - curr[o]!) > epsilon ||
      Math.abs(prev[o + 1]! - curr[o + 1]!) > epsilon ||
      Math.abs(prev[o + 2]! - curr[o + 2]!) > epsilon
    ) {
      changed++
    }
  }
  return changed / n
}
