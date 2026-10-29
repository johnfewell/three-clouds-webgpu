// A case whose metrics match its pose's neutral baseline tests nothing
// The third way the ladder has passed an untested feature, and one
// no static check sees. Five cases DECLARE the base value and match correctly,
// so a case is suspect only when it declares a REAL delta and still matches

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BASE_STATE, cases, effectiveState, type CaseDefinition } from './index'

const ROOT = resolve(__dirname, '../../..')

interface Metrics {
  ssim: number
  deMean: number
  deP95: number
  histDist: number
}

const SSIM_UNITS = 1_000_000

// Measured independent captures of static baseline-equivalent cases:
// seven cases x N=10 spanned 0.985196..0.985208 on the pinned main, i.e. 12 units
// at six decimals. Pinned with no added margin
const STATIC_SSIM_REPEAT_TOLERANCE_UNITS = 12

function ssimDeltaUnits(a: number, b: number): number {
  return Math.abs(Math.round(a * SSIM_UNITS) - Math.round(b * SSIM_UNITS))
}

function metricsFor(name: string): Metrics | null {
  for (const phase of [0, 1, 2, 3, 4]) {
    const f = resolve(ROOT, `parity/results/${phase}/${name}/metrics.json`)
    if (existsSync(f)) {
      return JSON.parse(readFileSync(f, 'utf8')) as Metrics
    }
  }
  return null
}

// Fields outside `state` that also make a case non-neutral
function hasNonStateDelta(c: CaseDefinition): boolean {
  return (
    c.camera != null ||
    c.backend != null ||
    c.lighting != null ||
    c.sequence != null ||
    c.lookOnly === true ||
    (c.ecefRotationY ?? 0) !== 0 ||
    c.scene !== 'synthetic'
  )
}

// Which CaseState keys this case actually moves off the baseline
function realDeltas(c: CaseDefinition): string[] {
  const eff = effectiveState(c) as unknown as Record<string, unknown>
  const base = BASE_STATE as unknown as Record<string, unknown>
  return Object.keys(base).filter(k => eff[k] !== base[k])
}

const isNeutral = (c: CaseDefinition): boolean =>
  realDeltas(c).length === 0 && !hasNonStateDelta(c)

// Cases known to measure nothing, each citing its evidence. One selected
// capture cannot retire one (gm7h: a 17-unit selected delta while the
// distributions overlapped), so the last test requires distribution overlap
/**
 * Cases whose DEFINITION changed after the last capture, so the metrics on disk
 * describe a case that no longer exists.
 *
 * A staleness marker, not an exemption: the tests pair COMMITTED metrics with a
 * twin from the CURRENT definition, so a re-posed case would compare two
 * experiments. MUST BE EMPTIED by the next capture of these cases. Acceptance
 * is the forced-off probe, not the name leaving this list.
 */
const RESCOPED_AWAITING_CAPTURE: Record<string, string> = {
  // EMPTY except between a re-scope and its capture: haze-on and
  // ground-bounce-on now differ from their twins. The guard measures IDENTITY,
  // not ATTRIBUTION: 43 differs via `shadow: true`, not bounce
}

const KNOWN_VACUOUS: Record<string, string> = {
  // Design-neutral BY MECHANISM, so permanent: log depth is a round trip and
  // scoring the baseline is CORRECT. Its depth-precision evidence is the CPU
  // twin (red-proven); the both-sides hardware assertion is still owed
  'log-depth':
    'overlapping static repeat distributions; the hardware depth-precision ' +
    'proof is still owed'
}

type SsimRange = readonly [min: number, max: number]

// Confirmation cohort on the pinned main, key bbf8ea4699a8f8b6. Stored in integer
// units so the overlap claim is tested at the precision the capture emits
const KNOWN_VACUOUS_SSIM_EVIDENCE: Record<
  string,
  { baseline: SsimRange; candidate: SsimRange }
> = {
  'log-depth': {
    baseline: [985196, 985203],
    candidate: [985199, 985208]
  }
}

/**
 * Whether two metric tuples are indistinguishable: the vacuity test.
 *
 * Replaced SSIM's theoretical aggregate-ULP allowance with the measured
 * static-class repeat tolerance above. The other three tolerances are
 * unchanged, since that arm did not measure their floors.
 *
 * `matches` requires ALL four within tolerance. SSIM uses integer micro-units
 * (metrics.json has six decimals), so the 12-unit boundary cannot flip.
 */
