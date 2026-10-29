#!/usr/bin/env node
// Verify committed parity results against thresholds.json
// Walks parity/results/<phase>/**/metrics.json and evaluates each against
// thresholds. Images are local capture output, not committed evidence, so
// they are not checked
// Exit 0 on all-pass (or empty tree), exit 1 on any fail
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import {
  EXIT_BROKEN_GATE,
  EXIT_FAILURES,
  unsetMetrics,
  validateThresholds
} from '../examples/parity/cases/thresholdSchema.mjs'
import {
  checkMetricsVersion,
  evaluate as evaluateMetrics
} from '../examples/parity/src/metrics/evaluator.mjs'

// the commit that made the shaded-fraction off-arm start
// cold. A receipt whose file predates it measured a warm off-arm.
const OFF_ARM_CORRECTION = 'f4f5111'

const ROOT = join(import.meta.dirname, '..')
// Committed evidence lives in parity/results (repo root). PARITY_RESULTS_DIR
// overrides it for tests
const RESULTS_DIR =
  process.env.PARITY_RESULTS_DIR ?? join(ROOT, 'parity', 'results')
// overridable so a test can point at a fixture instead of MUTATING
// the committed file. An in-place edit raced another test and reddened main,
// even though it restored the file afterwards
const THRESHOLDS_PATH =
  process.env.PARITY_THRESHOLDS_PATH ??
  join(ROOT, 'examples', 'parity', 'cases', 'thresholds.json')

// the exit-code contract lives beside the threshold validator, so
// capture.mjs and this CLI share one definition. Re-exported here because
// callers and tests already look for it in this module
export { EXIT_BROKEN_GATE, EXIT_FAILURES }

