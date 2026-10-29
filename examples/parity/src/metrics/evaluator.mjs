// Evaluate parity metrics against phase thresholds. Plain JavaScript keeps the
// browser-facing TypeScript, capture CLI, and verification CLI on one runtime
// implementation

import { GATED_METRICS } from '../../cases/thresholdSchema.mjs'

// The metric definitions a metrics.json was written against, bumped whenever
// one changes so evidence is never re-graded silently. 1 histDist 256-bin L1,
// 2 mean-normalised W1, 3 ssim L = side A's percentile span, 4 gated at 0.09
export const METRICS_VERSION = 4

// A stored metrics.json is comparable to today's thresholds only at the current
// version. Reasons are hard fails: accepted[] cannot downgrade stale evidence.
export function checkMetricsVersion(version) {
  if (version === METRICS_VERSION) return []
  const found = typeof version === 'number' ? version : 1
  return [
    `stale metrics: metricsVersion ${found} ≠ ${METRICS_VERSION} — ` +
      'metric definitions have changed since this capture (v1→v2 redefined ' +
      'histDist, v2→v3 redefined ssim, v3→v4 re-gated ssim at the reference ' +
      "L), so its numbers are not comparable to today's thresholds; re-capture"
  ]
}

// Fails hard when either side is a black/flat plate; runs before accepted[]
export function checkPlate(check) {
  if (check == null) return []
  const { minStd, minCloudFraction = 0, plate } = check
  if (plate == null) {
    return ['no plate stats — captured before the plate check; re-capture']
  }
  const reasons = []
  for (const side of ['A', 'B']) {
    const stats = plate[side]
    if (!(stats.std >= minStd)) {
      reasons.push(
        `side ${side} is a black/flat plate: luminance std ${stats.std.toFixed(4)} < ${minStd}`
      )
    }
  }
  const cloudFraction = plate.B.cloudFraction
  if (cloudFraction != null && !(cloudFraction >= minCloudFraction)) {
    reasons.push(
      `side B marched no clouds: layer coverage ${(cloudFraction * 100).toFixed(3)}% < ${(minCloudFraction * 100).toFixed(3)}%`
    )
  }
  return reasons
}

function acceptedFloorSsim(entry) {
  return entry.floor == null ? null : entry.floor.ssim
}

function findAcceptedEntry(caseName, accepted) {
  if (!caseName || !accepted) return undefined
  return accepted.find(entry => {
    const pattern = entry.pattern
    return (
      pattern === '*' ||
      caseName === pattern ||
      (pattern.includes('*') && matchGlob(caseName, pattern))
    )
  })
}

export function evaluate(metrics, thresholds, caseName, accepted, plateCheck) {
  const plateReasons = checkPlate(plateCheck)
  if (plateReasons.length > 0) {
    return { result: 'fail', reasons: plateReasons }
  }

  const reasons = []
  // A missing ceiling metric otherwise passes because `null > ceiling` is
  // false. Only require readings for metrics this phase actually gates.
  for (const metric of GATED_METRICS) {
    if (thresholds[metric] == null) continue
    const value = metrics[metric]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reasons.push(
        `${metric} has no reading (${JSON.stringify(value) ?? 'undefined'}) ` +
          'but this phase gates on it — a missing metric is not a pass'
      )
    }
  }
  if (reasons.length > 0) return { result: 'fail', reasons }

  if (thresholds.ssim != null && metrics.ssim < thresholds.ssim) {
    reasons.push(
      `ssim ${metrics.ssim.toFixed(4)} < ${thresholds.ssim.toFixed(4)}`
    )
  }
  if (thresholds.deP95 != null && metrics.deP95 > thresholds.deP95) {
    reasons.push(
      `deP95 ${metrics.deP95.toFixed(2)} > ${thresholds.deP95.toFixed(2)}`
    )
  }
  if (thresholds.histDist != null && metrics.histDist > thresholds.histDist) {
    reasons.push(
      `histDist ${metrics.histDist.toFixed(4)} > ${thresholds.histDist.toFixed(4)}`
    )
  }

  if (reasons.length === 0) return { result: 'pass', reasons: [] }

  const acceptedEntry = findAcceptedEntry(caseName, accepted)
  if (acceptedEntry == null) return { result: 'fail', reasons }

  // An accepted floor is an executable tripwire around the measured
  // footprint. A larger difference is a new failure, not the accepted one
  // described by the register entry
  const floorSsim = acceptedFloorSsim(acceptedEntry)
  if (floorSsim != null && !(metrics.ssim >= floorSsim)) {
    return {
      result: 'fail',
      reasons: [
        ...reasons,
        `beyond the accepted footprint: ssim ${metrics.ssim.toFixed(4)} < floor ${floorSsim.toFixed(4)} (${acceptedEntry.reason})`
      ]
    }
  }

  return {
    result: 'expected-difference',
    reasons: [
      ...reasons,
      `accepted: ${acceptedEntry.reason}` +
        (floorSsim == null ? '' : ` [floor ssim ${floorSsim.toFixed(4)}]`)
    ]
  }
}

function matchGlob(name, pattern) {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  )
  return regex.test(name)
}
