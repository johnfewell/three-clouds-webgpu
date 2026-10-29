import { describe, expect, it } from 'vitest'

import {
  BenchmarkUnsupportedError,
  benchmarkUrl,
  summarise
} from '../examples/parity/scripts/benchmarks/browser.mjs'

describe('portable benchmark browser helpers', () => {
  it('builds a local deterministic case URL', () => {
    expect(
      benchmarkUrl('http://localhost:4173', {
        caseName: 'baseline-medium',
        width: 640,
        height: 360
      })
    ).toBe('http://localhost:4173/?case=baseline-medium&e2e=1&w=640&h=360')
  })

  it('summarises non-empty samples and retains raw values', () => {
    const result = summarise([3, 1, 2, 8])
    expect(result.values).toEqual([3, 1, 2, 8])
    expect(result.count).toBe(4)
    expect(result.median).toBe(2.5)
    expect(result.p95).toBe(8)
    expect(result.mean).toBe(3.5)
  })

  it('refuses a vacuous sample set', () => {
    expect(() => summarise([])).toThrow(/zero samples/)
  })

  it('refuses invalid samples but permits zero compute work', () => {
    expect(() => summarise([NaN])).toThrow(/invalid/)
    expect(() => summarise([Infinity])).toThrow(/invalid/)
    expect(() => summarise([-1])).toThrow(/invalid/)
    expect(summarise([0, 0]).median).toBe(0)
  })

  it('exposes a distinct unavailable error for missing side B', () => {
    expect(
      new BenchmarkUnsupportedError('side B is unavailable')
    ).toBeInstanceOf(Error)
  })
})
