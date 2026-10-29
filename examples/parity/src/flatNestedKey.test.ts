// a nested knob passed FLAT applied nothing, silently, and the
// read-back returned the old value, so a PCF probe "measured" its own noise
// floor. It was NOT caught by a re-measurement, contrary to
// 4f2434e's postscript. A silent no-op manufactures agreement and
// never announces itself in a number

import { describe, expect, it } from 'vitest'

import {
  PARITY_KEYS,
  PARITY_SET_EXCEPTIONS,
  validateParityStatePartial
} from './parityState'

const NESTED = PARITY_KEYS.filter(e => e.nested != null)
const FLAT = PARITY_KEYS.filter(e => e.nested == null)

describe('flat-form nested keys are refused', () => {
  it('there ARE nested keys to police', () => {
    // Guards the guard: if the nested form were ever removed this file would
    // otherwise pass by testing nothing
    expect(NESTED.length).toBeGreaterThan(0)
  })

  it('refuses the exact call that produced the false positive', () => {
    expect(() =>
      validateParityStatePartial({ maxShadowFilterRadius: 0 })
    ).toThrow(/passed FLAT|nested key/i)
  })

  it('names the correct nested path in the message', () => {
    // A refusal that does not say what to write instead just relocates the
    // confusion into the caller
    expect(() =>
      validateParityStatePartial({ maxShadowFilterRadius: 0 })
    ).toThrow(/clouds.*maxShadowFilterRadius/s)
  })

  it('refuses EVERY nested key in the flat form, not just the one that bit us', () => {
    for (const entry of NESTED) {
      expect(
        () => validateParityStatePartial({ [entry.key]: 1 }),
        `${entry.key} (${entry.nested!}) must be refused in the flat form`
      ).toThrow()
    }
  })

  it('accepts every nested key in its proper form', () => {
    for (const entry of NESTED) {
      expect(
        () =>
          validateParityStatePartial({ [entry.nested!]: { [entry.key]: 1 } }),
        `${entry.nested!}.${entry.key} must be accepted`
      ).not.toThrow()
    }
  })

  it('accepts every flat key, and the two documented exceptions', () => {
    for (const entry of FLAT) {
      expect(
        () => validateParityStatePartial({ [entry.key]: 1 }),
        `${entry.key} is a flat key and must be accepted`
      ).not.toThrow()
    }
    for (const key of PARITY_SET_EXCEPTIONS) {
      expect(() => validateParityStatePartial({ [key]: true })).not.toThrow()
    }
  })

  it('refuses an unknown key rather than dropping it', () => {
    expect(() => validateParityStatePartial({ notAKnob: 1 })).toThrow(
      /unknown key/i
    )
    expect(() =>
      validateParityStatePartial({ clouds: { notAKnob: 1 } })
    ).toThrow(/unknown clouds key/i)
  })

  it('refuses a key put in the WRONG nested group', () => {
    // Must pick a key owned by clouds ALONE: names repeat across groups
    // (`maxIterationCount` is in clouds and shadow), and a naive pick fails
    // against correct code. The validator had the same wrong assumption
    const ownedBy = (k: string): string[] =>
      NESTED.filter(e => e.key === k).map(e => e.nested!)
    const cloudsOnly = NESTED.find(
      e => e.nested === 'clouds' && ownedBy(e.key).length === 1
    )
    expect(cloudsOnly, 'expected at least one clouds-only key').toBeDefined()
    expect(() =>
      validateParityStatePartial({ shadow: { [cloudsOnly!.key]: 1 } })
    ).toThrow(/belongs to 'clouds'/)
  })

  it('accepts a key that legitimately belongs to BOTH groups, in either', () => {
    const shared = NESTED.filter(
      e => NESTED.filter(o => o.key === e.key).length > 1
    )
    expect(
      shared.length,
      'expected a key shared across groups'
    ).toBeGreaterThan(0)
    for (const entry of shared) {
      expect(
        () =>
          validateParityStatePartial({ [entry.nested!]: { [entry.key]: 1 } }),
        `${entry.nested!}.${entry.key} is real and must be accepted`
      ).not.toThrow()
    }
  })

  it('holds the exception list to exactly the two documented adapter keys', () => {
    // Each of these is a key both sides apply by DIFFERENT mechanisms, so it is
    // outside PARITY_KEYS by design. A third arriving silently would widen the
    // hole this test exists to close
    expect([...PARITY_SET_EXCEPTIONS].sort()).toEqual(['debug', 'enabled'])
  })
})
