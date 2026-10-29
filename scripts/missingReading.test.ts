// a missing reading is not a pass. `null > ceiling` is false, so a
// null deP95 or histDist sails through (NaN serialises as null). Latent, not
// live, but a silent pass survives review. Driven against the real script,
// since a helper-level test passes over dead wiring

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..')

function fixture(metricOverrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'k9fo-'))
  // Phase 3 gates ssim, deP95 and histDist, so a missing value has a threshold
  // to have been checked against
  const caseDir = join(dir, '3', 'fixture-case')
  mkdirSync(caseDir, { recursive: true })
  writeFileSync(
    join(caseDir, 'metrics.json'),
    JSON.stringify({
      case: 'fixture-case',
      phase: 3,
      metricsVersion: 4,
      ssim: 0.99,
      deP95: 1,
      histDist: 0.01,
      plate: { A: { std: 0.02 }, B: { std: 0.02, cloudFraction: 0.2 } },
      ...metricOverrides
    })
  )
  return dir
}

function verify(resultsDir: string): { out: string; status: number } {
  try {
    const out = execFileSync('node', ['scripts/verify-results.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, PARITY_RESULTS_DIR: resultsDir }
    })
    return { out, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { out: String(e.stdout ?? ''), status: e.status ?? 1 }
  }
}

describe('a missing reading is not a pass', () => {
  it('the control fixture passes, so a failure below means something', () => {
    const { out, status } = verify(fixture({}))
    expect(out).toContain('→ pass')
    expect(status).toBe(0)
  })

  it('FAILS on a null deP95 — the direction that would silently pass', () => {
    const { out, status } = verify(fixture({ deP95: null }))
    expect(out).toContain('deP95 has no reading')
    expect(status).toBe(1)
  })

  it('FAILS on a null histDist', () => {
    const { out, status } = verify(fixture({ histDist: null }))
    expect(out).toContain('histDist has no reading')
    expect(status).toBe(1)
  })

  it('FAILS on an absent key, not just an explicit null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k9fo-'))
    const caseDir = join(dir, '3', 'fixture-case')
    mkdirSync(caseDir, { recursive: true })
    // deP95 omitted entirely: JSON.stringify drops an undefined field, so this
    // is what an upstream slip actually looks like on disk
    writeFileSync(
      join(caseDir, 'metrics.json'),
      JSON.stringify({
        case: 'fixture-case',
        phase: 3,
        metricsVersion: 4,
        ssim: 0.99,
        histDist: 0.01,
        plate: { A: { std: 0.02 }, B: { std: 0.02, cloudFraction: 0.2 } }
      })
    )
    const { out, status } = verify(dir)
    expect(out).toContain('deP95 has no reading')
    expect(status).toBe(1)
  })

  it('does NOT fire for a metric the phase leaves ungated', () => {
    // Phase 4 gates ssim only (deP95/histDist are null). A missing
    // deP95 there has no threshold to have been checked against, and is
    // reported as UNGATED rather than counted as a missing reading
    const dir = mkdtempSync(join(tmpdir(), 'k9fo-'))
    const caseDir = join(dir, '4', 'fixture-case')
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(
      join(caseDir, 'metrics.json'),
      JSON.stringify({
        case: 'fixture-case',
        phase: 4,
        metricsVersion: 4,
        ssim: 0.99,
        deP95: null,
        histDist: null,
        plate: { A: { std: 0.02 }, B: { std: 0.02, cloudFraction: 0.2 } }
      })
    )
    const { out } = verify(dir)
    expect(out).not.toContain('has no reading')
    expect(out).toContain('UNGATED on deP95, histDist')
  })
})

// (env-tie): metrics.json and metrics.json.env are unlinked files,
// and Amendment 7's repeat floor is a hardware-state floor. All results are
// `apple metal-3 | hardware` today, and nothing else checks that it stays so
describe('hardware provenance is tied to the evidence (env-tie)', () => {
  // `unknown` already admits null. The null case means "write no .env at all"
  function withEnv(env: unknown, dirName = 'case-a'): string {
    const dir = mkdtempSync(join(tmpdir(), 'k9fo-env-'))
    const caseDir = join(dir, '3', dirName)
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(
      join(caseDir, 'metrics.json'),
      JSON.stringify({
        case: dirName,
        phase: 3,
        metricsVersion: 4,
        ssim: 0.99,
        deP95: 1,
        histDist: 0.01,
        plate: { A: { std: 0.02 }, B: { std: 0.02, cloudFraction: 0.2 } }
      })
    )
    if (env !== null) {
      writeFileSync(join(caseDir, 'metrics.json.env'), JSON.stringify(env))
    }
    return dir
  }

  it('flags a result with no .env — provenance unknown', () => {
    const { out } = verify(withEnv(null))
    expect(out).toContain('has no metrics.json.env')
  })

  it('flags an unparseable .env rather than treating it as absent-but-fine', () => {
    const dir = withEnv({ adapter: 'x', gpu: 'hardware' })
    writeFileSync(join(dir, '3', 'case-a', 'metrics.json.env'), '{not json')
    const { out } = verify(dir)
    expect(out).toContain('unparseable')
  })

  it('stays SILENT when every result shares one hardware state', () => {
    const { out } = verify(
      withEnv({ adapter: 'apple metal-3', gpu: 'hardware' })
    )
    expect(out).not.toContain('hardware states')
    expect(out).not.toContain('provenance unknown')
  })

  it('reports a MIXED hardware set — Amendment 7 assumes one', () => {
    const dir = withEnv({ adapter: 'apple metal-3', gpu: 'hardware' }, 'case-a')
    const other = join(dir, '3', 'case-b')
    mkdirSync(other, { recursive: true })
    writeFileSync(
      join(other, 'metrics.json'),
      JSON.stringify({
        case: 'case-b',
        phase: 3,
        metricsVersion: 4,
        ssim: 0.99,
        deP95: 1,
        histDist: 0.01,
        plate: { A: { std: 0.02 }, B: { std: 0.02, cloudFraction: 0.2 } }
      })
    )
    writeFileSync(
      join(other, 'metrics.json.env'),
      JSON.stringify({ adapter: 'nvidia ampere', gpu: 'hardware' })
    )
    const { out } = verify(dir)
    expect(out).toContain('spans 2 hardware states')
  })
})
