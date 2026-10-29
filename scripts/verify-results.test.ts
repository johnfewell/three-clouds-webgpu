import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { METRICS_VERSION } from '../examples/parity/src/metrics/evaluator.mjs'
import { table } from '../test/helpers/cpuTwin'

interface ExecError {
  stdout?: string
  stderr?: string
  status?: number
}

function isExecError(e: unknown): ExecError {
  return typeof e === 'object' && e !== null ? e : {}
}

const ROOT = join(import.meta.dirname, '..')
// Never touch the committed evidence in parity/results: verify a temp tree
const RESULTS_DIR = join(tmpdir(), `verify-results-${process.pid}`)
const SCRIPT = join(ROOT, 'scripts', 'verify-results.mjs')
const TEST_PHASE = '0'
const PHASE_DIR = join(RESULTS_DIR, TEST_PHASE)

function runVerify(): { code: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, PARITY_RESULTS_DIR: RESULTS_DIR }
    })
    return { code: 0, output }
  } catch (err: unknown) {
    const e = isExecError(err)
    return {
      code: e.status ?? 1,
      output: (e.stdout ?? '') + (e.stderr ?? '')
    }
  }
}

function cleanFixture(): void {
  if (existsSync(PHASE_DIR)) {
    rmSync(PHASE_DIR, { recursive: true, force: true })
  }
}

const GOOD_PLATE = {
  A: { mean: 0.12, std: 0.05 },
  B: { mean: 0.11, std: 0.05, cloudFraction: 0.05 }
}

function setupCase(
  caseName: string,
  metrics: Record<string, unknown> | null
): string {
  const caseDir = join(PHASE_DIR, caseName)
  mkdirSync(caseDir, { recursive: true })

  if (metrics != null) {
    writeFileSync(join(caseDir, 'metrics.json'), JSON.stringify(metrics))
  }

  return caseDir
}

