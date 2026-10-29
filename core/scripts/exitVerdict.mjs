// The Phase A exit test's verdict, kept apart from the GPU run so it can be
// tested: a case passes only when every compared texture is byte-identical
// AND every positive control moved, since a dead comparator also reads zero

// Five graphs: the default, temporal upscale, light shafts, four layers with
// shadow, and a low sun on four 1024 cascades
export const EXIT_CASES = [
  'baseline-medium',
  'temporal-on-orbit',
  'shafts-low-sun',
  'layers-4-shadow',
  'shadow-cascades-4x1024'
]

/** Controls that must move the output, and the texture each must move */
export const REQUIRED_CONTROLS = {
  // two more frames from reset must change the converging linear output
  extraFrame: ['linear'],
  // a sun nudged in the CPU state must reach the march and the composite
  sunNudge: ['linear', 'layer']
}

/**
 * @param {string} name
 * @param {any} report prove-runtime.mjs's report.json
 * @returns {{ case: string, pass: boolean, reasons: string[], compared: number,
 *   identical: number, skipped: string[], differingBytes: number, maxDiff: number,
 *   controls: Record<string, number> }}
 */
export function caseVerdict(name, report) {
  const reasons = []
  const results = Object.entries(report?.results ?? {})
  const skipped = results
    .filter(([, r]) => r.skipped != null)
    .map(([t, r]) => `${t} (${r.skipped})`)
  const compared = results.filter(([, r]) => r.skipped == null)
  let identical = 0
  let differingBytes = 0
  let maxDiff = 0
  for (const [texture, r] of compared) {
    if (r.mismatchedShape != null) {
      reasons.push(`${texture}: shape differs`)
      continue
    }
    if (typeof r.differing !== 'number') {
      reasons.push(`${texture}: no comparison`)
      continue
    }
    differingBytes += r.differing
    maxDiff = Math.max(maxDiff, r.maxDiff ?? (r.differing > 0 ? Infinity : 0))
    if (r.differing === 0) identical++
    else reasons.push(`${texture}: ${r.differing} bytes differ`)
  }
  // A comparison over nothing is a failed comparison, not a pass
  if (compared.length === 0) reasons.push('no textures compared')
  for (const error of report?.errors ?? []) reasons.push(`GPU error: ${error}`)

  const controls = {}
  for (const [control, textures] of Object.entries(REQUIRED_CONTROLS)) {
    for (const texture of textures) {
      const key = `${control}:${texture}`
      const moved = report?.controls?.[key]?.differing
      controls[key] = typeof moved === 'number' ? moved : -1
      if (!(typeof moved === 'number' && moved > 0)) {
        reasons.push(
          `control ${key} did not move the output: comparator not proven live`
        )
      }
    }
  }
  return {
    case: name,
    pass: reasons.length === 0,
    reasons,
    compared: compared.length,
    identical,
    skipped,
    differingBytes,
    maxDiff,
    controls
  }
}

// Faults injected into a compared run. Each must make the run FAIL on
// differing bytes, which proves the comparator end to end through the verdict
export const EXIT_FAULTS = ['sun', 'frame']

/**
 * @returns {{ fault: string, caught: boolean, differingBytes: number }}
 */
export function faultVerdict(fault, report) {
  const v = caseVerdict(`fault:${fault}`, report)
  const differs = v.reasons.some(r => / bytes differ$/.test(r))
  return {
    fault,
    // A fault run that errored or compared nothing proves nothing either
    caught: report?.fault === fault && v.compared > 0 && differs,
    differingBytes: v.differingBytes
  }
}

/** The run's verdict: every case passes, every fault is caught */
export function runVerdict(expectedCases, verdicts, faults = null) {
  const seen = verdicts.map(v => v.case)
  const missing = expectedCases.filter(c => !seen.includes(c))
  const failed = verdicts.filter(v => !v.pass).map(v => v.case)
  const uncaught =
    faults == null
      ? []
      : EXIT_FAULTS.filter(f => !faults.some(x => x.fault === f && x.caught))
  return {
    pass:
      missing.length === 0 &&
      failed.length === 0 &&
      uncaught.length === 0 &&
      verdicts.length > 0,
    missing,
    failed,
    uncaught
  }
}

/** One markdown table row per case */
export function formatTable(verdicts) {
  const head =
    '| case | textures compared | identical | max byte diff | sun nudge: linear bytes moved | extra frame: linear bytes moved | verdict |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |'
  const rows = verdicts.map(
    v =>
      `| ${v.case} | ${v.compared} | ${v.identical} | ${v.maxDiff} | ` +
      `${v.controls['sunNudge:linear']} | ${v.controls['extraFrame:linear']} | ` +
      `${v.pass ? 'PASS' : 'FAIL: ' + v.reasons.join('; ')} |`
  )
  return [head, ...rows].join('\n')
}
