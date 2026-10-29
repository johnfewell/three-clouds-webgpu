// the seq-frame log line gains a per-side
// plate mean, so committed evidence shows whether the accumulator was still
// moving. A module so the ABSENT cases are testable: a side that never
// rendered prints `n/a`, never a real-looking `0.000000`

/** Printed when a value was not measured. Never a number. */
export const ABSENT = 'n/a'

/**
 * Decimal places.
 *
 * Chosen against the FLOOR: run-to-run plate-mean stability is ~1e-6 on values
 * of ~0.05-0.10, so 8 dp (5e-9 quantisation) leaves two decades of headroom.
 * Six would have put the quantisation AT the floor, caught by this module's own
 * test.
 */
export const PRECISION = 8

/**
 * Formats one seq-frame log line.
 *
 * @param {number} frame zero-based frame index
 * @param {number} time seconds into the sequence
 * @param {{ A: number, B: number | null } | null | undefined} plateMean
 *   per-side plate mean for this frame: null/undefined when the step returned
 *   no receipt at all, and `B: null` when side B is absent.
 * @returns {string}
 */
export function formatSeqFrameLine(frame, time, plateMean) {
  return (
    `seq-frame: frame=${frame} time=${time.toFixed(3)} ` +
    `plateMeanA=${fmt(plateMean?.A)} plateMeanB=${fmt(plateMean?.B)}`
  )
}

/**
 * A measured number, or ABSENT.
 *
 * Non-finite values (NaN, Infinity) read as ABSENT too: a NaN mean means the
 * statistic could not be computed, which is an absence, and printing `NaN`
 * invites it into a later average as though it were data.
 *
 * @param {number | null | undefined} v
 * @returns {string}
 */
function fmt(v) {
  return typeof v === 'number' && Number.isFinite(v)
    ? v.toFixed(PRECISION)
    : ABSENT
}