describe('verify-results.mjs', () => {
  afterAll(() => {
    cleanFixture()
  })

  it('empty tree: exit 0 with "no results"', () => {
    cleanFixture()

    const { code, output } = runVerify()
    const rows = [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'output',
        expected: 'no results or summary',
        actual: output.trim().split('\n').pop() ?? ''
      }
    ]
    table('verify-empty', rows)

    expect(code).toBe(0)
  })

  it('pass: metrics within thresholds', () => {
    cleanFixture()

    setupCase('good-case', {
      ssim: 0.99,
      deMean: 0.1,
      deP95: 0.5,
      histDist: 0.001,
      metricsVersion: METRICS_VERSION,
      plate: GOOD_PLATE
    })

    const { code, output } = runVerify()
    const rows = [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'has pass line',
        expected: true,
        actual: output.includes('pass')
      }
    ]
    table('verify-pass', rows)

    expect(code).toBe(0)
    cleanFixture()
  })

  // images are not committed evidence. This
  // replaces the old "missing PNG: exit 1" and "LFS pointer: exit 1" tests
  it('a case with no images grades on metrics alone', () => {
    cleanFixture()

    setupCase('no-images-case', {
      ssim: 0.99,
      deMean: 0.1,
      deP95: 0.5,
      histDist: 0.001,
      metricsVersion: METRICS_VERSION,
      plate: GOOD_PLATE
    })

    const { code, output } = runVerify()
    const rows = [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'mentions MISSING',
        expected: false,
        actual: output.includes('MISSING')
      }
    ]
    table('verify-no-images', rows)

    expect(code).toBe(0)
    expect(output).not.toContain('MISSING')
    cleanFixture()
  })

  it('flat side B plate: exit 1 even with perfect metrics', () => {
    cleanFixture()
    setupCase('flat-b-case', {
      ssim: 0.99,
      deMean: 0.1,
      deP95: 0.5,
      histDist: 0.001,
      metricsVersion: METRICS_VERSION,
      plate: {
        A: { mean: 0.12, std: 0.05 },
        B: { mean: 0.1, std: 0.001, cloudFraction: 0.05 }
      }
    })
    const { code, output } = runVerify()
    table('verify-flat-plate', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'mentions plate',
        expected: true,
        actual: output.includes('black/flat plate')
      }
    ])
    expect(code).toBe(1)
    expect(output).toContain('black/flat plate')
    cleanFixture()
  })

  it('side B marched no clouds: exit 1 even with a textured plate', () => {
    cleanFixture()
    setupCase('no-clouds-case', {
      ssim: 0.99,
      deMean: 0.1,
      deP95: 0.5,
      histDist: 0.001,
      metricsVersion: METRICS_VERSION,
      plate: {
        A: { mean: 0.12, std: 0.05 },
        B: { mean: 0.11, std: 0.05, cloudFraction: 0 }
      }
    })
    const { code, output } = runVerify()
    table('verify-no-clouds', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'mentions no clouds',
        expected: true,
        actual: output.includes('marched no clouds')
      }
    ])
    expect(code).toBe(1)
    expect(output).toContain('marched no clouds')
    cleanFixture()
  })

  it('metrics without plate stats: exit 1 (re-capture)', () => {
    cleanFixture()
    setupCase('no-plate-case', {
      ssim: 0.99,
      deMean: 0.1,
      deP95: 0.5,
      histDist: 0.001
    })
    const { code, output } = runVerify()
    table('verify-no-plate', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'mentions re-capture',
        expected: true,
        actual: output.includes('re-capture')
      }
    ])
    expect(code).toBe(1)
    expect(output).toContain('re-capture')
    cleanFixture()
  })

  // ADR-011 amendment: histDist was
  // redefined, so an old metrics.json cannot be compared to today's threshold
  // Stale evidence fails, never re-graded or downgraded by accepted[]
  it('stale metricsVersion: exit 1 even with otherwise passing metrics', () => {
    cleanFixture()
    setupCase('stale-case', {
      ssim: 0.99,
      deMean: 0.1,
      deP95: 0.5,
      histDist: 0.001,
      plate: GOOD_PLATE
    })
    const { code, output } = runVerify()
    table('verify-stale-metrics', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'mentions stale metrics',
        expected: true,
        actual: output.includes('stale metrics')
      },
      {
        field: 'names the version gap',
        expected: true,
        actual: output.includes(`metricsVersion 1 ≠ ${METRICS_VERSION}`)
      }
    ])
    expect(code).toBe(1)
    expect(output).toContain('stale metrics')
    expect(output).toContain('re-capture')
    cleanFixture()
  })

  it('an accepted[] pattern cannot rescue stale evidence', () => {
    cleanFixture()
    // 'shafts-*' is a real accepted entry. It must not downgrade a stale file
    setupCase('shafts-stale', {
      ssim: 0.2,
      deMean: 20,
      deP95: 30,
      histDist: 1.9,
      plate: GOOD_PLATE
    })
    const { code, output } = runVerify()
    const caseLine =
      output.split('\n').find(l => l.includes('shafts-stale')) ?? ''
    table('verify-stale-not-accepted', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'case verdict',
        expected: '→ fail',
        actual: caseLine.slice(-120)
      },
      {
        field: 'downgraded by accepted[]',
        expected: false,
        actual: caseLine.includes('expected-difference')
      },
      {
        field: 'summary expected-difference count',
        expected: '0 expected-difference',
        actual: output.includes('0 expected-difference')
      }
    ])
    expect(code).toBe(1)
    expect(caseLine).toContain('stale metrics')
    // 'shafts-*' is a live accepted[] entry; it must not rescue this case
    expect(caseLine).not.toContain('expected-difference')
    expect(caseLine).not.toContain('accepted:')
    expect(output).toContain('0 expected-difference')
    cleanFixture()
  })
})

