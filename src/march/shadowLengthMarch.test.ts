// CPU twin tests for the shadow length march
// Cite: clouds.frag:622–650

import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  clampShadowAtCloudFront,
  getShadowRayNearFarCPU,
  marchShadowLengthCPU,
  marchShadowLengthQuadPartialCPU
} from './shadowLengthMarch'

describe('marchShadowLength CPU twin', () => {
  setCurrentSpec('shadowLengthMarch')

  test('constant OD field → shadowLength = (1 − e^{−od}) · Σ step_i', () => {
    const od = 0.5
    const minStep = 50
    const scale = 1.01
    const near = 0
    const far = 5000
    const jitter = 0.5
    const maxIter = 500

    const sampleOD = () => od

    const result = marchShadowLengthCPU(
      sampleOD,
      [0, 0, 0],
      [0, 0, 1],
      near,
      far,
      jitter,
      minStep,
      maxIter,
      scale
    )

    // Compute expected: sum of step sizes within [near, far]
    let expectedSum = 0
    let step = minStep
    let dist = step * jitter
    for (let i = 0; i < maxIter; i++) {
      if (dist > far - near) break
      expectedSum += step
      step *= scale
      dist += step
    }
    const expected = (1 - Math.exp(-od)) * expectedSum

    expect(result).toBeCloseTo(expected, 2)

    log('constant-od', {
      od,
      result,
      expected,
      relError: Math.abs(result - expected) / expected
    })
  })

  test('attenuation stays 1 (faithful port — never updated)', () => {
    const od = 1.0
    const minStep = 100
    // No scaling, so the steps are uniform
    const scale = 1.0
    const near = 0
    const far = 1000
    // Start at distance 0
    const jitter = 0
    const maxIter = 500

    const sampleOD = () => od

    const result = marchShadowLengthCPU(
      sampleOD,
      [0, 0, 0],
      [0, 0, 1],
      near,
      far,
      jitter,
      minStep,
      maxIter,
      scale
    )

    // With uniform step size=100, jitter=0: first rayDistance = 0
    // Steps at 0, 100, ..., 1000 → 11 steps (boundary included: 1000 > 1000 is false)
    const nSteps = 11
    const expected = (1 - Math.exp(-od)) * minStep * nSteps

    expect(result).toBeCloseTo(expected, 2)

    log('attenuation-stays-1', { result, expected, nSteps })
  })

  test('zero OD → zero shadow length', () => {
    const result = marchShadowLengthCPU(
      () => 0,
      [0, 0, 0],
      [0, 0, 1],
      0,
      5000,
      0.5,
      50,
      500,
      1.01
    )

    expect(result).toBe(0)

    log('zero-od', { result })
  })

  test('very large OD → shadowLength approaches Σ step_i', () => {
    // (1 - e^-100) ≈ 1
    const od = 100
    const minStep = 50
    const scale = 1.0
    const near = 0
    const far = 500

    const result = marchShadowLengthCPU(
      () => od,
      [0, 0, 0],
      [0, 0, 1],
      near,
      far,
      0,
      minStep,
      500,
      scale
    )

    // 11 steps of 50 (boundary included: 500 > 500 is false), each ≈ 1 * 50
    const expected = 550

    expect(result).toBeCloseTo(expected, 0)

    log('large-od', { result, expected })
  })

  test('perspectiveStepScale grows step sizes geometrically', () => {
    const minStep = 50
    // Each step doubles, and far is large enough not to be the limit
    const scale = 2.0
    const near = 0
    const far = 1e6
    const maxIter = 5

    const result = marchShadowLengthCPU(
      () => 1.0,
      [0, 0, 0],
      [0, 0, 1],
      near,
      far,
      0,
      minStep,
      maxIter,
      scale
    )

    // Steps: 50, 100, 200, 400, 800 → sum = 1550
    const factor = 1 - Math.exp(-1)
    const expected = factor * (50 + 100 + 200 + 400 + 800)

    expect(result).toBeCloseTo(expected, 2)

    log('geometric-steps', {
      result,
      expected,
      steps: [50, 100, 200, 400, 800]
    })
  })

  test('ray direction offsets sample positions correctly', () => {
    const positions: [number, number, number][] = []
    const sampleOD = (pos: [number, number, number]) => {
      positions.push([...pos])
      return 0.1
    }

    marchShadowLengthCPU(
      sampleOD,
      [10, 20, 30],
      [1, 0, 0],
      100,
      300,
      0,
      50,
      500,
      1.0
    )

    // rayOrigin = (10,20,30), rayDir = (1,0,0)
    // Positions should be along x-axis: rayOrigin + rayDistance * rayDir
    for (const p of positions) {
      expect(p[1]).toBe(20)
      expect(p[2]).toBe(30)
      expect(p[0]).toBeGreaterThanOrEqual(10)
    }

    log('ray-positions', {
      count: positions.length,
      firstX: positions[0]?.[0],
      lastX: positions[positions.length - 1]?.[0]
    })
  })
})

