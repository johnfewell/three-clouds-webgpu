// the digest gate's discriminator, pinned. Both failing rows were
// red-proved end to end, and stale must stay distinguishable from changed
// or a re-pin becomes an investigation: docs/digest-gate.md
// A .ts test reaching a .mjs through its .d.mts sibling, like the other
// plain-script gates here

import { describe, expect, it } from 'vitest'

import { classify } from './digest-parity.mjs'

const CASES: {
  name: string
  merged: boolean
  ref: boolean
  code: number
  contains: string
}[] = [
  {
    name: 'both pass: the flag-off output equals the ref and the literal is current',
    merged: true,
    ref: true,
    code: 0,
    contains: 'OK'
  },
  {
    name: 'merged fails, ref passes: the branch changed the default render',
    merged: false,
    ref: true,
    code: 1,
    contains: 'THE BRANCH CHANGED THE DEFAULT RENDER'
  },
  {
    name: 'both fail: the ref moved, so the literal is stale',
    merged: false,
    ref: false,
    code: 1,
    contains: 'STALE LITERAL'
  },
  {
    name: 'merged passes, ref fails: the branch renders what the ref does not',
    merged: true,
    ref: false,
    code: 1,
    contains: 'THE BRANCH DISAGREES WITH'
  }
]

describe('digest parity verdict', () => {
  for (const c of CASES) {
    it(`${c.name} -> exit ${c.code}`, () => {
      const { code, lines } = classify(c.merged, c.ref, 'origin/main')
      expect(code).toBe(c.code)
      expect(lines.join('\n')).toContain(c.contains)
    })
  }

  it('never lets a failure pass, so the gate cannot be talked out of blocking', () => {
    for (const merged of [true, false]) {
      for (const ref of [true, false]) {
        expect(classify(merged, ref, 'origin/main').code).toBe(
          merged && ref ? 0 : 1
        )
      }
    }
  })

  it('keeps stale and changed distinguishable, which is the whole point', () => {
    const changed = classify(false, true, 'origin/main')
    const stale = classify(false, false, 'origin/main')
    expect(changed.lines.join()).not.toBe(stale.lines.join())
    // the actionable difference: stale says re-pin, changed says do not
    expect(changed.lines.join()).not.toContain('re-pin')
    expect(stale.code).toBe(1)
  })

  it('names the ref in the verdict, so a stale message says what to measure', () => {
    expect(classify(false, false, 'deadbeef').lines.join('\n')).toContain(
      'deadbeef'
    )
  })
})
