// Every shadow case must CARRY a shaded-fraction receipt, not merely pass one:
// an ABSENT block passes the gate by design, so pre-q78i captures passed with
// no evidence. The absence is tracked as capture owed, and a NEW shadow case
// always carries one, since the runner writes the block

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { cases, effectiveState } from './index'

const RESULTS = resolve(__dirname, '..', '..', '..', 'parity', 'results')

/** Case names whose effective state casts a shadow */
function shadowCaseNames(): Set<string> {
  return new Set(cases.filter(c => effectiveState(c).shadow).map(c => c.name))
}

interface Captured {
  name: string
  hasReceipt: boolean
  skipped: string | null
}

function capturedShadowCases(): Captured[] {
  if (!existsSync(RESULTS)) return []
  const shadow = shadowCaseNames()
  const out: Captured[] = []
  for (const phase of readdirSync(RESULTS)) {
    const phaseDir = join(RESULTS, phase)
    let entries: string[]
    try {
      entries = readdirSync(phaseDir)
    } catch {
      continue
    }
    for (const name of entries) {
      const mp = join(phaseDir, name, 'metrics.json')
      if (!existsSync(mp)) continue
      const m = JSON.parse(readFileSync(mp, 'utf8')) as {
        case: string
        shadedFraction?: unknown
      }
      if (!shadow.has(m.case)) continue
      const sf = m.shadedFraction as { skipped?: unknown } | null | undefined
      out.push({
        name: m.case,
        hasReceipt: sf != null,
        skipped: typeof sf?.skipped === 'string' ? sf.skipped : null
      })
    }
  }
  return out
}

/**
 * Shadow cases captured before the receipt, which therefore carry none and
 * are NOT being checked by it. Delete an entry when its case is re-captured.
 * The list is expected to reach empty, not a permanent exemption.
 */
const RECEIPT_OWED = new Set<string>([
  // EMPTY: all thirteen shadow cases now carry a receipt (ten from e33ea0b,
  // three captured here). The list named a debt and the debt was paid
])

describe('shaded-fraction receipt coverage', () => {
  it('every captured shadow case has a receipt, or is listed as owed', () => {
    const missing = capturedShadowCases()
      .filter(c => !c.hasReceipt && !RECEIPT_OWED.has(c.name))
      .map(c => c.name)
    expect(
      [...new Set(missing)],
      'these shadow cases have committed metrics with no shadedFraction block, ' +
        'so the q78i gate passes them by having no evidence to check: ' +
        missing.join(', ')
    ).toEqual([])
  })

  it('the owed list only names cases that are still missing one', () => {
    // Anti-rot: once a case is re-captured its entry must go, or the list stops
    // describing anything and the next reader trusts a stale exemption
    const withReceipt = new Set(
      capturedShadowCases()
        .filter(c => c.hasReceipt)
        .map(c => c.name)
    )
    const stale = [...RECEIPT_OWED].filter(n => withReceipt.has(n))
    expect(
      stale,
      `these now carry a receipt — delete them from RECEIPT_OWED: ${stale.join(', ')}`
    ).toEqual([])
  })

  it('every owed entry is a real shadow case', () => {
    const shadow = shadowCaseNames()
    const bogus = [...RECEIPT_OWED].filter(n => !shadow.has(n))
    expect(
      bogus,
      `not shadow cases, so they cannot owe a receipt: ${bogus.join(', ')}`
    ).toEqual([])
  })
})

// Ruled on: a case may declare the receipt inapplicable, with
// the reason, which travels with the evidence. Declared is covered, silent is
// not, and a declaration on a non-shadow case is a lie
describe('shaded-fraction receipt — declared skips', () => {
  it('every registry skip is on a shadow case and names its reason', () => {
    const shadow = shadowCaseNames()
    for (const c of cases) {
      const declared = c.shadedFractionReceipt
      if (declared == null) continue
      expect(
        shadow.has(c.name),
        `${c.name} declares a skip but casts no shadow`
      ).toBe(true)
      // `compare` alone is not a skip, so the reason is required of
      // the skips and nothing else
      if (declared.skip == null) continue
      expect(declared.skip.length).toBeGreaterThan(20)
    }
  })

  it('a captured skip carries the reason from the registry', () => {
    const declared = new Map(
      cases
        .filter(c => c.shadedFractionReceipt != null)
        .map(c => [c.name, c.shadedFractionReceipt?.skip ?? ''])
    )
    for (const c of capturedShadowCases()) {
      if (c.skipped == null) continue
      expect(
        declared.get(c.name),
        `${c.name} was captured as skipped but the registry does not declare it`
      ).toBe(c.skipped)
    }
  })
})