describe('getShadowRayNearFar CPU twin', () => {
  setCurrentSpec('shadowLengthMarch')

  test('below shadowTopHeight, no ground → (cameraNear, second.w)', () => {
    // cameraHeight, shadowTopHeight, cameraNear, ground, firstX and firstW
    // (unused here), secondW, maxShadowLengthRayDistance
    const [near, far] = getShadowRayNearFarCPU(
      1000,
      5000,
      0.1,
      false,
      -1,
      -1,
      8000,
      2e5
    )

    expect(near).toBe(0.1)
    expect(far).toBe(8000)

    log('below-no-ground', { near, far })
  })

  test('below shadowTopHeight, ground → (cameraNear, first.x)', () => {
    const [near, far] = getShadowRayNearFarCPU(
      1000,
      5000,
      0.1,
      true,
      3000,
      -1,
      8000,
      2e5
    )

    expect(near).toBe(0.1)
    expect(far).toBe(3000)

    log('below-ground', { near, far })
  })

  test('above shadowTopHeight, no ground → (first.w, second.w)', () => {
    const [near, far] = getShadowRayNearFarCPU(
      10000,
      5000,
      0.1,
      false,
      -1,
      2000,
      8000,
      2e5
    )

    expect(near).toBe(2000)
    expect(far).toBe(8000)

    log('above-no-ground', { near, far })
  })

  test('above shadowTopHeight, ground → (first.w, first.x)', () => {
    // firstX 3000 clamps far
    const [near, far] = getShadowRayNearFarCPU(
      10000,
      5000,
      0.1,
      true,
      3000,
      2000,
      8000,
      2e5
    )

    expect(near).toBe(2000)
    expect(far).toBe(3000)

    log('above-ground', { near, far })
  })

  test('far clamped by maxShadowLengthRayDistance', () => {
    // secondW 3e5 exceeds the max 2e5
    const [near, far] = getShadowRayNearFarCPU(
      1000,
      5000,
      0.1,
      false,
      -1,
      -1,
      3e5,
      2e5
    )

    expect(near).toBe(0.1)
    expect(far).toBe(2e5)

    log('clamped-max', { near, far })
  })
})

describe('clampShadowAtCloudFront', () => {
  setCurrentSpec('shadowLengthMarch')

  test('alpha=1 → far = min(frontDepth, far)', () => {
    const result = clampShadowAtCloudFront(10000, 5000, 1.0)
    expect(result).toBe(5000)

    log('clamp-alpha-1', { result })
  })

  test('alpha=0 → far unchanged', () => {
    const result = clampShadowAtCloudFront(10000, 5000, 0.0)
    expect(result).toBe(10000)

    log('clamp-alpha-0', { result })
  })

  test('alpha=0.5 → midpoint between far and min(frontDepth, far)', () => {
    const result = clampShadowAtCloudFront(10000, 5000, 0.5)
    // mix(10000, 5000, 0.5)
    expect(result).toBe(7500)

    log('clamp-alpha-half', { result })
  })

  test('frontDepth > far → no change regardless of alpha', () => {
    const result = clampShadowAtCloudFront(5000, 10000, 1.0)
    // min(10000, 5000) = 5000
    expect(result).toBe(5000)

    log('clamp-front-beyond', { result })
  })
})

// lightShaftsHalfResolution: the four lanes' partials partition the full
// march's samples (same positions and steps), so on one ray they sum to it
// exactly. That is the claim behind the quad sum in cloudsFragment.ts
describe('marchShadowLengthQuadPartial CPU twin (lightShaftsHalfResolution)', () => {
  setCurrentSpec('shadowLengthMarch-quad')

  // A field that varies along the ray, so a sample in the wrong place or with
  // the wrong step size cannot cancel out
  const sampleOD = ([x, y, z]: [number, number, number]) =>
    0.4 + 0.3 * Math.sin(z * 1e-3) + 0.1 * Math.cos((x + y) * 7e-4)
  const origin: [number, number, number] = [120, -40, 6371000]
  const direction: [number, number, number] = [0.1, 0.2, 0.9746794344808963]

  const cases: Array<{
    name: string
    near: number
    far: number
    jitter: number
    scale: number
    maxIter: number
  }> = [
    {
      name: 'default steps, far bound',
      near: 0,
      far: 12000,
      jitter: 0.37,
      scale: 1.01,
      maxIter: 500
    },
    {
      name: 'zero jitter',
      near: 300,
      far: 8000,
      jitter: 0,
      scale: 1.01,
      maxIter: 500
    },
    {
      name: 'unit step scale (g = 1)',
      near: 0,
      far: 3000,
      jitter: 0.8,
      scale: 1,
      maxIter: 500
    },
    {
      name: 'iteration cap binds, N % 4 != 0',
      near: 0,
      far: 1e9,
      jitter: 0.5,
      scale: 1.01,
      maxIter: 10
    },
    {
      name: 'iteration cap binds, N % 4 == 0',
      near: 0,
      far: 1e9,
      jitter: 0.5,
      scale: 1.01,
      maxIter: 8
    },
    {
      name: 'empty segment',
      near: 100,
      far: 20,
      jitter: 0.5,
      scale: 1.01,
      maxIter: 500
    }
  ]

  for (const c of cases) {
    test(`four lanes sum to the full march — ${c.name}`, () => {
      const full = marchShadowLengthCPU(
        sampleOD,
        origin,
        direction,
        c.near,
        c.far,
        c.jitter,
        50,
        c.maxIter,
        c.scale
      )
      const partials = [0, 1, 2, 3].map(lane =>
        marchShadowLengthQuadPartialCPU(
          sampleOD,
          origin,
          direction,
          c.near,
          c.far,
          c.jitter,
          50,
          c.maxIter,
          c.scale,
          lane
        )
      )
      const sum = partials.reduce((a, b) => a + b, 0)
      log(`quad-partition-${c.name}`, { full, partials, sum })
      // Float summation order differs, nothing else may
      expect(sum).toBeCloseTo(full, 6)
      if (c.name !== 'empty segment') {
        expect(full).toBeGreaterThan(0)
        // Every lane carries a comparable share: no lane is the whole march
        for (const p of partials) {
          expect(p).toBeGreaterThan(0)
          expect(p).toBeLessThan(full)
        }
      } else {
        expect(full).toBe(0)
      }
    })
  }
})
