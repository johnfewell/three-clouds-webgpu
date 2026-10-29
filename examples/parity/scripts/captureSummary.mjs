// The end-of-run verdict for capture.mjs, pure so the unit suite pins it
//. A 'fail' exits 1 (except in sabotage mode). A 'skip' produced no
// plate: it is named, never a pass, and exits 1 without --allow-skip (sabotage
// does not excuse it). Otherwise "all N case(s) passed or accepted"

/**
 * @param {ReadonlyArray<{ case?: string, result?: string, reason?: string }>} rows
 * @param {{ allowSkip?: boolean, sabotageMode?: string | null }} [opts]
 */
/**
 * The results a row may legitimately carry. Anything else (including a missing
 * value) is an unaccounted case, not a pass (B9).
 */
export const RECOGNISED_RESULTS = [
  'pass',
  'fail',
  'skip',
  'expected-difference'
]

export function summarizeRun(rows, opts = {}) {
  const allowSkip = opts.allowSkip === true
  const sabotage = opts.sabotageMode != null && opts.sabotageMode !== ''
  const failed = rows.filter(r => r.result === 'fail')
  const skipped = rows.filter(r => r.result === 'skip')
  // B9: a missing or unknown result is NOT a pass. Passes were counted
  // by subtraction, so a forgotten field dropped a case from the verdict
  // Counted as a failure and named: unaccounted is worse than failing
  const unaccounted = rows.filter(
    r => !RECOGNISED_RESULTS.includes(String(r.result))
  )
  const passed =
    rows.length - failed.length - skipped.length - unaccounted.length
  const lines = []
  let exitCode

  if (unaccounted.length > 0) {
    lines.push(
      `[capture] ${unaccounted.length} case(s) have no recognised result — ` +
        `${unaccounted
          .map(r => `${r.case ?? '<unnamed>'}=${JSON.stringify(r.result)}`)
          .join(', ')}. An unaccounted case is not a pass.`
    )
    exitCode = 1
  }

  if (skipped.length > 0) {
    lines.push(
      `[capture] ${skipped.length} case(s) SKIPPED — no plate was produced; ` +
        `a skip is NOT a pass: ` +
        skipped
          .map(r => `${r.case ?? '?'} (${r.reason ?? 'unknown'})`)
          .join(', ')
    )
    if (allowSkip) {
      lines.push('[capture] --allow-skip: accepting a PARTIAL run explicitly')
    } else {
      lines.push(
        '[capture] refusing to report success with skipped cases; pass ' +
          '--allow-skip to accept a partial run explicitly'
      )
      exitCode = 1
    }
  }

  if (failed.length > 0) {
    lines.push(`[capture] ${failed.length} case(s) FAILED`)
    if (!sabotage) exitCode = 1
  } else if (skipped.length === 0) {
    lines.push(`[capture] all ${rows.length} case(s) passed or accepted`)
  } else {
    lines.push(
      `[capture] ${passed} case(s) passed or accepted, ${skipped.length} skipped`
    )
  }

  return {
    lines,
    exitCode,
    failCount: failed.length,
    skipCount: skipped.length
  }
}