function loadThresholds() {
  const raw = readFileSync(THRESHOLDS_PATH, 'utf-8')
  // check the file's contract at the load site. A non-numeric
  // threshold passes every `!= null` guard downstream and then silently
  // becomes no-gate, so it must never reach the comparisons
  try {
    const thresholds = validateThresholds(JSON.parse(raw))
    // an accepted[] floor is part of the same
    // contract, so malformed means broken gate, on the same path as above
    validateAcceptedFloors(thresholds.accepted)
    return thresholds
  } catch (error) {
    // House style (capture.mjs's "REFUSING to run"): say what is wrong and what
    // it costs, on one line, rather than an unhandled stack trace
    console.error(
      `[verify] REFUSING to run: ${THRESHOLDS_PATH} is not a valid ` +
        `threshold file, so every gate below it is meaningless.\n` +
        `[verify] ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

export const SHADED_RATIO_FLOOR = 0.85
export const MIN_SIGNAL_FRACTION = 0.01

// Mirrors evaluateShadedFraction in
// examples/parity/src/metrics/shadedFraction.ts. Keep the two rule sets
// identical (this script cannot import the TS module)
/**
 * Was this metrics.json captured BEFORE the off-arm
 * correction (f4f5111)?
 *
 * Before d5cm the casters-OFF arm continued from the casters-ON warm state, so
 * the receipt's `rise` carried that difference too (confirmed: side A moved
 * +5.1 on case 39 when the reset landed).
 *
 * GIT ANCESTRY is the test, not the convergence field: it separates every
 * receipt retroactively (59 pre / 2 post of 61), where field presence would
 * misclassify older receipts. The field is a stationarity record, not a mark.
 */
export function isPreCorrection(lastCommitSha, isAncestorOfFix) {
  // Unknown provenance is treated as PRE: an unverifiable receipt must not
  // pass as current evidence, which is the whole point of the flag
  if (lastCommitSha == null || lastCommitSha === '') return true
  return isAncestorOfFix !== true
}

/**
 * does this case's verdict actually LEAN on the shaded-fraction
 * receipt? Only then does the receipt's provenance matter.
 *
 * A declared skip carries its reason and is not evidence, and a receipt that
 * could not be taken already fails on its own. Everything else is load-bearing.
 */
export function shadedFractionIsLoadBearing(sf) {
  if (sf == null) return false
  if (typeof sf.skipped === 'string' && sf.skipped.length > 0) return false
  if (sf.error) return false
  return true
}

/**
 * The commit that last touched `filePath`, or null when git cannot say.
 * Null flows into isPreCorrection, which treats unknown provenance as PRE.
 */
function lastCommitTouching(filePath) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%H', '--', filePath],
      { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Is `sha` a descendant of the off-arm correction? null when undecidable. */
function isDescendantOfCorrection(sha) {
  if (sha == null) return null
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', OFF_ARM_CORRECTION, sha],
      { cwd: ROOT, stdio: 'ignore' }
    )
    return true
  } catch (err) {
    // Exit 1 is a clean "not an ancestor"; anything else (missing object,
    // detached history, no git) is undecidable and must not read as post
    return err?.status === 1 ? false : null
  }
}

export function checkShadedFraction(sf) {
  if (sf == null) return []
  // A DECLARED skip (registry shadedFractionReceipt.skip) is covered; the
  // reason travels with the evidence. Silence (null) is not a skip.
  if (typeof sf.skipped === 'string' && sf.skipped.length > 0) return []
  if (sf.error) {
    return [`shaded-fraction receipt could not be taken: ${sf.error}`]
  }
  // Absent means 'ratio', which is how every receipt captured before
  // the policy existed was graded, so old evidence keeps its own rule
  const bOnly = sf.compare === 'b-only'
  const allOff = f =>
    Array.isArray(f) && f.length > 0 && f.every(v => v === false)
  const reasons = []
  for (const side of ['A', 'B']) {
    if (!allOff(sf.flagsOff?.[side])) {
      reasons.push(
        `shaded-fraction receipt: side ${side} flags did not read back all-off`
      )
    }
    // Side A brightens only if it has a consumer to brighten from. Under
    // b-only it has none, and requiring it would fail a correct port
    if (side === 'B' || !bOnly) {
      if (!(sf[side]?.rise > 0)) {
        reasons.push(
          `shaded-fraction receipt: side ${side} plate did not brighten with casters off`
        )
      }
    }
  }
  if (reasons.length > 0) return reasons
  const subject = bOnly ? 'B' : 'A'
  if (!(sf[subject]?.fraction >= MIN_SIGNAL_FRACTION)) {
    return [
      `shaded-fraction receipt: no shadow in frame — side ${subject} shades ${(sf[subject].fraction * 100).toFixed(2)} % of the plate (< ${(MIN_SIGNAL_FRACTION * 100).toFixed(0)} %); the pose does not see its shadow (declare shadedFractionReceipt.skip if that is by design)`
    ]
  }
  // A b-only receipt's ratio divides two different quantities
  if (bOnly) return reasons
  if (!(sf.ratio >= SHADED_RATIO_FLOOR)) {
    reasons.push(
      `shadedFraction ratio ${sf.ratio.toFixed(3)} < ${SHADED_RATIO_FLOOR.toFixed(2)} ` +
        `(A ${(sf.A.fraction * 100).toFixed(2)} %, B ${(sf.B.fraction * 100).toFixed(2)} %)`
    )
  }
  return reasons
}

/**
 * the packed debug plate's per-channel agreement.
 *
 * Mirrors buildAtlasChannelReceipt's reasons in
 * examples/parity/src/metrics/atlasChannels.ts. Only the channels the capture
 * recorded as `gated` are scored, so a plate whose ungated channel moved (the
 * frontDepth storage divergence) cannot fail this and cannot hide behind it.
 */
export function checkAtlasChannels(ac) {
  if (ac == null) return []
  if (ac.error) return [`atlas-channel receipt could not be taken: ${ac.error}`]
  const reasons = []
  if (!Array.isArray(ac.gated) || ac.gated.length === 0) {
    return [
      'atlas-channel receipt REFUSED: the capture gated no channel, so ' +
        'nothing about the atlas was measured'
    ]
  }
  if (typeof ac.tolerance !== 'number' || !(ac.tolerance > 0)) {
    return [
      `atlas-channel receipt REFUSED: tolerance ${JSON.stringify(ac.tolerance)} is not a positive fraction of the channel mean`
    ]
  }
  for (const c of ac.gated) {
    if (!(ac.ratio?.[c] > 0)) {
      reasons.push(
        `atlas-channel receipt REFUSED: gated channel ${c} has no signal on side A (ratio ${JSON.stringify(ac.ratio?.[c])})`
      )
    }
  }
  if (reasons.length > 0) return reasons
  for (const c of ac.gated) {
    const deviation = Math.abs(ac.ratio[c] - 1)
    if (!(deviation <= ac.tolerance)) {
      reasons.push(
        `atlas channel ${c}: B/A ${ac.ratio[c].toFixed(4)} (deviation ${(deviation * 100).toFixed(2)} % > ${(ac.tolerance * 100).toFixed(2)} %) — the channels that decide optical depth disagree`
      )
    }
  }
  return reasons
}

export function validateAcceptedFloors(accepted) {
  if (!Array.isArray(accepted)) return
  for (const entry of accepted) {
    if (entry == null || entry.floor == null) continue
    const value = entry.floor.ssim
    if (
      typeof entry.floor !== 'object' ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new Error(
        `thresholds.json: accepted[] entry '${String(entry.pattern)}' has a malformed floor ${JSON.stringify(entry.floor)} — floor.ssim must be a finite number in [0, 1]`
      )
    }
  }
}

/**
 * the e2e receipt, read at VERIFY time.
 *
 * Measured before this existed: corrupting `provenance.e2e` on all 63
 * committed captures moved nothing, so verify-time had no gate on it at all.
 * Capture-time is where the receipt is TAKEN, and it refuses on red;
 * nothing re-read the stamp it left. The measurement is in ADR-011 Amendment 11.
 *
 * The stamp, not a recomputation: `e2eInputsKey` hashes the working tree, which
 * has moved since, so verifying afresh would read every historical capture as
 * stale. What verify-time CAN read is what the capture recorded about itself.
 *
 * RED is a hard fail, matching the receipt policy rather than inventing a
 * stricter one: a capture stamped red measured a tree whose suite was failing.
 * Every other state is an annotation, because a stale key is the normal state
 * of historical evidence and refusing it would redden the ladder on any commit.
 *
 * @param {{ e2e?: unknown } | null | undefined} provenance
 * @returns {string[]} hard-fail reasons, empty when the stamp is sound
 */
export function checkE2eReceipt(provenance) {
  const e2e = provenance?.e2e
  if (e2e == null || typeof e2e !== 'object') {
    // Unknown provenance must not read as sound, but a block absent entirely
    // PREDATES the receipt, so it is reported, never refused
    return []
  }
  const { verdict, detail } = e2e
  if (verdict === 'red') {
    return [
      `e2e receipt was RED at capture time: ${String(detail ?? 'no detail')} — ` +
        `this capture measured a tree whose own suite was failing. ` +
        `Re-capture on a tree with a passing suite`
    ]
  }
  return []
}

/**
 * The states a reader must SEE but that are not hard fails: a non-green
 * verdict, the per-run override, and the two build skips that were warned about
 * at runtime but stamped nowhere.
 *
 * Reported because the receipt is the only record that a capture's tree passed
 * its own suite, and a capture that cannot show it has to say so in the log a
 * reviewer actually reads.
 *
 * Each entry is a REASON plus a DETAIL, never a pre-joined string. A stale
 * detail embeds that capture's own inputs key, so joining first would key the
 * caller's grouping on a per-capture value and print one line per capture
 * instead of one per reason. The reason repeats, the detail does not.
 *
 * @param {{ e2e?: unknown, skips?: unknown } | null | undefined} provenance
 * @returns {Array<{ reason: string, detail?: string }>} one per absent proof
 */
export function e2eReceiptAnnotations(provenance) {
  if (provenance == null || typeof provenance !== 'object') {
    return [
      {
        reason: 'no provenance at all — this capture predates the e2e receipt'
      }
    ]
  }
  const notes = []
  const e2e = provenance.e2e
  if (e2e == null || typeof e2e !== 'object') {
    notes.push({ reason: 'no e2e receipt block (predates the receipt gate)' })
  } else if (e2e.verdict !== 'green') {
    notes.push({
      reason: `e2e receipt ${String(e2e.verdict)}`,
      detail: String(e2e.detail ?? 'no detail')
    })
  }
  if (e2e?.overrideArmed === true) {
    notes.push({
      reason:
        'captured with PARITY_SKIP_E2E_RECEIPT=1, so no suite gate ran at all'
    })
  }
  const skips = provenance.skips
  if (skips != null && typeof skips === 'object') {
    if (skips.build === true) {
      notes.push({
        reason: 'PARITY_SKIP_BUILD=1 — build/ was served unchecked'
      })
    }
    if (skips.typecheck === true) {
      notes.push({
        reason: 'PARITY_SKIP_TYPECHECK=1 — built without the typecheck'
      })
    }
  }
  return notes
}

/**
 * the SERVED bytes, read at VERIFY time.
 *
 * Measured before this existed: injecting `build.servedIsBuilt: false` and an
 * unresolvable `servedTree` into all 63 committed captures moved nothing
 * (59 pass, 4 expected-difference, 0 fail, exit 0).
 * `refuseUnlessServedIsBuilt`,
 * `refuseUnlessServedIsAncestor` and `refuseUnlessServedIsSelf` all gate at
 * CAPTURE time only, so a copied or hand-edited metrics.json carrying the
 * stamp of a capture that measured the wrong bytes verified as a pass.
 *
 * Found by review of the receipt-at-verify-time gate.
 *
 * HARD FAIL, never downgradeable by accepted[], on that reasoning: a
 * capture whose served build is not the build it recorded did not measure this
 * project, so it is not a difference to be accepted but a measurement to be
 * discarded. `servedTree` with no resolvable root or head is the SAME class,
 * because `refuseUnlessServedIsAncestor` refuses on exactly that at capture
 * time. Absence there is a refusal, not an absent-and-therefore-fine.
 *
 * An ABSENT block is an annotation, never a fail: it predates the stamp, and
 * refusing it would redden historical evidence for the sin of being old.
 *
 * @param {{ build?: unknown, servedTree?: unknown } | null | undefined} provenance
 * @returns {string[]} hard-fail reasons, empty when the stamps are sound
 */
export function checkServedProvenance(provenance) {
  const reasons = []
  const build = provenance?.build
  if (build == null || typeof build !== 'object') {
    // No build block at all: predates the stamp, reported not refused
    return reasons
  }
  const { servedIsBuilt, served, error } = build
  if (servedIsBuilt !== true) {
    // Anything but an explicit true refuses. `false` is the measured case, and
    // a missing or non-boolean value is the same unknown
    const servedRoot = served?.root ?? 'nothing'
    const servedDigest =
      typeof served?.digest === 'string'
        ? served.digest.slice(0, 12)
        : 'unresolved'
    const builtRoot = build.built?.root ?? 'nothing'
    const builtDigest =
      typeof build.built?.digest === 'string'
        ? build.built.digest.slice(0, 12)
        : 'unresolved'
    reasons.push(
      `the dev server did not serve the build this capture recorded: ` +
        `servedIsBuilt=${String(servedIsBuilt)}, the server resolved to ` +
        `${servedRoot} (build ${servedDigest}), not the build produced at ` +
        `${builtRoot} (${builtDigest})` +
        `${error == null ? '' : ` (${String(error)})`}. The capture measured bytes ` +
        `that are not this project's (the capture-time gate is ` +
        `captureProvenance.mjs refuseUnlessServedIsBuilt). Re-capture on an ` +
        `isolated tree`
    )
  }
  const servedTree = provenance?.servedTree
  if (servedTree != null && typeof servedTree === 'object') {
    if (servedTree.root == null) {
      reasons.push(
        `the served package tree could not be resolved at capture time` +
          `${servedTree.error == null ? '' : ` (${String(servedTree.error)})`}. ` +
          `The measured bytes cannot be placed in any lineage (the ` +
          `capture-time gate is refuseUnlessServedIsAncestor). Re-capture in an ` +
          `isolated tree`
      )
    } else if (servedTree.head == null) {
      reasons.push(
        `the served tree at ${String(servedTree.root)} has no readable git HEAD` +
          `${servedTree.error == null ? '' : ` (${String(servedTree.error)})`}. ` +
          `The measured bytes cannot be placed in any lineage (the ` +
          `capture-time gate is refuseUnlessServedIsAncestor). Re-capture in an ` +
          `isolated tree`
      )
    }
  }
  return reasons
}