// when the block is present, the shaded-fraction receipt is a hard
// gate (its three refusals and the ratio floor). Absent means "not checked",
// never "failed", until the phase-3 re-capture lands it everywhere
describe('verify-results.mjs — shaded-fraction receipt', () => {
  afterAll(() => {
    cleanFixture()
  })

  const GOOD_SIDE = {
    fraction: 0.21,
    meanOn: 0.08,
    meanOff: 0.093,
    rise: 0.13,
    classified: 1000
  }
  const BASE = {
    ssim: 0.99,
    deMean: 0.1,
    deP95: 0.5,
    histDist: 0.001,
    metricsVersion: METRICS_VERSION,
    plate: GOOD_PLATE
  }
  const GOOD_RECEIPT = {
    A: GOOD_SIDE,
    B: { ...GOOD_SIDE, fraction: 0.2 },
    ratio: 0.2 / 0.21,
    flagsOff: { A: [false, false], B: [false] },
    flagsRestored: { A: [true, true], B: [true] },
    reasons: []
  }

  it('a verified receipt at or above the floor passes', () => {
    cleanFixture()
    setupCase('shadow-ok', { ...BASE, shadedFraction: GOOD_RECEIPT })
    const { code, output } = runVerify()
    expect(code).toBe(0)
    expect(output).toMatch(/shadow-ok .*pass/)
  })

  it('a ratio below the floor fails, naming both fractions', () => {
    cleanFixture()
    setupCase('shadow-lost', {
      ...BASE,
      shadedFraction: {
        ...GOOD_RECEIPT,
        B: { ...GOOD_SIDE, fraction: 0.021 },
        ratio: 0.1
      }
    })
    const { code, output } = runVerify()
    expect(code).not.toBe(0)
    expect(output).toMatch(
      /shadedFraction ratio 0\.100 < 0\.85 \(A 21\.00 %, B 2\.10 %\)/
    )
  })

  it('flags that did not read back all-off refuse the receipt before any ratio', () => {
    cleanFixture()
    setupCase('shadow-noop', {
      ...BASE,
      shadedFraction: {
        ...GOOD_RECEIPT,
        flagsOff: { A: [false, false], B: [true] },
        ratio: 0.1
      }
    })
    const { code, output } = runVerify()
    expect(code).not.toBe(0)
    expect(output).toMatch(/side B flags did not read back all-off/)
    expect(output).not.toMatch(/shadedFraction ratio/)
  })

  it('a plate that did not brighten with the casters off refuses the receipt', () => {
    cleanFixture()
    setupCase('shadow-inert', {
      ...BASE,
      shadedFraction: { ...GOOD_RECEIPT, A: { ...GOOD_SIDE, rise: 0 } }
    })
    const { code, output } = runVerify()
    expect(code).not.toBe(0)
    expect(output).toMatch(/side A plate did not brighten/)
  })

  it('a receipt that could not be taken is a fail, not a skip', () => {
    cleanFixture()
    setupCase('shadow-error', {
      ...BASE,
      shadedFraction: { error: 'probe has no setShadow' }
    })
    const { code, output } = runVerify()
    expect(code).not.toBe(0)
    expect(output).toMatch(/receipt could not be taken: probe has no setShadow/)
  })

  it('a metrics.json without the block is not checked (predates the receipt)', () => {
    cleanFixture()
    setupCase('no-receipt', { ...BASE, shadedFraction: null })
    const { code } = runVerify()
    expect(code).toBe(0)
  })
})

// mail #673, two gaps: a declared skip is covered, and a near-zero pair is
// not a pass
describe('verify-results.mjs — receipt skips and minimum signal', () => {
  afterAll(() => {
    cleanFixture()
  })
  const BASE = {
    ssim: 0.99,
    deMean: 0.1,
    deP95: 0.5,
    histDist: 0.001,
    metricsVersion: METRICS_VERSION,
    plate: GOOD_PLATE
  }

  it('a declared skip with a reason passes', () => {
    cleanFixture()
    setupCase('shadow-declared', {
      ...BASE,
      shadedFraction: { skipped: 'the subject is the shadow atlas' }
    })
    const { code } = runVerify()
    expect(code).toBe(0)
  })

  it('a degenerate receipt (A 0.00 %, B 0.02 %, ratio 10.7) fails as no shadow in frame', () => {
    cleanFixture()
    const side = (fraction: number, rise: number) => ({
      fraction,
      meanOn: 0.5,
      meanOff: 0.5001,
      rise,
      classified: 1000
    })
    setupCase('shadow-degenerate', {
      ...BASE,
      shadedFraction: {
        A: side(0.00002, 1.3e-4),
        B: side(0.0002, 1.2e-4),
        ratio: 10.737,
        flagsOff: { A: [false], B: [false] },
        flagsRestored: { A: [true], B: [true] },
        reasons: []
      }
    })
    const { code, output } = runVerify()
    expect(code).not.toBe(0)
    expect(output).toMatch(/no shadow in frame — side A shades 0\.00 %/)
  })
})

