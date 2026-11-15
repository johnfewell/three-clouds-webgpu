// a phase threshold is a number or null, never a placeholder string,
// which silently gated nothing in all three evaluators on phase 4. The unit
// tests pass even if nothing CALLS the validator, so the
// second describe drives verify-results itself

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import thresholds from './thresholds.json'
import { unsetMetrics, validateThresholds } from './thresholdSchema.mjs'

describe('threshold schema', () => {
  it('rejects the placeholder string that caused this task', () => {
    expect(() =>
      validateThresholds({
        phases: { 4: { ssim: 0.98, deP95: '<set after first run>' } }
      })
    ).toThrow(/neither a number nor null/)
  })

  it('names the phase and metric, so the message locates the defect', () => {
    expect(() =>
      validateThresholds({ phases: { 2: { histDist: 'later' } } })
    ).toThrow(/phase 2 histDist/)
  })

  it('accepts numbers and explicit null', () => {
    expect(() =>
      validateThresholds({
        phases: { 4: { ssim: 0.98, deP95: null, histDist: null } }
      })
    ).not.toThrow()
  })

  it('rejects NaN and Infinity — both compare false and gate nothing', () => {
    expect(() => validateThresholds({ phases: { 1: { ssim: NaN } } })).toThrow()
    expect(() =>
      validateThresholds({ phases: { 1: { ssim: Infinity } } })
    ).toThrow()
  })

  it('checks only phases — sibling prose like plate.reason is by design', () => {
    expect(() =>
      validateThresholds({
        phases: { 0: { ssim: 0.95 } },
        plate: { minStd: 0.002, reason: 'a black plate is not a pass' }
      })
    ).not.toThrow()
  })

  // The regression guard: nobody reintroduces a placeholder into the real file
  it('the COMMITTED thresholds.json satisfies its own contract', () => {
    expect(() => validateThresholds(thresholds)).not.toThrow()
  })

  it('reports no phase as unset now that phase 4 carries its gates', () => {
    // Phase 4 was the last one with null deP95 and histDist. The
    // operator approved the gates on 2026-11-11 (vymb.7)
    expect(unsetMetrics(thresholds.phases['4'])).toEqual([])
    expect(unsetMetrics(thresholds.phases['3'])).toEqual([])
  })
})

describe('verify-results STATES an ungated phase', () => {
  // The line fires when a phase LEAVES a gate unset. Every committed phase now
  // sets both, so the only way to exercise it is a thresholds file with a hole
  function writeFixture(dir: string): void {
    const caseDir = join(dir, '4', 'fixture-case')
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(
      join(caseDir, 'metrics.json'),
      JSON.stringify({
        case: 'fixture-case',
        phase: 4,
        metricsVersion: 4,
        ssim: 0.99,
        deP95: 999,
        histDist: 999,
        plate: { A: { std: 0.02 }, B: { std: 0.02, cloudFraction: 0.2 } }
      })
    )
  }

  function runWithPhases(phases: Record<string, unknown>, dir: string): string {
    writeFixture(dir)
    const thresholdsPath = join(dir, 'thresholds.json')
    writeFileSync(thresholdsPath, JSON.stringify({ phases }))
    const env = {
      ...process.env,
      PARITY_RESULTS_DIR: dir,
      PARITY_THRESHOLDS_PATH: thresholdsPath
    }
    try {
      return execFileSync('node', ['scripts/verify-results.mjs'], {
        cwd: join(import.meta.dirname, '..', '..', '..'),
        encoding: 'utf-8',
        env
      })
    } catch (err) {
      return String((err as { stdout?: string }).stdout ?? '')
    }
  }

  it('prints UNGATED for a phase whose thresholds are null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j1wx-'))
    const out = runWithPhases(
      { 4: { ssim: 0.98, deP95: null, histDist: null } },
      dir
    )
    expect(out).toContain('UNGATED on deP95, histDist')
    // And the point of saying so: deP95 999 does NOT fail, because there is no
    // threshold to fail against. Silent before this change.
    expect(out).not.toContain('deP95 999.00 >')
  })

  it('says nothing about gating once the phase sets both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j1wx-set-'))
    const out = runWithPhases(
      { 4: { ssim: 0.98, deP95: 5, histDist: 0.1 } },
      dir
    )
    expect(out).not.toContain('UNGATED')
    expect(out).toContain('deP95 999.00 > 5.00')
  })
})
