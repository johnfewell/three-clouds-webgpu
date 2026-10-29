import { describe, expect, test } from 'vitest'

import {
  cloudShapeDetailReference,
  cloudShapeReference,
  perlinWorleyReference,
  remapReference,
  worleyFbmReference
} from './cloudTextureReference'
import { log, setCurrentSpec } from './log'
import type { Vec3 } from './tileableNoiseReference'

const POINTS: Vec3[] = [
  [0.1, 0.2, 0.3],
  [0.5, 0.5, 0.5],
  [0.75, 0.25, 0.9],
  [0.05, 0.95, 0.45]
]

describe('remapReference', () => {
  setCurrentSpec('cloud-texture-remap')

  test('matches both GLSL overloads', () => {
    // 5-arg: min2 + (x - min1) / (max1 - min1) * (max2 - min2)
    expect(remapReference(0.5, 0, 1, 10, 20)).toBeCloseTo(15, 12)
    // 3-arg implicitly remaps to [0, 1]
    expect(remapReference(0.4, 0.3, 0.5)).toBeCloseTo(0.5, 12)
    // deliberately unclamped, which the generators rely on
    expect(remapReference(2, 0, 1)).toBeCloseTo(2, 12)
  })
})

describe('cloud texture generators', () => {
  setCurrentSpec('cloud-texture-generators')

  // What makes a 128³ volume usable as a repeating texture. Perlin and Worley
  // tile over the unit cube, so this must hold, and it is the first thing a
  // mismatched frequency or a dropped mod() breaks while still looking right
  test.each([
    ['cloudShape', cloudShapeReference],
    ['cloudShapeDetail', cloudShapeDetailReference],
    ['perlinWorley', perlinWorleyReference],
    ['worleyFbm', worleyFbmReference]
  ])('%s tiles over the unit cube', (_name, fn) => {
    for (const p of POINTS) {
      const base = fn(p)
      for (let axis = 0; axis < 3; axis++) {
        const shifted = [...p] as [number, number, number]
        shifted[axis]! += 1
        expect(fn(shifted)).toBeCloseTo(base, 9)
      }
    }
  })

  test('cloudShapeDetail stays in [0, 1] by construction', () => {
    // Every band is 1 - worley (worley is clamped to [0,1]) and every weight set
    // sums to 1, so the result cannot leave [0, 1]. If it does, a weight or a
    // clamp has been transcribed wrong
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 300; i++) {
      const v = cloudShapeDetailReference([
        (i * 0.017) % 1,
        (i * 0.031) % 1,
        (i * 0.047) % 1
      ])
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max - min).toBeGreaterThan(0.1)

    log('cloud-shape-detail-range', [
      { field: 'min', expected: '>= 0', actual: +min.toFixed(6) },
      { field: 'max', expected: '<= 1', actual: +max.toFixed(6) }
    ])
  })

  test('cloudShape is finite and varies; its remap is not clamped', () => {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 300; i++) {
      const v = cloudShapeReference([
        (i * 0.019) % 1,
        (i * 0.037) % 1,
        (i * 0.053) % 1
      ])
      expect(Number.isFinite(v)).toBe(true)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max - min).toBeGreaterThan(0.1)

    // Recorded rather than asserted as a bound: the reference does not clamp
    // here, and the R8 target clamps on write. Pinning a range would invent a
    // contract the shader does not have
    log('cloud-shape-range', [
      { field: 'min', expected: 'finite', actual: +min.toFixed(6) },
      { field: 'max', expected: 'finite', actual: +max.toFixed(6) }
    ])
  })

  test('the two generators are not the same field', () => {
    // They share the band-fbm helper, so a wiring slip could silently make one
    // call the other's parameters
    for (const p of POINTS) {
      expect(cloudShapeReference(p)).not.toBeCloseTo(
        cloudShapeDetailReference(p),
        6
      )
    }
  })

  test('fixed points are stable', () => {
    const values = POINTS.map(p => ({
      shape: +cloudShapeReference(p).toFixed(10),
      detail: +cloudShapeDetailReference(p).toFixed(10)
    }))
    expect(values).toMatchSnapshot()
  })
})
