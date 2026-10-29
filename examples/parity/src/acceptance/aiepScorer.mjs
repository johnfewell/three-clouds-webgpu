// Acceptance scorer: what changed per case between the committed
// results and a fresh tree. It reads each tree's RECORDED verdict rather than
// re-deriving it (a fourth `evaluate` copy would be its own defect). Lives in
// src/ so vitest collects its test
//   node examples/parity/src/acceptance/aiepScorer.mjs --new <dir> [--old <dir>]

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ADR-011 Amendment 7's CROSS-SESSION reproducibility floor (N=10).
 *
 * A re-capture is a different session, so this is the floor a single-run delta
 * is judged against, not the tighter in-session figure (2.79e-6), which would
 * call ordinary session-to-session noise a change.
 */
export const CROSS_SESSION_FLOOR = 1.1e-5

/** Verdict strings a capture records. Anything else is unrecognised, not a pass. */
export const VERDICTS = ['pass', 'fail', 'expected-difference']

/** Printed when a value was not measured. Never a number, never a verdict. */
export const ABSENT = 'n/a'

/**
 * The verdict a capture recorded for itself, or null when the log does not say.
 *
 * null is NOT a pass and NOT a failure of the case: it is the absence of a
 * recorded decision, which is a defect in the tree being scored.
 *
 * @param {string} logText
 * @returns {'pass' | 'fail' | 'expected-difference' | null}
 */
export function parseVerdict(logText) {
  // Longest first: 'expected-difference' contains no other verdict as a prefix,
  // but matching 'fail' inside a reason string would be a false positive, so the
  // pattern is anchored to the 'eval: ' marker the capture writes
  const m = /\beval: (expected-difference|pass|fail)\b/.exec(logText)
  // eslint-disable-next-line no-comment-slop/no-trailing-comment -- an inline JSDoc type cast, not prose
  return m == null ? null : /** @type {any} */ (m[1])
}

/**
 * Per-frame plate-mean series recorded by the per-frame harness.
 *
 * Returns [] when the case has no sequence, and never null for a
 * present-but-empty series. The caller tells "no series expected" from
 * "series expected and missing" using the case registry, not this function.
 *
 * @param {string} logText
 * @returns {Array<{ frame: number, plateMeanA: string, plateMeanB: string }>}
 */
export function parseSeqFrames(logText) {
  const out = []
  const re =
    /seq-frame: frame=(\d+) time=[\d.]+ plateMeanA=(\S+) plateMeanB=(\S+)/g
  let m
  while ((m = re.exec(logText)) != null) {
    out.push({ frame: Number(m[1]), plateMeanA: m[2], plateMeanB: m[3] })
  }
  return out
}

/**
 * Did this capture run a sequence at all?
 *
 * Matches the BARE `seq-frame:` marker, not the plate-mean fields: the baseline
 * predates them, so requiring them would call every baseline "no sequence".
 * The sequence set is derived from the BASELINE's logs, not hardcoded, since a
 * hand-synced count goes stale.
 *
 * @param {string} logText
 * @returns {boolean}
 */
export function hasSequence(logText) {
  return /\bseq-frame:/.test(logText)
}

/**
 * Reads one case directory. Every field is either a measurement or null, never
 * a stand-in value that could be mistaken for one.
 *
 * @param {string} dir
 * @returns {{ ssim: number | null, verdict: string | null, hasMask: boolean,
 *   seqFrames: Array<object>, hasLog: boolean, hasMetrics: boolean }}
 */