// the only record that a capture's tree
// passed its own suite. Corrupting provenance.e2e on all 63 committed captures
// moved the verdict not at all before this suite existed (ADR-011 A11)
describe('verify-results.mjs — e2e receipt', () => {
  afterAll(() => {
    cleanFixture()
  })

  const BASE = {
    ssim: 0.99,
    deMean: 0.1,
    deP95: 0.5,
    histDist: 0.001,
    metricsVersion: METRICS_VERSION,
    plate: GOOD_PLATE
  }
  const GREEN_E2E = {
    inputsKey: 'a'.repeat(64),
    verdict: 'green',
    detail: 'e2e passed, all 128 tests',
    overrideArmed: false
  }
  // Hoisted like GOOD_RECEIPT in the shaded-fraction suite, so the state under
  // test (the STAMP) is named once and each case's nesting stays flat
  const RED_E2E = {
    ...GREEN_E2E,
    verdict: 'red',
    detail: 'e2e FAILED: p0 gate › console errors'
  }
  const STALE_E2E = {
    ...GREEN_E2E,
    verdict: 'stale',
    detail: 'receipt is for inputs 15416e0e, this tree hashes b908bd25'
  }
  const EMPTY_KEY = {
    ...GREEN_E2E,
    inputsKey:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  }

  it('a green receipt with perfect metrics passes', () => {
    cleanFixture()
    setupCase('e2e-green', {
      ...BASE,
      provenance: { e2e: GREEN_E2E, skips: { build: false, typecheck: false } }
    })
    const { code, output } = runVerify()
    table('verify-e2e-green', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'e2e group absent (nothing to report)',
        expected: false,
        actual: output.includes('only a RED one fails')
      }
    ])
    expect(code).toBe(0)
    expect(output).not.toContain('only a RED one fails')
    cleanFixture()
  })

  // The guard's whole purpose. Before the check this exited 0 on a capture
  // whose own suite was failing, which is the same class of vacuous green the
  // task was filed about
  it('a RED receipt fails, naming the detail', () => {
    cleanFixture()
    setupCase('e2e-red', { ...BASE, provenance: { e2e: RED_E2E } })
    const { code, output } = runVerify()
    table('verify-e2e-red', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'names the failing test',
        expected: true,
        actual: output.includes('p0 gate › console errors')
      }
    ])
    expect(code).toBe(1)
    expect(output).toMatch(/e2e receipt was RED at capture time/)
    cleanFixture()
  })

  // accepted[] must not downgrade it, the same rule metricsVersion follows: a
  // capture that measured a red tree is not a difference, it is not evidence
  it('a RED receipt is not downgradeable by accepted[]', () => {
    cleanFixture()
    setupCase('e2e-red-low', {
      ...BASE,
      ssim: 0.5,
      provenance: { e2e: { ...GREEN_E2E, verdict: 'red', detail: 'red' } }
    })
    const { code, output } = runVerify()
    // The CASE line, not the whole output: the summary always prints the word
    // "expected-difference", so asserting on it would pass vacuously
    const line = output.split('\n').find(l => l.includes('e2e-red-low')) ?? ''
    expect(code).toBe(1)
    expect(line).toMatch(/e2e receipt was RED at capture time/)
    expect(line).toContain('fail')
    expect(line).not.toContain('expected-difference')
    cleanFixture()
  })

  // A stale key is the NORMAL state of historical evidence (the key hashes the
  // working tree, which moves on the next commit), so refusing it would redden
  // the ladder on any commit. It warns on stale for the same reason
  it('a stale receipt is reported, not failed', () => {
    cleanFixture()
    setupCase('e2e-stale', {
      ...BASE,
      provenance: { e2e: STALE_E2E }
    })
    const { code, output } = runVerify()
    table('verify-e2e-stale', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'reported by name',
        expected: true,
        actual: output.includes('e2e receipt stale')
      }
    ])
    expect(code).toBe(0)
    expect(output).toContain('e2e receipt stale')
    cleanFixture()
  })

  // Finding 2 (oc_6): the stale detail embeds that capture's own inputs key,
  // so two stale captures with DIFFERENT keys must still group as one reason
  it('groups stale captures by REASON, even when their keys differ', () => {
    cleanFixture()
    const keyA = 'a'.repeat(63) + '1'
    const keyB = 'b'.repeat(63) + '2'
    setupCase('stale-a', {
      ...BASE,
      provenance: { e2e: { ...STALE_E2E, detail: `keys differ: ${keyA}` } }
    })
    setupCase('stale-b', {
      ...BASE,
      provenance: { e2e: { ...STALE_E2E, detail: `keys differ: ${keyB}` } }
    })
    const { code, output } = runVerify()
    table('verify-e2e-grouped', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'one grouped line, count 2',
        expected: true,
        actual: /2x\s+e2e receipt stale/.test(output)
      },
      {
        field: 'detail of the first kept',
        expected: true,
        actual: output.includes(keyA)
      }
    ])
    expect(code).toBe(0)
    // ONE line for the reason, not one per capture
    const lines = output
      .split('\n')
      .filter(l => l.includes('e2e receipt stale'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('2x')
    // The per-capture key survives as the detail rather than being dropped
    expect(lines[0]).toContain(keyA)
    cleanFixture()
  })

  it('the per-run override is reported even beside a green verdict', () => {
    cleanFixture()
    setupCase('e2e-overridden', {
      ...BASE,
      provenance: {
        e2e: { ...GREEN_E2E, overrideArmed: true },
        skips: { build: false, typecheck: false }
      }
    })
    const { code, output } = runVerify()
    table('verify-e2e-override', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'override named',
        expected: true,
        actual: output.includes('PARITY_SKIP_E2E_RECEIPT=1')
      }
    ])
    expect(code).toBe(0)
    expect(output).toContain('PARITY_SKIP_E2E_RECEIPT=1')
    cleanFixture()
  })

  // The task's second item: these two skips were warned about at runtime and
  // stamped NOWHERE, so a committed capture could not be said to have skipped
  // them. Both directions, so a test that only proves one skip is caught
  it('the build and typecheck skips are stamped and reported', () => {
    cleanFixture()
    setupCase('e2e-build-skip', {
      ...BASE,
      provenance: {
        e2e: GREEN_E2E,
        skips: { build: true, typecheck: true }
      }
    })
    const { code, output } = runVerify()
    table('verify-e2e-skips', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'build skip reported',
        expected: true,
        actual: output.includes('PARITY_SKIP_BUILD=1')
      },
      {
        field: 'typecheck skip reported',
        expected: true,
        actual: output.includes('PARITY_SKIP_TYPECHECK=1')
      }
    ])
    expect(code).toBe(0)
    expect(output).toContain('PARITY_SKIP_BUILD=1')
    expect(output).toContain('PARITY_SKIP_TYPECHECK=1')
    cleanFixture()
  })

  // Two ways to be absent, saying different things: no provenance at all (an
  // older capture) versus provenance with no e2e block in it. Both reported,
  // neither refused: a block predating the gate cannot be evidence either way
  it('an absent e2e block is reported, never refused (it predates the gate)', () => {
    cleanFixture()
    setupCase('no-e2e', { ...BASE, provenance: { git: { commit: 'a' } } })
    const { code, output } = runVerify()
    table('verify-e2e-absent', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'reported as predating the receipt',
        expected: true,
        actual: output.includes('predates the receipt gate')
      }
    ])
    expect(code).toBe(0)
    expect(output).toContain('predates the receipt gate')
    cleanFixture()
  })

  it('no provenance at all is reported distinctly from an absent block', () => {
    cleanFixture()
    setupCase('no-prov', { ...BASE, provenance: null })
    const { code, output } = runVerify()
    expect(code).toBe(0)
    expect(output).toContain('no provenance at all')
    expect(output).not.toContain('predates the receipt gate')
    cleanFixture()
  })

  // A receipt whose key is the SHA-256 of nothing is the fleet's four-times-hit
  // key-of-nothing trap. It is not a green, and it must not be reported as one
  it('a key of nothing reads as stale, not as a pass', () => {
    cleanFixture()
    setupCase('e2e-empty-key', {
      ...BASE,
      provenance: { e2e: EMPTY_KEY }
    })
    const { code, output } = runVerify()
    expect(code).toBe(0)
    expect(output).not.toContain('only a RED one fails')
    cleanFixture()
  })
})

