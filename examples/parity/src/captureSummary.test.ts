// a skipped case is the absence of a plate, and the runner used to
// report it as "all N case(s) passed or accepted" with exit 0. These tests pin
// the verdict that capture.mjs prints and exits with
import { describe, expect, it } from 'vitest'

import { summarizeRun } from '../scripts/captureSummary.mjs'

const pass = (name: string) => ({ case: name, result: 'pass' })
const fail = (name: string) => ({ case: name, result: 'fail' })
const skip = (name: string, reason = 'probe-timeout') => ({
  case: name,
  result: 'skip',
  reason
})

describe('capture run verdict', () => {
  it('a clean run passes with exit code unset', () => {
    const v = summarizeRun([pass('a'), pass('b')])
    expect(v.exitCode).toBeUndefined()
    expect(v.skipCount).toBe(0)
    expect(v.lines).toEqual(['[capture] all 2 case(s) passed or accepted'])
  })

  it('a skipped case is NOT a pass: exit 1 and the case is named with its reason', () => {
    // The shape that produced three empty-but-"clean" runs in a worktree
    // without public/assets (CopperForest, mail #872)
    const v = summarizeRun([skip('shadow-both-moving')])
    expect(v.exitCode).toBe(1)
    expect(v.skipCount).toBe(1)
    const text = v.lines.join('\n')
    expect(text).toContain('SKIPPED')
    expect(text).toContain('shadow-both-moving (probe-timeout)')
    expect(text).toContain('--allow-skip')
    expect(text).not.toContain('all 1 case(s) passed')
  })

  it('a skip among passes still refuses, and the pass count excludes it', () => {
    const v = summarizeRun([pass('a'), skip('b'), pass('c')])
    expect(v.exitCode).toBe(1)
    expect(v.lines.at(-1)).toBe(
      '[capture] 2 case(s) passed or accepted, 1 skipped'
    )
  })

  it('--allow-skip accepts a partial run explicitly, and says so', () => {
    const v = summarizeRun([pass('a'), skip('b')], { allowSkip: true })
    expect(v.exitCode).toBeUndefined()
    const text = v.lines.join('\n')
    expect(text).toContain('--allow-skip: accepting a PARTIAL run')
    expect(text).toContain('b (probe-timeout)')
    expect(v.lines.at(-1)).toBe(
      '[capture] 1 case(s) passed or accepted, 1 skipped'
    )
  })

  it('a failure exits 1 outside sabotage mode and is left to the sabotage check inside it', () => {
    expect(summarizeRun([fail('a')]).exitCode).toBe(1)
    expect(
      summarizeRun([fail('a')], { sabotageMode: 'exposure' }).exitCode
    ).toBeUndefined()
  })

  it('sabotage mode does not excuse a skip: a case that never ran proves nothing', () => {
    const v = summarizeRun([fail('a'), skip('b')], { sabotageMode: 'exposure' })
    expect(v.exitCode).toBe(1)
    expect(v.failCount).toBe(1)
    expect(v.skipCount).toBe(1)
  })
})
