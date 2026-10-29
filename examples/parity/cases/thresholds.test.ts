import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from '../../../test/helpers/cpuTwin'
import { evaluate, type Metrics, type Thresholds } from '../src/metrics'

const raw = readFileSync(resolve(__dirname, 'thresholds.json'), 'utf-8')
const thresholds: Thresholds & {
  procedure: string
  bias: Record<string, unknown>
} = JSON.parse(raw)

describe('thresholds.json schema', () => {
  it('has phases 0–4 with required keys', () => {
    const rows: Array<{ phase: string; hasSSIM: boolean }> = []
    for (const p of [0, 1, 2, 3, 4]) {
      const phase = thresholds.phases[p]!
      expect(phase, `phase ${p} exists`).toBeDefined()
      expect(phase.ssim, `phase ${p} has ssim`).toBeDefined()
      rows.push({ phase: String(p), hasSSIM: phase.ssim != null })
    }
    table('thresholds-phases', rows)
  })

  it('phase 0 has only ssim (stub march, no detailed metrics)', () => {
    const p0 = thresholds.phases[0]!
    expect(p0.ssim).toBeTypeOf('number')
  })

  it('phase 4 has the highest ssim threshold', () => {
    const p1 = thresholds.phases[1]!.ssim!
    const p4 = thresholds.phases[4]!.ssim!
    expect(p4).toBeGreaterThan(p1)
  })

  // The register may be EMPTY, its healthiest state (it is since 2026-09-01,
  // when the last entry turned out to be absorbing a defect). What it
  // may never contain is a global wildcard
  it('accepted array exists and never uses global *', () => {
    expect(thresholds.accepted).toBeDefined()
    for (const entry of thresholds.accepted!) {
      expect(entry.pattern).toBeTruthy()
      expect(entry.reason).toBeTruthy()
      // A global wildcard turns every fail into expected-difference and
      // hides black-vs-white plates. Forbidden.
      expect(entry.pattern).not.toBe('*')
      expect(entry.pattern === '**' || entry.pattern === '.*').toBe(false)
    }
  })

  it('bias block exists with warmup and pending fields', () => {
    expect(thresholds.bias).toBeDefined()
    expect(thresholds.bias.warmup).toBe(64)
  })

  it('procedure string is present', () => {
    expect(thresholds.procedure).toBeTruthy()
    expect(thresholds.procedure).toContain('mean minus 2')
  })
})

describe('evaluate() fixtures', () => {
  it('pass: metrics within thresholds', () => {
    const metrics: Metrics = {
      ssim: 0.98,
      deMean: 0.5,
      deP95: 1.0,
      histDist: 0.01
    }
    const result = evaluate(metrics, { ssim: 0.95, deP95: 5, histDist: 0.1 })

    const rows = [
      { field: 'result', expected: 'pass', actual: result.result },
      { field: 'reasons', expected: 0, actual: result.reasons.length }
    ]
    table('evaluate-pass', rows)

    expect(result.result).toBe('pass')
    expect(result.reasons).toHaveLength(0)
  })

  it('fail: ssim below threshold', () => {
    const metrics: Metrics = {
      ssim: 0.8,
      deMean: 0.5,
      deP95: 1.0,
      histDist: 0.01
    }
    const result = evaluate(metrics, { ssim: 0.95 })

    const rows = [
      { field: 'result', expected: 'fail', actual: result.result },
      { field: 'reasons', expected: 1, actual: result.reasons.length }
    ]
    table('evaluate-fail-ssim', rows)

    expect(result.result).toBe('fail')
    expect(result.reasons[0]).toContain('ssim')
  })

  it('fail: deP95 above threshold', () => {
    const metrics: Metrics = {
      ssim: 0.98,
      deMean: 0.5,
      deP95: 10.0,
      histDist: 0.01
    }
    const result = evaluate(metrics, { ssim: 0.95, deP95: 5 })
    expect(result.result).toBe('fail')
    expect(result.reasons[0]).toContain('deP95')
  })

  it('expected-difference: fails but matches accepted pattern', () => {
    const metrics: Metrics = {
      ssim: 0.8,
      deMean: 0.5,
      deP95: 1.0,
      histDist: 0.01
    }
    // A synthetic entry: the live register is empty, and these tests pin the
    // evaluator's behaviour, not the register's contents
    const result = evaluate(metrics, { ssim: 0.95 }, 'shafts-low-sun', [
      { pattern: 'shafts-*', reason: 'synthetic: documented non-parity' }
    ])

    const rows = [
      {
        field: 'result',
        expected: 'expected-difference',
        actual: result.result
      },
      {
        field: 'has accepted reason',
        expected: true,
        actual: result.reasons.some(r => r.includes('accepted:'))
      }
    ]
    table('evaluate-expected-diff', rows)

    expect(result.result).toBe('expected-difference')
  })

  it('dissimilar plates fail: no accepted entry matches arbitrary cases', () => {
    const metrics: Metrics = {
      ssim: 0.01,
      deMean: 40,
      deP95: 50,
      histDist: 1.5
    }
    for (const name of [
      'baseline-medium',
      'orbit-140km',
      'inside-deck',
      'some-random-case'
    ]) {
      const result = evaluate(metrics, { ssim: 0.9 }, name, thresholds.accepted)
      expect(result.result, name).toBe('fail')
      expect(result.reasons[0]).toContain('ssim')
    }
  })

  it('glob pattern: shafts-* matches shafts-low-sun', () => {
    const metrics: Metrics = {
      ssim: 0.8,
      deMean: 0.5,
      deP95: 1.0,
      histDist: 0.01
    }
    const shaftsOnly = [
      { pattern: 'shafts-*', reason: 'synthetic: documented non-parity' }
    ]
    const result = evaluate(
      metrics,
      { ssim: 0.95 },
      'shafts-low-sun',
      shaftsOnly
    )
    expect(result.result).toBe('expected-difference')
  })

  it('glob pattern: shafts-* does not match shadow-plane', () => {
    const metrics: Metrics = {
      ssim: 0.8,
      deMean: 0.5,
      deP95: 1.0,
      histDist: 0.01
    }
    const shaftsOnly = [
      { pattern: 'shafts-*', reason: 'synthetic: documented non-parity' }
    ]
    const result = evaluate(metrics, { ssim: 0.95 }, 'shadow-plane', shaftsOnly)
    expect(result.result).toBe('fail')
  })

  it('no thresholds set means pass', () => {
    const metrics: Metrics = { ssim: 0.5, deMean: 10, deP95: 20, histDist: 1 }
    const result = evaluate(metrics, {})
    expect(result.result).toBe('pass')
  })
})