// (ADR-014 tripwire): an accepted[] entry may
// carry `floor: { ssim }`. Below it the case FAILS as "beyond the accepted
// footprint": a difference larger than the ADR measured is a real defect
describe('verify-results.mjs — accepted[] floor', () => {
  const FLOOR_RESULTS_DIR = join(
    tmpdir(),
    `verify-results-floor-${process.pid}`
  )
  const FLOOR_PHASE_DIR = join(FLOOR_RESULTS_DIR, TEST_PHASE)
  const THRESHOLDS_PATH = join(
    tmpdir(),
    `verify-results-floor-thresholds-${process.pid}.json`
  )
  const REAL_THRESHOLDS = join(
    ROOT,
    'examples',
    'parity',
    'cases',
    'thresholds.json'
  )

  function writeThresholds(accepted: unknown[]): void {
    const real = JSON.parse(readFileSync(REAL_THRESHOLDS, 'utf-8')) as Record<
      string,
      unknown
    >
    writeFileSync(THRESHOLDS_PATH, JSON.stringify({ ...real, accepted }))
  }

  function setupFloorCase(caseName: string, ssim: number): void {
    const caseDir = join(FLOOR_PHASE_DIR, caseName)
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(
      join(caseDir, 'metrics.json'),
      JSON.stringify({
        ssim,
        deP95: 1.0,
        histDist: 0.01,
        plate: GOOD_PLATE,
        metricsVersion: METRICS_VERSION
      })
    )
  }

  function runFloorVerify(): { code: number; output: string } {
    try {
      const output = execFileSync('node', [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 10000,
        env: {
          ...process.env,
          PARITY_RESULTS_DIR: FLOOR_RESULTS_DIR,
          PARITY_THRESHOLDS_PATH: THRESHOLDS_PATH
        }
      })
      return { code: 0, output }
    } catch (err: unknown) {
      const e = isExecError(err)
      return {
        code: e.status ?? 1,
        output: (e.stdout ?? '') + (e.stderr ?? '')
      }
    }
  }

  function cleanFloorFixture(): void {
    if (existsSync(FLOOR_RESULTS_DIR)) {
      rmSync(FLOOR_RESULTS_DIR, { recursive: true, force: true })
    }
  }

  afterAll(() => {
    cleanFloorFixture()
    if (existsSync(THRESHOLDS_PATH)) rmSync(THRESHOLDS_PATH)
  })

  // Phase 0 gates ssim at 0.95 and every case below sits under it, so the
  // accepted[] path is the only way to a non-fail result
  const ENTRY = {
    pattern: 'floor-case',
    reason: 'test: documented non-parity with a measured footprint',
    floor: { ssim: 0.9 }
  }

  it('at or above the floor: the accepted entry downgrades to expected-difference', () => {
    cleanFloorFixture()
    writeThresholds([ENTRY])
    setupFloorCase('floor-case', 0.93)
    const { code, output } = runFloorVerify()
    const line = output.split('\n').find(l => l.includes('floor-case')) ?? ''
    table('verify-floor-above', [
      { field: 'exit', expected: '0', actual: String(code) },
      {
        field: 'result',
        expected: 'expected-difference',
        actual: line.includes('expected-difference')
          ? 'expected-difference'
          : 'other'
      }
    ])
    expect(code).toBe(0)
    expect(line).toContain('expected-difference')
    expect(line).toContain('accepted:')
  })

  it('below the floor: FAIL as beyond the accepted footprint, naming both numbers', () => {
    cleanFloorFixture()
    writeThresholds([ENTRY])
    setupFloorCase('floor-case', 0.85)
    const { code, output } = runFloorVerify()
    const line = output.split('\n').find(l => l.includes('floor-case')) ?? ''
    table('verify-floor-below', [
      { field: 'exit', expected: '1', actual: String(code) },
      {
        field: 'reason',
        expected: 'beyond the accepted footprint',
        actual: line.includes('beyond the accepted footprint')
          ? 'beyond the accepted footprint'
          : 'other'
      }
    ])
    expect(code).toBe(1)
    expect(line).not.toContain('expected-difference')
    expect(line).toContain('beyond the accepted footprint')
    expect(line).toContain('0.8500')
    expect(line).toContain('0.9000')
  })

  it('an entry without a floor keeps the existing semantics (any shortfall downgrades)', () => {
    cleanFloorFixture()
    writeThresholds([{ pattern: 'floor-case', reason: 'test: no floor' }])
    setupFloorCase('floor-case', 0.5)
    const { code, output } = runFloorVerify()
    const line = output.split('\n').find(l => l.includes('floor-case')) ?? ''
    expect(code).toBe(0)
    expect(line).toContain('expected-difference')
  })

  it('a malformed floor is a broken gate (exit 2), never a silent acceptance', () => {
    cleanFloorFixture()
    writeThresholds([{ ...ENTRY, floor: { ssim: 'high' } }])
    setupFloorCase('floor-case', 0.93)
    const { code, output } = runFloorVerify()
    table('verify-floor-malformed', [
      { field: 'exit', expected: '2', actual: String(code) }
    ])
    expect(code).toBe(2)
    expect(output).not.toContain('expected-difference')
  })
})