function matches(a: Metrics, b: Metrics): boolean {
  return (
    ssimDeltaUnits(a.ssim, b.ssim) <= STATIC_SSIM_REPEAT_TOLERANCE_UNITS &&
    Math.abs(a.deMean - b.deMean) <= 5e-3 &&
    Math.abs(a.deP95 - b.deP95) <= 5e-3 &&
    Math.abs(a.histDist - b.histDist) <= 1e-5
  )
}

/**
 * Cases the vacuity sweep currently cannot pair, each with the task that will
 * close it. These are OPEN HOLES, not exemptions: every entry is a case that
 * reports no vacuity evidence at all. The list is expected to shrink, and the
 * anti-rot test below deletes an entry the moment its case gains a twin.
 *
 * Adding a name here is a deliberate, reviewable act. Silently failing to pair
 * was the bug this file exists for.
 */
/**
 * Cases the sweep cannot pair BECAUSE THEIR EVIDENCE IS STRONGER THAN A TWIN:
 * the named tests VARY THE KNOB UNDER TEST on the same scene.
 *
 * An entry must name a spec and a test title, and the guard below reads that
 * file and fails if the test is missing or does not mention the case.
 *
 * It proves the evidence EXISTS, not that it PASSES. A `lastGreen` field would
 * be unverified prose again. The keyed e2e receipt is what can close that.
 */
const UNPAIRED_BY_STRONGER_EVIDENCE: Record<
  string,
  { spec: string; test: string; why: string }
> = {
  'ground-bounce-on': {
    spec: 'examples/parity/e2e/p4.spec.ts',
    test: '2. ground bounce brightens the undersides, and responds to the knob',
    why:
      'sweeps groundBounceScale 0/1/8/100 on the case itself, measures its own ' +
      'run-to-run floor by repeating a condition, and asserts monotonic ' +
      'increments above 5x it — it varies the knob rather than comparing two ' +
      'experiments, and it is self-calibrating. A neutral twin at ' +
      'POSE_SURFACE_UP + SUN_DEFAULT would be strictly weaker.'
  }
}

const UNPAIRED_AWAITING_TWIN: Record<string, string> = {}

