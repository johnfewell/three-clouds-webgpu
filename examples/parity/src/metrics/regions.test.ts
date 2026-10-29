import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import {
  byteStats,
  changedPixels,
  meanAbsLuminanceDeltaOver,
  meanLuminanceOver,
  ndcBoxPixels,
  rayAltitudeRange,
  topFraction
} from './regions'

const rgba = (...pixels: Array<[number, number, number, number]>): number[] =>
  pixels.flat()

describe('region helpers for the p4 e2e clauses', () => {
  it('changedPixels reports RGB changes above epsilon and ignores alpha', () => {
    const a = rgba([0, 0, 0, 1], [0.5, 0.5, 0.5, 1], [1, 1, 1, 1])
    const b = rgba([0, 0, 0, 0], [0.5, 0.6, 0.5, 1], [1, 1, 1.00001, 1])
    const changed = changedPixels(a, b, 1e-3)
    table('changedPixels', [
      { expected: '[1]', actual: JSON.stringify(changed) }
    ])
    expect(changed).toEqual([1])
    expect(() => changedPixels(a, b.slice(4), 1e-3)).toThrow(/lengths differ/)
  })

  it('topFraction picks the largest values, at least one', () => {
    const values = [0.1, 0.9, -1, 0.5, 0.95]
    table('topFraction', [
      {
        fraction: 0.4,
        expected: '[4,1]',
        actual: JSON.stringify(topFraction(values, 0.4))
      },
      {
        fraction: 0.01,
        expected: '[4]',
        actual: JSON.stringify(topFraction(values, 0.01))
      }
    ])
    expect(topFraction(values, 0.4)).toEqual([4, 1])
    expect(topFraction(values, 0.01)).toEqual([4])
    expect(() => topFraction(values, 0)).toThrow()
    expect(() => topFraction([], 0.5)).toThrow()
  })

  it('region means use Rec.709 luminance and refuse an empty region', () => {
    const a = rgba([1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1])
    const b = rgba([0, 0, 0, 1], [0, 1, 0, 1], [0, 0, 0, 1])
    const mean = meanLuminanceOver(a, [0, 2])
    const delta = meanAbsLuminanceDeltaOver(a, b, [0, 1, 2])
    table('region-means', [
      { quantity: 'mean', expected: (0.2126 + 0.0722) / 2, actual: mean },
      { quantity: 'delta', expected: (0.2126 + 0.0722) / 3, actual: delta }
    ])
    expect(mean).toBeCloseTo((0.2126 + 0.0722) / 2, 12)
    expect(delta).toBeCloseTo((0.2126 + 0.0722) / 3, 12)
    expect(meanAbsLuminanceDeltaOver(b, a, [0, 1, 2])).toBeCloseTo(delta, 12)
    expect(() => meanLuminanceOver(a, [])).toThrow(/empty/)
    expect(() => meanAbsLuminanceDeltaOver(a, b, [])).toThrow(/empty/)
  })

  it('byteStats separates a blank frame from a structured one', () => {
    const blank = byteStats(Array<number>(12).fill(0))
    const structured = byteStats([0, 255, 0, 255, 128, 128])
    table('byteStats', [
      { frame: 'blank', mean: blank.mean, variance: blank.variance },
      {
        frame: 'structured',
        mean: structured.mean,
        variance: structured.variance
      }
    ])
    expect(blank).toEqual({ mean: 0, variance: 0 })
    expect(structured.variance).toBeGreaterThan(5)
    expect(() => byteStats([])).toThrow(/empty/)
  })

  // The p4 test 7b geometry: a camera at 5000 m on the equator (world == ECEF,
  // radius ER) looking along the horizon, marching 200 km, gap [2200, 7500] m
  const ER = 6378137
  const origin = [0, ER + 5000, 0] as const
  const down = (deg: number) => {
    const r = (deg * Math.PI) / 180
    return [Math.cos(r), -Math.sin(r), 0] as const
  }
  const bruteForce = (d: readonly [number, number, number], length: number) => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i <= 20000; i++) {
      const t = (length * i) / 20000
      const h =
        Math.hypot(
          origin[0] + t * d[0],
          origin[1] + t * d[1],
          origin[2] + t * d[2]
        ) - ER
      min = Math.min(min, h)
      max = Math.max(max, h)
    }
    return { min, max }
  }

  it('rayAltitudeRange matches a brute-force march of the ray', () => {
    const rows = [0, 0.5, 1.5, 10, -5].map(deg => {
      const got = rayAltitudeRange(origin, down(deg), 2e5, ER)
      const want = bruteForce(down(deg), 2e5)
      return {
        deg,
        minGot: got.min,
        minWant: want.min,
        maxGot: got.max,
        maxWant: want.max
      }
    })
    table('rayAltitudeRange-vs-bruteforce', rows)
    for (const r of rows) {
      // brute force samples every 10 m of path, so allow a metre of slack
      expect(Math.abs(r.minGot - r.minWant)).toBeLessThan(1)
      expect(Math.abs(r.maxGot - r.maxWant)).toBeLessThan(1)
    }
  })

  it('from 5000 m a band just below the horizon stays inside the gap', () => {
    const inGap = (deg: number) => {
      const { min, max } = rayAltitudeRange(origin, down(deg), 2e5, ER)
      return min > 2200 + 300 && max < 7500 - 300
    }
    const rows = [0, 0.3, 0.5, 1, 1.5, 1.7, 3].map(deg => ({
      deg,
      inGap: inGap(deg)
    }))
    table('gap-band', rows)
    // Horizontal rays climb past 7200 m by curvature within 200 km, and rays 3
    // deg down reach the low deck. The band between is what 7b measures
    expect(inGap(0)).toBe(false)
    expect(inGap(0.5)).toBe(true)
    expect(inGap(1.5)).toBe(true)
    expect(inGap(3)).toBe(false)
  })

  it('ndcBoxPixels selects the centred box and nothing outside it', () => {
    const box = ndcBoxPixels(8, 4, 0.5, 0.5)
    table('ndcBoxPixels', [
      { expected: '[10,11,12,13,18,19,20,21]', actual: JSON.stringify(box) }
    ])
    // 8x4: columns 2-5 (|ndcX| 0.125, 0.375) and rows 1-2 (|ndcY| 0.25)
    expect(box).toEqual([10, 11, 12, 13, 18, 19, 20, 21])
    expect(ndcBoxPixels(8, 4, 0.01, 0.01)).toEqual([])
  })
})