/**
 * The served-byte facts a reader must SEE that are not hard fails: a capture
 * whose build or servedTree block predates the stamp, or is missing outright
 *
 * Distinct from the hard fails above on purpose. A block that is ABSENT cannot
 * say the bytes were wrong, so it cannot fail. A block that is PRESENT and says
 * they were wrong can, and does.
 *
 * servedTree is an UNCONDITIONAL key of the provenance object at capture time
 * (captureProvenance.mjs:259), so an artifact without one was edited
 * afterwards. Still only an annotation: it is a weaker signal than a block
 * present and unsound, and the lineage proof cannot be reconstructed.
 *
 * CONSTANT strings only. A per-capture detail here would fragment the caller's
 * grouping into one line per capture, which is what the grouping exists to
 * avoid. The sibling e2eReceiptAnnotations returns {reason, detail} for exactly
 * that reason (ADR-011 Amendment 11)
 */
export function servedProvenanceAnnotations(provenance) {
  if (provenance == null || typeof provenance !== 'object') {
    return []
  }
  const notes = []
  if (provenance.build == null || typeof provenance.build !== 'object') {
    notes.push('no build provenance block (predates the served-tree gate)')
  }
  if (provenance.servedTree == null) {
    notes.push('no servedTree block (the served tree was never recorded)')
  }
  return notes
}

