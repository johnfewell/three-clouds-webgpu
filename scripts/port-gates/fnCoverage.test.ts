import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

// fn-coverage.mjs is an AUDIT tool, not a gate, so it exits 0 whatever it
// finds. What must hold is that its DETECTORS fire, since one that silently
// matches nothing yields a fictional report. Each test pins one verdict

const ROOT = join(import.meta.dirname, '../..')
const GATE = join(ROOT, 'scripts/port-gates/fn-coverage.mjs')
const FIXTURE = join(ROOT, 'scripts/port-gates/fixtures/fn-coverage')

interface Row {
  file: string
  line: number
  kind: string
  name: string
  exported: boolean
  bucket: string
  twins: string[]
  snaps: string[]
  snapNamed: string[]
  orphanCpu: string[]
  crossModule: string[]
}

function run(): Row[] {
  // --tests points at a path that does not exist, so the fixture's own spec
  // cannot supply evidence: every verdict here comes from the detector's own
  // rules plus a hand-listed test source
  const out = execSync(
    `node ${GATE} ${ROOT} --src ${FIXTURE} --tests ${FIXTURE}/no-such-dir --json`,
    { cwd: ROOT, encoding: 'utf8' }
  )
  return JSON.parse(out) as Row[]
}

const rows = run()
const byName = (name: string): Row => {
  const row = rows.find(r => r.name === name)
  expect(row, `fixture has no Fn named ${name}`).toBeDefined()
  return row!
}

describe('fn-coverage detector', () => {
  setCurrentSpec('fn-coverage-fixture')

  it('finds every Fn in the fixture', () => {
    const names = rows.map(r => r.name).sort()
    log('fn-coverage-fixture-sites', {
      count: rows.length,
      names: names.join(' ')
    })
    expect(rows.length).toBe(7)
    expect(names).toContain('alpha')
    expect(names).toContain('betaFunction')
    expect(names).toContain('applyGamma')
    expect(names).toContain('deltaTSL')
    expect(names).toContain('epsilonInner')
    expect(names).toContain('epsilonOuter')
    expect(names).toContain('orphanFn')
  })

  it('pairs an exact twin: getLayerDensity / cpuGetLayerDensity shape', () => {
    // convention 1 + 2: a module export named `<name>CPU` or `cpu<Name>`
    const row = byName('alpha')
    log('fn-coverage-alpha', { bucket: row.bucket, twins: row.twins.join(' ') })
    expect(row.bucket).toBe('both')
    expect(row.twins.join(' ')).toContain('alphaCPU')
  })

  it('pairs a twin with a trailing Function decoration', () => {
    // the suffix case: `shapeAlteringFunction` / `cpuShapeAltering`. The
    // detector held `'Function'` in its decoration list while lowercasing every
    // remainder, so the pair never matched
    const row = byName('betaFunction')
    log('fn-coverage-betaFunction', {
      bucket: row.bucket,
      twins: row.twins.join(' ')
    })
    expect(row.bucket).toBe('both')
    expect(row.twins.join(' ')).toContain('cpuBeta')
  })

  it('pairs a twin with a leading apply decoration', () => {
    // the prefix case, and it must compare case-INSENSITIVELY:
    // `cpuSurfaceLightingMask` has an internal capital
    const row = byName('applyGamma')
    log('fn-coverage-applyGamma', {
      bucket: row.bucket,
      twins: row.twins.join(' ')
    })
    expect(row.bucket).toBe('both')
    expect(row.twins.join(' ')).toContain('cpuGamma')
  })

  it('pairs a TSL-suffixed Fn with its sibling plain-JS export', () => {
    // the case the first pass missed entirely: `phaseFunctionTSL` twins the
    // sibling `phaseFunction` in the same file
    const row = byName('deltaTSL')
    log('fn-coverage-deltaTSL', {
      bucket: row.bucket,
      twins: row.twins.join(' ')
    })
    expect(row.bucket).toBe('both')
    expect(row.twins.join(' ')).toContain('delta')
  })

  it('reports NEITHER for an Fn no test touches', () => {
    // the fixture's canary. No twin and no compiled call site, yet an earlier
    // bucket function used the MODULE-scope snapshot count and read it as
    // snap-only because a sibling test compiled something
    const row = byName('orphanFn')
    log('fn-coverage-orphanFn', {
      bucket: row.bucket,
      snaps: row.snaps.length,
      snapNamed: row.snapNamed.length
    })
    expect(row.bucket).toBe('neither')
    expect(row.snapNamed).toHaveLength(0)
  })

  it('credits a module-private Fn through the exported caller that reaches it', () => {
    // epsilonInner is private and unnamed in the spec, epsilonOuter calls it
    // Local bindings must be call-graph nodes for the closure to see that
    const inner = byName('epsilonInner')
    const outer = byName('epsilonOuter')
    log('fn-coverage-epsilon', {
      inner: inner.bucket,
      outer: outer.bucket
    })
    expect(inner.bucket).toBe('snap-only')
    expect(inner.snapNamed.length).toBeGreaterThan(0)
    expect(outer.bucket).toBe('snap-only')
  })

  it('marks a module-private Fn as not exported', () => {
    // `export` was detected by a 400-character lookback that crossed the
    // previous statement, so a private Fn read as an exported entry point and
    // the audit demanded a test on a symbol no test can import
    expect(byName('epsilonInner').exported).toBe(false)
    expect(byName('alpha').exported).toBe(true)
  })
})