export function readCase(dir) {
  const metricsPath = join(dir, 'metrics.json')
  const logPath = join(dir, 'capture.log')
  const hasMetrics = existsSync(metricsPath)
  const hasLog = existsSync(logPath)

  let ssim = null
  if (hasMetrics) {
    try {
      const v = JSON.parse(readFileSync(metricsPath, 'utf8')).ssim
      ssim = typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch {
      ssim = null
    }
  }

  const logText = hasLog ? readFileSync(logPath, 'utf8') : ''
  return {
    ssim,
    verdict: hasLog ? parseVerdict(logText) : null,
    hasMask: existsSync(join(dir, 'cloud-mask.png')),
    seqFrames: parseSeqFrames(logText),
    hasLog,
    hasMetrics
  }
}

/** `<phase>/<case>` for every case directory under a results tree */
export function listCases(root) {
  const out = []
  if (!existsSync(root)) return out
  for (const phase of readdirSync(root).sort()) {
    const phaseDir = join(root, phase)
    let entries
    try {
      entries = readdirSync(phaseDir).sort()
    } catch {
      continue
    }
    for (const name of entries) {
      if (existsSync(join(phaseDir, name, 'metrics.json'))) {
        out.push(`${phase}/${name}`)
      }
    }
  }
  return out
}

/**
 * Scores one case.
 *
 * `expectsSeries` comes from the CASE REGISTRY, not from the data: a series that
 * is absent because none was expected and one that is absent because the
 * harness stopped writing it are different facts, and only the registry
 * distinguishes them.
 *
 * @param {string} name
 * @param {ReturnType<typeof readCase> | null} before
 * @param {ReturnType<typeof readCase> | null} after
 * @param {{ expectsSeries: boolean }} opts
 */
export function scoreCase(name, before, after, opts) {
  const problems = []
  const notes = []

  if (after == null) {
    return {
      name,
      oldSsim: before?.ssim ?? null,
      newSsim: null,
      delta: null,
      moved: null,
      flip: null,
      verdict: 'DROPPED',
      problems: ['present in old tree, absent in new'],
      // Same shape on every path: a caller must never have to check whether a
      // field exists before reading it, or "absent field" and "empty field"
      // become two ways of saying nothing
      notes: []
    }
  }
  if (before == null) {
    notes.push('new case, no baseline')
  }

  const oldSsim = before?.ssim ?? null
  const newSsim = after.ssim
  if (newSsim == null)
    problems.push('new metrics.json missing or unreadable ssim')
  if (!after.hasLog) problems.push('new capture.log missing')
  if (after.verdict == null && after.hasLog) {
    problems.push('new capture.log records no eval verdict')
  }
  if (!after.hasMask) problems.push('cloud-mask.png missing')
  // The baseline recorded a series and the new tree did not. Ambiguous (a
  // harness regression or a registry change: 7 baseline cases carry series, 4
  // are declared), so it gets its own loud verdict and no exit code
  const seriesAbsent = opts.expectsSeries && after.seqFrames.length === 0
  if (seriesAbsent) {
    notes.push(
      'baseline recorded a per-frame series, new tree did not — harness ' +
        'regression or registry change, not decidable from the trees'
    )
  }
  if (opts.expectsSeries && after.seqFrames.length > 0) {
    const absent = after.seqFrames.filter(
      f => f.plateMeanA === ABSENT || f.plateMeanB === ABSENT
    ).length
    if (absent > 0) {
      notes.push(`${absent}/${after.seqFrames.length} frames carry ${ABSENT}`)
    }
  }

  const delta = oldSsim != null && newSsim != null ? newSsim - oldSsim : null
  // "moved" is null when it could not be computed, never false, which would
  // read as "measured and unchanged"
  const moved = delta == null ? null : Math.abs(delta) > CROSS_SESSION_FLOOR
  const flip =
    before?.verdict != null && after.verdict != null
      ? before.verdict !== after.verdict
      : null

  let verdict
  if (problems.length > 0) verdict = 'INCOMPLETE'
  else if (seriesAbsent) verdict = 'SERIES-ABSENT'
  else if (flip === true) verdict = `FLIP ${before.verdict}->${after.verdict}`
  else if (flip === null) verdict = 'UNCOMPARABLE'
  else if (moved === true) verdict = 'MOVED'
  else if (moved === false) verdict = 'STABLE'
  else verdict = 'UNCOMPARABLE'

  return {
    name,
    oldSsim,
    newSsim,
    delta,
    moved,
    flip,
    verdict,
    problems,
    notes
  }
}

/** One line per case, plus a summary. Absent values print ABSENT, never 0. */
export function formatReport(rows) {
  const f = v =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : ABSENT
  const d = v =>
    typeof v === 'number' && Number.isFinite(v)
      ? (v >= 0 ? '+' : '') + v.toExponential(2)
      : ABSENT
  const w = Math.max(4, ...rows.map(r => r.name.length))
  const lines = [
    `${'case'.padEnd(w)}  ${'old'.padStart(8)}  ${'new'.padStart(8)}  ${'delta'.padStart(10)}  verdict`
  ]
  for (const r of rows) {
    let line = `${r.name.padEnd(w)}  ${f(r.oldSsim).padStart(8)}  ${f(r.newSsim).padStart(8)}  ${d(r.delta).padStart(10)}  ${r.verdict}`
    if (r.problems?.length) line += ` [${r.problems.join('; ')}]`
    if (r.notes?.length) line += ` (${r.notes.join('; ')})`
    lines.push(line)
  }
  const tally = {}
  for (const r of rows) {
    const k = r.verdict.startsWith('FLIP') ? 'FLIP' : r.verdict
    tally[k] = (tally[k] ?? 0) + 1
  }
  lines.push('')
  lines.push(
    'summary: ' +
      Object.entries(tally)
        .sort()
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')
  )
  return lines.join('\n')
}

/**
 * Exit code.
 *
 * INCOMPLETE and DROPPED fail: the tree does not carry what it must, so nothing
 * read from it is trustworthy. An instrument problem, not a result.
 *
 * FLIP does NOT fail. A re-capture is expected to move numbers, and a flip is a
 * result for a human to adjudicate, not a malfunction.
 */
export function exitCodeFor(rows) {
  return rows.some(r => r.verdict === 'INCOMPLETE' || r.verdict === 'DROPPED')
    ? 1
    : 0
}

/**
 * Scores a whole tree against a baseline.
 *
 * The union of both trees' cases is scored, so a case only in the baseline
 * reports DROPPED rather than vanishing: a shrinking tree must not look clean.
 *
 * @param {string} oldRoot
 * @param {string} newRoot
 */
export function scoreTree(oldRoot, newRoot) {
  const names = [
    ...new Set([...listCases(oldRoot), ...listCases(newRoot)])
  ].sort()
  return names.map(name => {
    const beforeDir = join(oldRoot, name)
    const afterDir = join(newRoot, name)
    const before = existsSync(beforeDir) ? readCase(beforeDir) : null
    const after = existsSync(afterDir) ? readCase(afterDir) : null
    // Expectation comes from the BASELINE, which is the only statement of what
    // this case is supposed to produce. Taking it from the new tree would let a
    // harness that stopped emitting series define its own success
    const baselineLog = existsSync(join(beforeDir, 'capture.log'))
      ? readFileSync(join(beforeDir, 'capture.log'), 'utf8')
      : ''
    return scoreCase(name, before, after, {
      expectsSeries: hasSequence(baselineLog)
    })
  })
}