// the SERVED bytes, read at VERIFY time. Found by oc_6 reviewing #243,
// which injected bad provenance into all 63 committed captures and got 59
// pass / 0 fail, exit 0. ADR-011 Amendment 12.
describe('verify-results.mjs — served-byte provenance', () => {
  afterAll(() => {
    cleanFixture()
  })

  const BASE = {
    ssim: 0.99,
    deMean: 0.1,
    deP95: 0.5,
    histDist: 0.001,
    metricsVersion: METRICS_VERSION,
    plate: GOOD_PLATE
  }
  const SOUND_BUILD = {
    built: {
      root: '<tmp>/wt',
      files: ['build/shared.js'],
      digest: 'a'.repeat(64),
      sharedSha256: 'a'.repeat(64)
    },
    served: {
      root: '<tmp>/wt',
      files: ['build/shared.js'],
      digest: 'a'.repeat(64),
      sharedSha256: 'a'.repeat(64)
    },
    error: null,
    servedIsBuilt: true,
    builtFromKey: 'b'.repeat(64)
  }
  const SOUND_TREE = {
    root: '<tmp>/wt',
    head: 'c'.repeat(40),
    error: null
  }
  // A REGISTERED accepted[] pattern, so the downgrade test below exercises
  // accepted[] rather than failing on ssim alone
  const ACCEPTED_CASE = 'debug-sample-count'
  const GOOD = {
    e2e: {
      inputsKey: 'd'.repeat(64),
      verdict: 'green',
      detail: 'e2e passed',
      overrideArmed: false
    },
    build: SOUND_BUILD,
    servedTree: SOUND_TREE
  }

  function caseLine(output: string, name: string): string {
    return output.split('\n').find(l => l.includes(name)) ?? ''
  }

  // SOUND_BUILD with servedIsBuilt forced to `value`, deleted when undefined,
  // so the absent case is a genuinely absent key rather than an explicit null
  function buildWith(value: unknown): Record<string, unknown> {
    const build = { ...SOUND_BUILD } as Record<string, unknown>
    if (value === undefined) {
      delete build.servedIsBuilt
    } else {
      build.servedIsBuilt = value
    }
    return build
  }

  it('sound served provenance passes and reports nothing', () => {
    cleanFixture()
    setupCase('served-sound', { ...BASE, provenance: GOOD })
    const { code, output } = runVerify()
    table('verify-served-sound', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'absent-block group absent',
        expected: false,
        actual: output.includes('predates the served-tree gate')
      }
    ])
    expect(code).toBe(0)
    expect(output).not.toContain('predates the served-tree gate')
    cleanFixture()
  })

  // The guard's whole purpose. Before the check this exited 0 on a capture
  // that measured bytes which are not this project's
  it('servedIsBuilt=false fails, naming both builds', () => {
    cleanFixture()
    setupCase('served-not-built', {
      ...BASE,
      provenance: {
        ...GOOD,
        build: {
          ...SOUND_BUILD,
          served: { ...SOUND_BUILD.served, digest: 'e'.repeat(64) },
          servedIsBuilt: false
        }
      }
    })
    const { code, output } = runVerify()
    const line = caseLine(output, 'served-not-built')
    table('verify-served-not-built', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'names servedIsBuilt=false',
        expected: true,
        actual: line.includes('servedIsBuilt=false')
      },
      {
        field: 'names both build digests',
        expected: true,
        actual: line.includes('eeee') && line.includes('aaaa')
      }
    ])
    expect(code).toBe(1)
    expect(line).toMatch(/did not serve the build this capture recorded/)
    expect(line).toContain('servedIsBuilt=false')
    cleanFixture()
  })

  // The capture-time gate refuses on an unresolvable served tree, so verify
  // cannot accept one either: absence there is a refusal, not a pass
  it('an unresolvable served tree fails', () => {
    cleanFixture()
    setupCase('served-tree-unresolved', {
      ...BASE,
      provenance: {
        ...GOOD,
        servedTree: { root: null, head: null, error: 'no such link' }
      }
    })
    const { code, output } = runVerify()
    const line = caseLine(output, 'served-tree-unresolved')
    table('verify-served-tree-unresolved', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'carries the resolution error',
        expected: true,
        actual: line.includes('no such link')
      }
    ])
    expect(code).toBe(1)
    expect(line).toMatch(/could not be resolved at capture time/)
    cleanFixture()
  })

  // root resolves but HEAD does not: the bytes cannot be placed in any lineage
  it('a served tree with no readable HEAD fails', () => {
    cleanFixture()
    setupCase('served-tree-no-head', {
      ...BASE,
      provenance: {
        ...GOOD,
        servedTree: {
          root: '<tmp>/wt',
          head: null,
          error: 'not a git repository'
        }
      }
    })
    const { code, output } = runVerify()
    const line = caseLine(output, 'served-tree-no-head')
    expect(code).toBe(1)
    expect(line).toMatch(/no readable git HEAD/)
    cleanFixture()
  })

  // servedTree is an UNCONDITIONAL key of the provenance object, so an
  // artifact without one was edited afterwards. Reported, not refused: like an
  // absent build block it cannot say the bytes were wrong
  it('a DELETED servedTree block is reported, never refused', () => {
    cleanFixture()
    setupCase('served-tree-absent', {
      ...BASE,
      provenance: { e2e: GOOD.e2e, build: SOUND_BUILD }
    })
    const { code, output } = runVerify()
    table('verify-served-tree-absent', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'reported by name',
        expected: true,
        actual: output.includes('no servedTree block')
      }
    ])
    expect(code).toBe(0)
    expect(output).toContain('no servedTree block')
    cleanFixture()
  })

  // A capture with no build block PREDATES the stamp. It cannot say the bytes
  // were wrong, so it must not fail: refusing it would redden every historical
  // capture for the sin of being old (its lesson)
  it('an absent build block is reported, never refused', () => {
    cleanFixture()
    setupCase('served-no-block', {
      ...BASE,
      provenance: { git: { commit: 'a' } }
    })
    const { code, output } = runVerify()
    table('verify-served-no-block', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'reported as predating the gate',
        expected: true,
        actual: output.includes('predates the served-tree gate')
      }
    ])
    expect(code).toBe(0)
    expect(output).toContain('predates the served-tree gate')
    cleanFixture()
  })

  // A truthiness bug must not pass: absent and non-boolean are both unknown,
  // and unknown is not sound
  it('a missing or non-boolean servedIsBuilt fails', () => {
    const variants = [
      ['served-flag-absent', undefined],
      ['served-flag-null', null],
      ['served-flag-string', 'true']
    ] as const
    for (const [name, value] of variants) {
      cleanFixture()
      setupCase(name, {
        ...BASE,
        provenance: { ...GOOD, build: buildWith(value) }
      })
      const { code, output } = runVerify()
      table(`verify-${name}`, [
        { field: 'exit code', expected: 1, actual: code }
      ])
      expect(code).toBe(1)
      expect(caseLine(output, name)).toMatch(
        /did not serve the build this capture recorded/
      )
      cleanFixture()
    }
  })

  // accepted[] must not downgrade it, the same rule the red e2e receipt and the
  // stale metricsVersion follow. A REGISTERED accepted[] pattern, or an
  // unmatched name fails on ssim alone and passes with the gate deleted
  it('an unserved build is not downgradeable by accepted[]', () => {
    cleanFixture()
    setupCase(ACCEPTED_CASE, {
      ...BASE,
      ssim: 0.8158,
      provenance: { ...GOOD, build: { ...SOUND_BUILD, servedIsBuilt: false } }
    })
    const { code, output } = runVerify()
    const line = caseLine(output, ACCEPTED_CASE)
    table('verify-served-not-downgradeable', [
      { field: 'exit code', expected: 1, actual: code },
      {
        field: 'fails for the served reason',
        expected: true,
        actual: /did not serve the build/.test(line)
      },
      {
        field: 'not downgraded',
        expected: false,
        actual: line.includes('expected-difference')
      }
    ])
    expect(code).toBe(1)
    // The reason string makes this sensitive to the gate, since the
    // expected-difference path prints an ssim comparison instead
    expect(line).toMatch(/did not serve the build this capture recorded/)
    expect(line).not.toContain('expected-difference')
    cleanFixture()
  })

  // The guard for the guard: without the gate this fixture is a registered
  // accepted difference, so the test above would pass on ssim alone
  it('the accepted[] fixture IS an accepted difference without the gate', () => {
    cleanFixture()
    setupCase(ACCEPTED_CASE, { ...BASE, ssim: 0.8158, provenance: GOOD })
    const { code, output } = runVerify()
    const line = caseLine(output, ACCEPTED_CASE)
    table('verify-accepted-fixture-precondition', [
      { field: 'exit code', expected: 0, actual: code },
      {
        field: 'read as expected-difference',
        expected: true,
        actual: line.includes('expected-difference')
      }
    ])
    expect(code).toBe(0)
    expect(line).toContain('expected-difference')
    cleanFixture()
  })
})