export function evaluateCommittedMetrics(
  metrics,
  phaseThresholds,
  caseName,
  accepted,
  plateCheck
) {
  // Stale evidence is a hard fail, never downgradeable by accepted[]: a v1
  // histDist cannot be compared to a v2 threshold at all
  const versionReasons = checkMetricsVersion(metrics.metricsVersion)
  if (versionReasons.length > 0) {
    return { result: 'fail', reasons: versionReasons }
  }
  // a red e2e receipt is the same class
  // of hard fail (the capture measured a tree already known to be unsound), and
  // accepted[] must not downgrade it either
  const e2eReasons = checkE2eReceipt(metrics.provenance)
  if (e2eReasons.length > 0) {
    return { result: 'fail', reasons: e2eReasons }
  }
  // the served bytes, the same class and the same ordering. A capture
  // that measured bytes other than the build it recorded is not evidence, and
  // accepted[] must not downgrade it either
  const servedReasons = checkServedProvenance(metrics.provenance)
  if (servedReasons.length > 0) {
    return { result: 'fail', reasons: servedReasons }
  }
  // shaded-fraction is a hard gate (ratio, or b-only on side B)
  // that accepted[] cannot downgrade. A missing block predates the receipt
  const receiptReasons = checkShadedFraction(metrics.shadedFraction)
  if (receiptReasons.length > 0) {
    return { result: 'fail', reasons: receiptReasons }
  }
  // the same standing for the packed plate's gated channels
  // A case without the block does not declare the gate
  const atlasReasons = checkAtlasChannels(metrics.atlasChannels)
  if (atlasReasons.length > 0) {
    return { result: 'fail', reasons: atlasReasons }
  }
  return evaluateMetrics(
    metrics,
    phaseThresholds,
    caseName,
    accepted,
    plateCheck
  )
}

