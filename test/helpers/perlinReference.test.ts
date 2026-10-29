import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from './log'
import {
  glslFract,
  glslMod,
  glslStep,
  perlinReference,
  type Vec4
} from './perlinReference'

// The CPU twin is what s68's e2e checks the shader against, so it must be
// right on its own terms first. These assert properties that follow from the
// DEFINITION of periodic Perlin noise, independent of both implementations

describe('GLSL primitives (the ones JS gets wrong)', () => {
  setCurrentSpec('perlin-reference-primitives')

  test('mod floors rather than truncating', () => {
    // JS % would give -1 here, GLSL mod gives 3. Every negative coordinate in
    // the generators depends on this
    expect(glslMod(-1, 4)).toBe(3)
    expect(glslMod(5, 4)).toBe(1)
    expect(glslMod(-0.25, 1)).toBeCloseTo(0.75, 12)
  })

  test('fract returns the positive remainder', () => {
    expect(glslFract(-0.25)).toBeCloseTo(0.75, 12)
    expect(glslFract(2.5)).toBeCloseTo(0.5, 12)
  })

  test('step takes edge first', () => {
    expect(glslStep(0, -1)).toBe(0)
    expect(glslStep(0, 1)).toBe(1)
    expect(glslStep(0, 0)).toBe(1)
  })
})

describe('perlinReference', () => {
  setCurrentSpec('perlin-reference')

  const REP: Vec4 = [8, 8, 8, 8]

  test('is exactly zero at integer lattice points', () => {
    // Classic Perlin interpolates gradient dot products that all vanish when the
    // fractional part is zero. This is exact, not approximate, and it catches a
    // whole class of transcription slips in the gradient or fade code
    for (const p of [
      [0, 0, 0, 0],
      [1, 2, 3, 4],
      [-3, 5, -7, 2],
      [8, 8, 8, 8]
    ] as Vec4[]) {
      expect(perlinReference(p, REP)).toBeCloseTo(0, 12)
    }
  })

  test('is periodic in rep — the property the tiling depends on', () => {
    const points: Vec4[] = [
      [0.3, 0.7, 1.2, 2.9],
      [5.5, 0.1, 7.25, 3.75],
      [-1.4, 2.6, 0.05, 6.1]
    ]
    for (const p of points) {
      const base = perlinReference(p, REP)
      for (let axis = 0; axis < 4; axis++) {
        const shifted = [...p] as [number, number, number, number]
        shifted[axis]! += REP[axis]!
        expect(
          perlinReference(shifted as Vec4, REP),
          `shifting axis ${axis} by one period must not change the value`
        ).toBeCloseTo(base, 10)
      }
    }
  })

  test('stays within the range the 2.2 scale implies', () => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 2000; i++) {
      const p: Vec4 = [
        (i * 0.37) % 8,
        (i * 0.71) % 8,
        (i * 1.13) % 8,
        (i * 0.29) % 8
      ]
      const v = perlinReference(p, REP)
      expect(Number.isFinite(v)).toBe(true)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(min).toBeGreaterThan(-1.5)
    expect(max).toBeLessThan(1.5)
    // A generator that returned a constant would pass every check above
    expect(max - min).toBeGreaterThan(0.5)

    log('perlin-range', [
      { field: 'min', expected: '> -1.5', actual: +min.toFixed(6) },
      { field: 'max', expected: '< 1.5', actual: +max.toFixed(6) },
      { field: 'spread', expected: '> 0.5', actual: +(max - min).toFixed(6) }
    ])
  })

  test('is continuous — no seams between adjacent cells', () => {
    // Step across an integer boundary in tiny increments. A gradient or fade
    // error typically shows up as a discontinuity exactly at the lattice
    let prev = perlinReference([0.99, 0.5, 0.5, 0.5], REP)
    for (let i = 1; i <= 20; i++) {
      const x = 0.99 + i * 0.001
      const v = perlinReference([x, 0.5, 0.5, 0.5], REP)
      expect(Math.abs(v - prev)).toBeLessThan(0.05)
      prev = v
    }
  })

  test('is deterministic', () => {
    const p: Vec4 = [1.25, 3.5, 0.75, 6.125]
    expect(perlinReference(p, REP)).toBe(perlinReference(p, REP))
  })

  // The eight fixed points s68's acceptance compares against the shader through
  // an e2e readback. Pinned here so a change to the CPU twin is visible as a
  // diff rather than silently moving the target the shader is checked against
  test('fixed points are stable', () => {
    const points: Vec4[] = [
      [0.5, 0.5, 0.5, 0.5],
      [1.25, 2.5, 3.75, 0.125],
      [7.9, 7.9, 7.9, 7.9],
      [0.1, 0.2, 0.3, 0.4],
      [4.5, 0.0, 2.25, 6.5],
      [-0.5, 1.5, -2.5, 3.5],
      [2.0, 2.0, 2.0, 2.5],
      [6.75, 3.25, 1.5, 0.875]
    ]
    const values = points.map(p => +perlinReference(p, REP).toFixed(10))
    log(
      'perlin-fixed-points',
      points.map((p, i) => ({
        field: `(${p.join(', ')})`,
        expected: 'stable',
        actual: values[i]!
      }))
    )
    expect(values).toMatchSnapshot()
  })
})
