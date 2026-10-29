// a phase threshold is a NUMBER, or `null` for "not set". A string
// placeholder passed every `!= null` guard, then silently gated nothing in all
// three evaluators (phase 4 lost deP95 and histDist). Checked once at load,
// here, shared by the TS consumer and the node CLIs. `null` is deliberately
// visible: that metric is UNGATED for the phase

/** Phase-threshold keys that gate a metric */
export const GATED_METRICS = ['ssim', 'deP95', 'histDist']

/**
 * a broken instrument is not an expected red.
 *
 * `1` means work failed, which is routine. A corrupt thresholds file means the
 * gate itself cannot be trusted, and sharing one exit code lets a caller
 * reading only the code (CI, a pre-capture check) carry on regardless.
 *
 * They live HERE, beside the contract, because both CLIs that load thresholds
 * (verify-results.mjs, capture.mjs) need them. Same distinction as a SKIP that
 * is not a PASS.
 */
export const EXIT_FAILURES = 1
export const EXIT_BROKEN_GATE = 2

/**
 * Throws if any phase threshold is neither a finite number nor null.
 *
 * Only `phases[N]` values are checked: siblings like `plate.reason` are prose
 * by design, and validating them would be the kind of over-broad rule that gets
 * switched off.
 */
export function validateThresholds(thresholds) {
  const phases = thresholds?.phases
  if (phases == null) return thresholds
  for (const [phase, values] of Object.entries(phases)) {
    if (values == null || typeof values !== 'object') {
      throw new Error(`thresholds.json: phase ${phase} is not an object`)
    }
    for (const [metric, value] of Object.entries(values)) {
      if (value === null) continue
      if (typeof value === 'number' && Number.isFinite(value)) continue
      throw new Error(
        `thresholds.json: phase ${phase} ${metric} = ${JSON.stringify(value)} ` +
          `is neither a number nor null. A placeholder string passes every ` +
          `\`!= null\` guard and then silently becomes NO GATE — use null to ` +
          `declare a metric unmeasured.`
      )
    }
  }
  return thresholds
}

/**
 * The gated metrics a phase leaves unset, in registry order.
 *
 * An unset threshold is legitimate (a phase can be captured before its floors
 * are known), but it must be reported, because "no threshold" and "threshold
 * met" are indistinguishable in a results table.
 */
export function unsetMetrics(phaseThresholds) {
  if (phaseThresholds == null) return []
  return GATED_METRICS.filter(
    m => !(m in phaseThresholds) || phaseThresholds[m] === null
  )
}
