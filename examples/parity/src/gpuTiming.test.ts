import { describe, expect, it } from 'vitest'

import {
  computeMedian,
  computeTimingReport,
  GpuTimingCollector,
  type GpuFrameSample
} from './metrics/gpuTiming'

describe('computeMedian', () => {
  it('returns 0 for empty array', () => {
    expect(computeMedian([])).toBe(0)
  })

  it('returns the single value for one-element array', () => {
    expect(computeMedian([5.5])).toBe(5.5)
  })

  it('returns the middle value for odd-length array', () => {
    expect(computeMedian([3, 1, 2])).toBe(2)
  })

  it('returns the average of two middle values for even-length array', () => {
    expect(computeMedian([4, 1, 3, 2])).toBe(2.5)
  })

  it('handles already-sorted input', () => {
    expect(computeMedian([1, 2, 3, 4, 5])).toBe(3)
  })

  it('handles reverse-sorted input', () => {
    expect(computeMedian([5, 4, 3, 2, 1])).toBe(3)
  })

  it('handles duplicate values', () => {
    expect(computeMedian([2, 2, 2, 2, 2])).toBe(2)
  })

  it('computes median of 32 synthetic GPU timing samples', () => {
    const samples = Array.from({ length: 32 }, (_, i) => 2.0 + i * 0.1)
    const expected = (samples[15]! + samples[16]!) / 2
    expect(computeMedian(samples)).toBeCloseTo(expected, 6)
  })

  it('does not mutate the input array', () => {
    const input = [3, 1, 2]
    computeMedian(input)
    expect(input).toEqual([3, 1, 2])
  })

  it('handles outliers correctly (median is robust)', () => {
    const normal = Array.from({ length: 30 }, () => 3.0)
    const withOutliers = [...normal, 100, 200]
    expect(computeMedian(withOutliers)).toBe(3.0)
  })
})

describe('computeTimingReport', () => {
  it('returns zeroed report for empty samples', () => {
    const report = computeTimingReport([])
    expect(report.medianMs).toBe(0)
    expect(report.passes).toEqual({})
    expect(report.sampleCount).toBe(0)
  })

  it('computes median total and per-pass from samples', () => {
    const samples: GpuFrameSample[] = [
      {
        totalMs: 3,
        passes: [
          { name: 'render', ms: 2 },
          { name: 'tonemap', ms: 1 }
        ]
      },
      {
        totalMs: 5,
        passes: [
          { name: 'render', ms: 3 },
          { name: 'tonemap', ms: 2 }
        ]
      },
      {
        totalMs: 4,
        passes: [
          { name: 'render', ms: 2.5 },
          { name: 'tonemap', ms: 1.5 }
        ]
      }
    ]
    const report = computeTimingReport(samples)
    expect(report.medianMs).toBe(4)
    expect(report.passes['render']).toBe(2.5)
    expect(report.passes['tonemap']).toBe(1.5)
    expect(report.sampleCount).toBe(3)
  })

  it('handles missing pass in some samples', () => {
    const samples: GpuFrameSample[] = [
      {
        totalMs: 3,
        passes: [
          { name: 'render', ms: 2 },
          { name: 'shadow', ms: 1 }
        ]
      },
      { totalMs: 4, passes: [{ name: 'render', ms: 3 }] }
    ]
    const report = computeTimingReport(samples)
    expect(report.passes['render']).toBe(2.5)
    expect(report.passes['shadow']).toBe(1)
  })
})

describe('GpuTimingCollector', () => {
  it('reports null when empty', () => {
    const c = new GpuTimingCollector(32)
    expect(c.report()).toBeNull()
    expect(c.ready).toBe(false)
    expect(c.count).toBe(0)
  })

  it('becomes ready at target count', () => {
    const c = new GpuTimingCollector(3)
    c.add({ totalMs: 1, passes: [] })
    c.add({ totalMs: 2, passes: [] })
    expect(c.ready).toBe(false)
    c.add({ totalMs: 3, passes: [] })
    expect(c.ready).toBe(true)
    expect(c.count).toBe(3)
  })

  it('evicts oldest samples past target count', () => {
    const c = new GpuTimingCollector(3)
    c.add({ totalMs: 1, passes: [] })
    c.add({ totalMs: 2, passes: [] })
    c.add({ totalMs: 3, passes: [] })
    c.add({ totalMs: 100, passes: [] })
    // oldest (1) was evicted; remaining: [2, 3, 100]
    expect(c.count).toBe(3)
    const report = c.report()!
    expect(report.medianMs).toBe(3)
  })

  it('reset clears all samples', () => {
    const c = new GpuTimingCollector(3)
    c.add({ totalMs: 1, passes: [] })
    c.add({ totalMs: 2, passes: [] })
    c.reset()
    expect(c.count).toBe(0)
    expect(c.report()).toBeNull()
  })
})
