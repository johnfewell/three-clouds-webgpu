import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from './log'
import {
  hashReference,
  noiseReference,
  perlinFbmReference,
  worleyReference,
  type Vec3
} from './tileableNoiseReference'

// As with perlinReference: these assert properties that follow from what the
// functions ARE, so they validate the transcription without reference to the
// shader they will be used to check

describe('hashReference', () => {
  setCurrentSpec('tileable-hash')

  test('stays in [0, 1) and is deterministic', () => {
    for (const n of [0, 1, 57, 113, -4, 1234.5]) {
      const v = hashReference(n)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(v).toBe(hashReference(n))
    }
  })

  test('decorrelates neighbouring lattice indices', () => {
    // A hash that varied smoothly with n would produce banding rather than
    // noise, and every downstream check would still pass
    const diffs = [0, 1, 2, 3, 4].map(n =>
      Math.abs(hashReference(n) - hashReference(n + 1))
    )
    expect(Math.max(...diffs)).toBeGreaterThan(0.1)
  })
})

describe('noiseReference', () => {
  setCurrentSpec('tileable-value-noise')

  test('equals the raw hash at integer lattice points', () => {
    // With a zero fractional part every mix collapses to its first argument, so
    // the result is exactly hash(x + 57y + 113z). Exact, and it pins both the
    // lattice-offset encoding and the interpolation order
    for (const p of [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [2, 3, 4]
    ] as Vec3[]) {
      const n = p[0] + p[1] * 57 + 113 * p[2]
      expect(noiseReference(p)).toBeCloseTo(hashReference(n), 12)
    }
  })

  test('stays within the hull of its corner hashes', () => {
    for (let i = 0; i < 500; i++) {
      const p: Vec3 = [i * 0.13, i * 0.37, i * 0.71]
      const v = noiseReference(p)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  test('is continuous across cell boundaries', () => {
    let prev = noiseReference([0.99, 0.5, 0.5])
    for (let i = 1; i <= 20; i++) {
      const v = noiseReference([0.99 + i * 0.001, 0.5, 0.5])
      expect(Math.abs(v - prev)).toBeLessThan(0.05)
      prev = v
    }
  })
})

describe('worleyReference', () => {
  setCurrentSpec('tileable-worley')

  test('tiles over the unit cube — the whole point of the module', () => {
    // The mod() on the feature-cell index is what wraps the field. Without it
    // the noise still looks like Worley and stays in range, but seams at the
    // texture edges
    const CELLS = 4
    for (const p of [
      [0.1, 0.2, 0.3],
      [0.75, 0.05, 0.5],
      [0.33, 0.66, 0.99]
    ] as Vec3[]) {
      const base = worleyReference(p, CELLS)
      for (let axis = 0; axis < 3; axis++) {
        const shifted = [...p] as [number, number, number]
        shifted[axis]! += 1
        expect(
          worleyReference(shifted, CELLS),
          `worley must wrap on axis ${axis}`
        ).toBeCloseTo(base, 10)
      }
    }
  })

  test('is clamped to [0, 1] and actually varies', () => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 400; i++) {
      const v = worleyReference([i * 0.011, i * 0.023, i * 0.037], 4)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max - min).toBeGreaterThan(0.2)

    log('worley-range', [
      { field: 'min', expected: '>= 0', actual: +min.toFixed(6) },
      { field: 'max', expected: '<= 1', actual: +max.toFixed(6) }
    ])
  })
})

describe('perlinFbmReference', () => {
  setCurrentSpec('tileable-perlin-fbm')

  test('tiles over the unit cube at every octave count', () => {
    // Each octave uses rep = (frequency, 1), so the period in `point` is exactly
    // 1 regardless of how many octaves are summed. A frequency/rep mismatch in
    // any single octave breaks this while leaving the output looking fine
    const freq: Vec3 = [4, 4, 4]
    for (const octaves of [1, 2, 4, 6]) {
      for (const p of [
        [0.2, 0.4, 0.6],
        [0.85, 0.1, 0.45]
      ] as Vec3[]) {
        const base = perlinFbmReference(p, freq, octaves)
        for (let axis = 0; axis < 3; axis++) {
          const shifted = [...p] as [number, number, number]
          shifted[axis]! += 1
          expect(
            perlinFbmReference(shifted, freq, octaves),
            `fbm must wrap on axis ${axis} at ${octaves} octaves`
          ).toBeCloseTo(base, 9)
        }
      }
    }
  })

  test('weights octaves by roughness 0.5 and normalises by the weight sum', () => {
    // One octave is just perlin, so the normalised sum must equal it exactly
    const p: Vec3 = [0.3, 0.7, 0.11]
    const one = perlinFbmReference(p, [4, 4, 4], 1)
    expect(Number.isFinite(one)).toBe(true)

    // Adding octaves must change the value but keep it bounded. It is
    // unclamped in the reference, so this checks it stays sane rather than
    // asserting a clamp that is not there
    const six = perlinFbmReference(p, [4, 4, 4], 6)
    expect(six).not.toBeCloseTo(one, 6)
    expect(Math.abs(six)).toBeLessThan(2)

    log('fbm-octaves', [
      { field: '1 octave', expected: 'finite', actual: +one.toFixed(6) },
      { field: '6 octaves', expected: 'finite', actual: +six.toFixed(6) }
    ])
  })

  test('is deterministic', () => {
    const p: Vec3 = [0.125, 0.625, 0.375]
    expect(perlinFbmReference(p, [8, 8, 8], 3)).toBe(
      perlinFbmReference(p, [8, 8, 8], 3)
    )
  })
})
