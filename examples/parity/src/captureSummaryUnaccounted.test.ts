// B9: an unaccounted case is not a pass. summarizeRun counted passes
// by SUBTRACTION, so a row with a missing or unknown result counted as a pass,
// and a new early exit that forgot to set one would silently not measure it
// Same shape as verify-results' missing-reading hole (549034b)

import { describe, expect, it } from 'vitest'

import { RECOGNISED_RESULTS, summarizeRun } from '../scripts/captureSummary.mjs'

describe('unaccounted summary rows (B9)', () => {
  it('the recognised set is the four the runner actually emits', () => {
    expect([...RECOGNISED_RESULTS].sort()).toEqual([
      'expected-difference',
      'fail',
      'pass',
      'skip'
    ])
  })

  it('a row with NO result does not pass', () => {
    const v = summarizeRun([{ case: 'ghost' }])
    expect(v.exitCode, 'a case with no result must not exit 0').toBe(1)
    expect(v.lines.join('\n')).toMatch(/no recognised result/)
    expect(v.lines.join('\n')).toMatch(/ghost/)
  })

  it('a row with an unrecognised result does not pass', () => {
    // A typo in a future call site is the realistic form of this
    const v = summarizeRun([{ case: 'typo', result: 'passed' }])
    expect(v.exitCode).toBe(1)
    expect(v.lines.join('\n')).toMatch(/typo/)
  })

  it('the four legitimate results are unaffected', () => {
    const v = summarizeRun([
      { case: 'a', result: 'pass' },
      { case: 'b', result: 'expected-difference' }
    ])
    expect(
      v.exitCode,
      'passes and accepted differences still exit 0'
    ).toBeUndefined()
    expect(v.failCount).toBe(0)
    expect(v.lines.join('\n')).not.toMatch(/no recognised result/)
  })

  it('a real failure is still reported as a failure, not as unaccounted', () => {
    const v = summarizeRun([{ case: 'c', result: 'fail' }])
    expect(v.failCount).toBe(1)
    expect(v.lines.join('\n')).not.toMatch(/no recognised result/)
  })
})