function findMetricsFiles(dir) {
  const results = []
  if (!existsSync(dir)) return results

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...findMetricsFiles(full))
    } else if (entry === 'metrics.json') {
      results.push(full)
    }
  }
  return results
}

function run() {
  if (!existsSync(RESULTS_DIR)) {
    console.log('[verify] no results')
    return 0
  }

  const phases = readdirSync(RESULTS_DIR).filter(d =>
    statSync(join(RESULTS_DIR, d)).isDirectory()
  )

  if (phases.length === 0) {
    console.log('[verify] no results')
    return 0
  }

  const thresholds = loadThresholds()
  // refuse rather than gate on a file we could not validate
  if (thresholds == null) return EXIT_BROKEN_GATE
  let failCount = 0
  let passCount = 0
  let expectedCount = 0
  let preCorrectionCount = 0
  // captures whose e2e stamp is not a
  // clean green, plus the per-run override and the two build skips
  const e2eNotes = new Map()
  // captures with no build provenance block at all
  const servedNotes = new Map()
  // (env-tie): metrics.json and its .env are unlinked files, and
  // Amendment 7's floor was measured on ONE machine. Nothing else checks that
  // the evidence shares a hardware state, so it is collected here
  const adapters = new Map()
  let missingEnvCount = 0

  for (const phaseDir of phases) {
    const phase = parseInt(phaseDir, 10)
    if (isNaN(phase)) continue

    const phaseThresholds = thresholds.phases[phase]
    if (!phaseThresholds) {
      console.log(`[verify] phase ${phase}: no thresholds defined, skipping`)
      continue
    }

    // an unset threshold is legitimate (a phase can be captured
    // before its floors are known), but it looks like "threshold met" in a
    // results table, so it is stated rather than left to be inferred
    const unset = unsetMetrics(phaseThresholds)
    if (unset.length > 0) {
      console.log(
        `[verify] phase ${phase}: UNGATED on ${unset.join(', ')} — ` +
          `no threshold set, so those metrics cannot fail here`
      )
    }

    const metricsFiles = findMetricsFiles(join(RESULTS_DIR, phaseDir))

    for (const metricsPath of metricsFiles) {
      const caseDir = join(metricsPath, '..')
      const caseName = relative(join(RESULTS_DIR, phaseDir), caseDir)

      // PNGs are not committed: the verdict is
      // metrics.json alone, so a case directory without images still grades

      // Load and evaluate metrics
      let metrics
      try {
        metrics = JSON.parse(readFileSync(metricsPath, 'utf-8'))
      } catch (err) {
        console.log(`[verify] ${phase}/${caseName} invalid metrics.json → fail`)
        failCount++
        continue
      }

      const result = evaluateCommittedMetrics(
        metrics,
        phaseThresholds,
        caseName,
        thresholds.accepted,
        {
          minStd: thresholds.plate?.minStd ?? 0.002,
          minCloudFraction: thresholds.plate?.minCloudFraction ?? 0.0005,
          plate: metrics.plate
        }
      )

      const reasonStr =
        result.reasons.length > 0 ? ` (${result.reasons.join('; ')})` : ''
      const metricsStr = `ssim=${metrics.ssim?.toFixed(4) ?? '?'} deP95=${metrics.deP95?.toFixed(2) ?? '?'}`
      console.log(
        `[verify] ${phase}/${caseName} ${metricsStr} → ${result.result}${reasonStr}`
      )

      // (env-tie): record which hardware produced this artifact. A
      // metrics.json with no sibling .env has unknown provenance, the same
      // standard isPreCorrection applies to the off-arm correction
      const envPath = `${metricsPath}.env`
      if (!existsSync(envPath)) {
        missingEnvCount++
        console.log(
          `[verify] ${phase}/${caseName} has no metrics.json.env — hardware provenance unknown`
        )
      } else {
        try {
          const env = JSON.parse(readFileSync(envPath, 'utf-8'))
          const key = `${env.adapter ?? 'unknown'} | ${env.gpu ?? 'unknown'}`
          adapters.set(key, (adapters.get(key) ?? 0) + 1)
        } catch {
          missingEnvCount++
          console.log(
            `[verify] ${phase}/${caseName} metrics.json.env is unparseable — hardware provenance unknown`
          )
        }
      }

      // (ADR-011 Amendment 9): a pre-correction receipt's
      // `rise` is contaminated. An annotation, not a failure (no mass
      // re-capture), flagged only where the verdict leans on the receipt
      if (shadedFractionIsLoadBearing(metrics.shadedFraction)) {
        const sha = lastCommitTouching(metricsPath)
        if (isPreCorrection(sha, isDescendantOfCorrection(sha))) {
          preCorrectionCount++
          console.log(
            `[verify] ${phase}/${caseName} shadedFraction receipt is PRE-CORRECTION ` +
              `(file predates ${OFF_ARM_CORRECTION}${sha == null ? ', provenance unknown' : ''}) ` +
              `— not current evidence for an acceptance that leans on it`
          )
        }
      }

      // the stamp the capture left about
      // its own e2e suite. Reported for every case, because a reviewer reading
      // this log is the only place a non-green stamp becomes visible
      for (const note of e2eReceiptAnnotations(metrics.provenance)) {
        // Keyed on the REASON, since the detail is that capture's own inputs
        // key and joining first would fragment one line per capture (ADR-011 A11)
        const seen = e2eNotes.get(note.reason)
        if (seen == null)
          e2eNotes.set(note.reason, { count: 1, detail: note.detail })
        else seen.count++
      }

      // an absent build block is reported here. A block that is
      // PRESENT and unsound already failed above, so this group only ever
      // holds the "predates the stamp" case
      for (const note of servedProvenanceAnnotations(metrics.provenance)) {
        servedNotes.set(note, (servedNotes.get(note) ?? 0) + 1)
      }

      if (result.result === 'fail') failCount++
      else if (result.result === 'expected-difference') expectedCount++
      else passCount++
    }
  }

  const total = passCount + expectedCount + failCount
  if (total === 0) {
    console.log('[verify] no results')
    return 0
  }

  // (env-tie): Amendment 7's floor is per hardware state, so cases
  // from different adapters compare different floors. Reported, not failed:
  // a mixed set may be deliberate, but it must never be invisible
  if (adapters.size > 1) {
    console.log(
      `[verify] committed evidence spans ${adapters.size} hardware states — ` +
        `cross-case comparisons and Amendment 7's floor assume ONE:`
    )
    for (const [key, count] of adapters) {
      console.log(`[verify]   ${count}x  ${key}`)
    }
  }
  if (missingEnvCount > 0) {
    console.log(
      `[verify] ${missingEnvCount} result(s) have no usable metrics.json.env — ` +
        `hardware provenance unknown`
    )
  }

  if (preCorrectionCount > 0) {
    console.log(
      `[verify] ${preCorrectionCount} load-bearing shadedFraction receipt(s) are PRE-CORRECTION ` +
        `— re-capture those before an acceptance leans on them (ADR-011 Amendment 9)`
    )
  }

  // grouped, because the common case is
  // one reason across many captures and the per-case lines would drown it
  if (e2eNotes.size > 0) {
    console.log(
      `[verify] e2e receipts on committed captures — only a RED one fails ` +
        `above; the rest are what each capture could not prove:`
    )
    for (const [reason, { count, detail }] of e2eNotes) {
      console.log(
        `[verify]   ${count}x  ${reason}` +
          (detail == null ? '' : ` — ${detail}`)
      )
    }
  }

  if (servedNotes.size > 0) {
    console.log(
      `[verify] served-byte provenance on committed captures. A build block that ` +
        `says the server did not serve it has FAILED above, so this group is ` +
        `only the captures that predate the stamp:`
    )
    for (const [note, count] of servedNotes) {
      console.log(`[verify]   ${count}x  ${note}`)
    }
  }

  console.log(
    `[verify] summary: ${passCount} pass, ${expectedCount} expected-difference, ${failCount} fail`
  )
  return failCount > 0 ? EXIT_FAILURES : 0
}

// run ONLY when invoked as a script. At module scope the CLI ran and
// exited on import, so the pure helpers could not be unit tested and the test
// had to shell out
if (
  process.argv[1] != null &&
  import.meta.url.endsWith(basename(process.argv[1]))
) {
  process.exit(run())
}