describe('captured cases measure something', () => {
  it('pins the SSIM boundary to the measured static-class spread', () => {
    const baseline: Metrics = {
      ssim: 0.985196,
      deMean: 0,
      deP95: 0,
      histDist: 0
    }

    expect(matches(baseline, { ...baseline, ssim: 0.985208 })).toBe(true)
    expect(matches(baseline, { ...baseline, ssim: 0.985209 })).toBe(false)
  })

  it('no case with a real delta scores identically to its neutral baseline', () => {
    const neutrals = cases.filter(isNeutral)
    const suspect: string[] = []

    for (const c of cases) {
      // a control, where identical IS the right answer
      if (isNeutral(c)) continue
      if (KNOWN_VACUOUS[c.name] != null) continue
      if (RESCOPED_AWAITING_CAPTURE[c.name] != null) continue
      // A sequence case's evidence is its flicker/ghosting block, not its still
      // frame: `wind` at time 0 SHOULD measure the baseline, so comparing its
      // still metrics would flag it forever for being correct
      if (c.sequence != null && realDeltas(c).length === 0) continue
      const twin = neutrals.find(
        n =>
          n.pose === c.pose &&
          n.sun.elevation === c.sun.elevation &&
          n.sun.azimuth === c.sun.azimuth
      )
      if (twin == null) continue
      const a = metricsFor(c.name)
      const b = metricsFor(twin.name)
      if (a == null || b == null) continue
      if (matches(a, b)) {
        suspect.push(
          `${c.number} ${c.name} (== ${twin.name}; declares ${realDeltas(c).join(', ')})`
        )
      }
    }

    expect(
      suspect,
      `these cases declare a real delta yet measure EXACTLY their neutral ` +
        `baseline — they pass while testing nothing:\n  ${suspect.join('\n  ')}`
    ).toEqual([])
  })

  it('every re-scoped entry cites evidence and a real case', () => {
    for (const [name, reason] of Object.entries(RESCOPED_AWAITING_CAPTURE)) {
      expect(reason, `${name} must cite what distinguishes it`).not.toBe('')
      expect(
        cases.find(c => c.name === name),
        `${name} is not a case`
      ).toBeDefined()
    }
  })

  it('each re-scoped case has a neutral twin, so the guard can resume', () => {
    // Found while re-posing: the first test SKIPS cases it cannot pair on pose
    // AND sun, so moving a case to an unpaired pose/sun swaps a vacuous case
    // for an unchecked one, which is worse
    const neutrals = cases.filter(isNeutral)
    for (const name of Object.keys(RESCOPED_AWAITING_CAPTURE)) {
      const c = cases.find(x => x.name === name)
      expect(c, `${name} is not a case`).toBeDefined()
      const twin = neutrals.find(
        n =>
          n.pose === c!.pose &&
          n.sun.elevation === c!.sun.elevation &&
          n.sun.azimuth === c!.sun.azimuth
      )
      expect(
        twin,
        `${name} has no neutral control at its pose+sun, so the vacuity guard ` +
          `would skip it forever rather than check it`
      ).toBeDefined()
    }
  })

  it('no case with a real delta is silently unpaired', () => {
    // `if (twin == null) continue` is a SILENT skip, the absent-evidence shape
    // the sweep exists to catch (a grazing case would land in it). So
    // an unpairable case must be DECLARED unpairable, with a task
    const neutrals = cases.filter(isNeutral)
    const unpaired: string[] = []

    for (const c of cases) {
      if (isNeutral(c)) continue
      if (KNOWN_VACUOUS[c.name] != null) continue
      if (RESCOPED_AWAITING_CAPTURE[c.name] != null) continue
      if (UNPAIRED_AWAITING_TWIN[c.name] != null) continue
      if (UNPAIRED_BY_STRONGER_EVIDENCE[c.name] != null) continue
      if (c.sequence != null && realDeltas(c).length === 0) continue
      const twin = neutrals.find(
        n =>
          n.pose === c.pose &&
          n.sun.elevation === c.sun.elevation &&
          n.sun.azimuth === c.sun.azimuth
      )
      if (twin == null) {
        unpaired.push(
          `${c.number} ${c.name} (declares ${realDeltas(c).join(', ') || 'non-state delta'})`
        )
      }
    }

    expect(
      unpaired,
      `these cases have no neutral control at their pose+sun, so the vacuity ` +
        `sweep skips them SILENTLY. Give each a neutral twin, or — if the case ` +
        `already has BETTER evidence than a twin — an ` +
        `UNPAIRED_BY_STRONGER_EVIDENCE entry naming the spec and test that ` +
        `varies its knob. UNPAIRED_AWAITING_TWIN is for holes that will close:` +
        `\n  ${unpaired.join('\n  ')}`
    ).toEqual([])
  })

  it('every awaiting-twin entry names a task, a real case, and STILL lacks a twin', () => {
    // Anti-rot in the direction that matters: the list must shrink. The moment
    // someone adds a neutral control at an entry's pose+sun, that entry becomes
    // a lie that would suppress a real check, so it fails here until deleted
    const neutrals = cases.filter(isNeutral)
    for (const [name, reason] of Object.entries(UNPAIRED_AWAITING_TWIN)) {
      expect(reason, `${name} must cite what distinguishes it`).not.toBe('')
      const c = cases.find(x => x.name === name)
      expect(c, `${name} is not a case`).toBeDefined()
      const twin = neutrals.find(
        n =>
          n.pose === c!.pose &&
          n.sun.elevation === c!.sun.elevation &&
          n.sun.azimuth === c!.sun.azimuth
      )
      expect(
        twin,
        `${name} now HAS a neutral twin at its pose+sun — delete its ` +
          `UNPAIRED_AWAITING_TWIN entry so the sweep checks it again (${reason})`
      ).toBeUndefined()
    }
  })

  it('every stronger-evidence entry names a spec, a real case, and a test that EXISTS', () => {
    // The check that makes this dict honest: an exemption justified by prose
    // nobody verifies is an absent-evidence shape, so the named spec is read
    // and must contain the test title. Rename or delete it and this fails.
    for (const [name, e] of Object.entries(UNPAIRED_BY_STRONGER_EVIDENCE)) {
      expect(
        e.spec,
        `${name} must name the spec that holds the evidence`
      ).not.toBe('')
      expect(e.why, `${name} needs a stated reason`).not.toBe('')
      expect(
        cases.find(c => c.name === name),
        `${name} is not a case`
      ).toBeDefined()

      const specPath = resolve(ROOT, e.spec)
      expect(existsSync(specPath), `${name}: ${e.spec} does not exist`).toBe(
        true
      )
      const src = readFileSync(specPath, 'utf8')
      const at = src.indexOf(e.test)
      expect(
        at,
        `${name} is exempt from the vacuity sweep because "${e.test}" in ` +
          `${e.spec} is stronger evidence — and that test is NOT THERE. ` +
          `Either restore it, or delete this entry and pair the case.`
      ).toBeGreaterThan(-1)

      // The title existing is not enough: it must be the test that exercises
      // THIS case. Without this an entry could cite a real, passing test of
      // something else entirely and read as justified
      const rest = src.slice(at)
      const nextTest = rest.indexOf('\n  test(', 1)
      const body = nextTest === -1 ? rest : rest.slice(0, nextTest)
      expect(
        body.includes(`'${name}'`),
        `${name}'s exemption cites "${e.test}" in ${e.spec}, but that test ` +
          `never mentions the case. An exemption must name a test that ` +
          `exercises the case it exempts.`
      ).toBe(true)
    }
  })

  it('every unpaired entry names a case that is NOT neutral', () => {
    // isNeutral() is tested before either map, so an entry for a neutral case
    // is dead code that reads as a justified exemption: the vacuous shape
    // twice over. Applies to both maps.
    const names = [
      ...Object.keys(UNPAIRED_AWAITING_TWIN),
      ...Object.keys(UNPAIRED_BY_STRONGER_EVIDENCE)
    ]
    for (const name of names) {
      const c = cases.find(x => x.name === name)
      expect(c, `${name} is not a case`).toBeDefined()
      expect(
        realDeltas(c!).length > 0 || hasNonStateDelta(c!),
        `${name} is neutral, so the sweep already skips it as a control and ` +
          `this entry exempts nothing — delete it`
      ).toBe(true)
    }
  })

  it('a case is never in BOTH unpaired maps', () => {
    // They mean opposite things: one is a hole that must close, the other is a
    // permanent exemption. A name in both would make the first unfalsifiable.
    const both = Object.keys(UNPAIRED_AWAITING_TWIN).filter(
      n => UNPAIRED_BY_STRONGER_EVIDENCE[n] != null
    )
    expect(both, 'these say a case is both awaiting a twin and exempt').toEqual(
      []
    )
  })

  it('every known-vacuous entry has overlapping repeat evidence', () => {
    // A one-shot capture is not evidence that two repeat distributions
    // separated. Retiring an entry requires a fresh repeated measurement, not
    // whichever selected pair happens to cross the general point tolerance
    for (const [name, reason] of Object.entries(KNOWN_VACUOUS)) {
      expect(reason, `${name} must cite its repeat evidence`).not.toBe('')
      const c = cases.find(x => x.name === name)
      expect(c, `${name} is not a case`).toBeDefined()

      const evidence = KNOWN_VACUOUS_SSIM_EVIDENCE[name]
      expect(
        evidence,
        `${name} has no repeated-distribution evidence`
      ).toBeDefined()
      const overlapMin = Math.max(evidence!.baseline[0], evidence!.candidate[0])
      const overlapMax = Math.min(evidence!.baseline[1], evidence!.candidate[1])
      expect(
        overlapMin,
        `${name}'s measured repeat distributions do not overlap — re-evaluate ` +
          `its KNOWN_VACUOUS entry (${reason})`
      ).toBeLessThanOrEqual(overlapMax)
    }
  })

  it('the controls that legitimately match are NOT flagged', () => {
    // Pins the distinction the whole test rests on: these five declare the base
    // value, so identical is correct. `wind` matches too, its evidence being
    // the sequence block
    for (const name of [
      'preset-medium',
      'res-100',
      'turbulence-off',
      'octaves-8',
      'accurate-sunsky-off'
    ]) {
      const c = cases.find(x => x.name === name)
      expect(c, `${name} is not a case`).toBeDefined()
      expect(
        realDeltas(c!),
        `${name} is expected to declare the BASE value`
      ).toEqual([])
    }
  })
})
