// The exit test's verdict. It ends Phase A, so it must refuse every way a
// run can look green without proving anything: a texture that differs, a
// comparison over nothing, a GPU error, a missing case, and a control that
// did not move, which is what a dead comparator looks like

import { log } from '../../test/helpers/log'
import {
  caseVerdict,
  EXIT_CASES,
  EXIT_FAULTS,
  faultVerdict,
  formatTable,
  REQUIRED_CONTROLS,
  runVerdict
} from '../scripts/exitVerdict.mjs'

const LIVE_CONTROLS = {
  'extraFrame:linear': { differing: 117933 },
  'sunNudge:linear': { differing: 5012 },
  'sunNudge:layer': { differing: 30210 }
}

function report(over: Record<string, unknown> = {}) {
  return {
    errors: [],
    results: {
      layer: { differing: 0, maxDiff: 0 },
      linear: { differing: 0, maxDiff: 0 },
      depth: { skipped: 'depth24plus' }
    },
    controls: LIVE_CONTROLS,
    ...over
  }
}

describe('Phase A exit verdict', () => {
  it('passes identical textures with every control live', () => {
    const v = caseVerdict('baseline-medium', report())
    log('pass', { ...v, reasons: v.reasons.join('; ') })
    expect(v).toMatchObject({
      pass: true,
      compared: 2,
      identical: 2,
      maxDiff: 0
    })
    expect(v.skipped).toEqual(['depth (depth24plus)'])
  })

  it('fails one differing byte', () => {
    const v = caseVerdict(
      'x',
      report({
        results: {
          layer: { differing: 0, maxDiff: 0 },
          linear: { differing: 1, maxDiff: 3 }
        }
      })
    )
    expect(v.pass).toBe(false)
    expect(v.maxDiff).toBe(3)
    expect(v.reasons).toContain('linear: 1 bytes differ')
  })

  it('fails a comparison over nothing, and a missing report', () => {
    expect(caseVerdict('x', report({ results: {} })).reasons).toContain(
      'no textures compared'
    )
    expect(caseVerdict('x', null).pass).toBe(false)
  })

  it('fails a shape mismatch and a GPU error', () => {
    expect(
      caseVerdict('x', report({ results: { layer: { mismatchedShape: {} } } }))
        .pass
    ).toBe(false)
    expect(caseVerdict('x', report({ errors: ['validation'] })).pass).toBe(
      false
    )
  })

  it('fails when any required control did not move', () => {
    for (const control of Object.keys(LIVE_CONTROLS)) {
      const dead = { ...LIVE_CONTROLS, [control]: { differing: 0 } }
      const v = caseVerdict('x', report({ controls: dead }))
      expect(v.pass).toBe(false)
      expect(v.reasons.join(' ')).toContain(control)
    }
    // An absent control is as dead as a zero one
    expect(caseVerdict('x', report({ controls: {} })).pass).toBe(false)
    expect(Object.keys(REQUIRED_CONTROLS)).toEqual(['extraFrame', 'sunNudge'])
  })

  it('fails a run with a missing or failing case', () => {
    const pass = caseVerdict('baseline-medium', report())
    expect(runVerdict(['baseline-medium'], [pass]).pass).toBe(true)
    expect(
      runVerdict(['baseline-medium', 'shafts-low-sun'], [pass])
    ).toMatchObject({
      pass: false,
      missing: ['shafts-low-sun']
    })
    expect(runVerdict([], []).pass).toBe(false)
    const fail = caseVerdict('shafts-low-sun', report({ errors: ['e'] }))
    expect(
      runVerdict(['baseline-medium', 'shafts-low-sun'], [pass, fail]).failed
    ).toEqual(['shafts-low-sun'])
  })

  it('a fault counts as caught only on differing bytes from its own run', () => {
    const differing = {
      layer: { differing: 0, maxDiff: 0 },
      linear: { differing: 40, maxDiff: 9 }
    }
    expect(
      faultVerdict('sun', report({ fault: 'sun', results: differing }))
    ).toEqual({ fault: 'sun', caught: true, differingBytes: 40 })
    // An identical faulted run means the comparator is dead
    expect(faultVerdict('sun', report({ fault: 'sun' })).caught).toBe(false)
    // A run without the fault applied, or one that errored, proves nothing
    expect(faultVerdict('sun', report({ results: differing })).caught).toBe(
      false
    )
    expect(faultVerdict('frame', null).caught).toBe(false)
    expect(
      faultVerdict('sun', report({ fault: 'sun', results: {} })).caught
    ).toBe(false)
  })

  it('fails the run when any fault goes uncaught', () => {
    const pass = caseVerdict('baseline-medium', report())
    const caught = EXIT_FAULTS.map(fault => ({
      fault,
      caught: true,
      differingBytes: 1
    }))
    expect(runVerdict(['baseline-medium'], [pass], caught).pass).toBe(true)
    const one = caught.map((f, i) => (i === 0 ? { ...f, caught: false } : f))
    expect(runVerdict(['baseline-medium'], [pass], one)).toMatchObject({
      pass: false,
      uncaught: [EXIT_FAULTS[0]]
    })
    expect(runVerdict(['baseline-medium'], [pass], []).pass).toBe(false)
    expect(EXIT_FAULTS).toEqual(['sun', 'frame'])
  })

  it('names five cases covering the graphs the task asks for', () => {
    expect(EXIT_CASES).toHaveLength(5)
    for (const c of ['baseline-medium', 'temporal-on-orbit', 'shafts-low-sun'])
      expect(EXIT_CASES).toContain(c)
    expect(formatTable([caseVerdict('baseline-medium', report())])).toContain(
      '| baseline-medium | 2 | 2 | 0 | 5012 | 117933 | PASS |'
    )
  })
})
