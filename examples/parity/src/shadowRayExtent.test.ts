import { DataUtils } from 'three'

import {
  reconstructShadowRayExtent,
  SHADOW_RAY_FAR_FALLBACK,
  shadowRayExtentCeilingUnit,
  type ShadowRayExtentField
} from './shadowRayExtent'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const

function input(overrides: Record<string, unknown> = {}) {
  return {
    width: 1,
    height: 1,
    inverseShadowMatrix: IDENTITY,
    worldToECEFMatrix: IDENTITY,
    altitudeCorrection: [0, 0, 3] as [number, number, number],
    sunDirection: [0, 0, 1] as [number, number, number],
    bottomRadius: 1,
    shadowTopHeight: 1,
    shadowBottomHeight: 0.5,
    ...overrides
  }
}

const extentOf = (field: ShadowRayExtentField): number[] => [...field.unit]

describe('shadow ray-extent reconstruction', () => {
  it('reconstructs the reference rayFar - rayNear value in unit space', () => {
    expect(extentOf(reconstructShadowRayExtent(input()))).toEqual([0.5])
    expect(
      extentOf(reconstructShadowRayExtent(input({ shadowBottomHeight: 0.25 })))
    ).toEqual([0.75])
  })

  it('keeps top-first texel order when geometry makes the rows distinct', () => {
    const translated: number[] = [...IDENTITY]
    translated[13] = 0.25
    const result = reconstructShadowRayExtent(
      input({ height: 2, inverseShadowMatrix: translated })
    )

    expect(result.unit).toHaveLength(2)
    expect(result.unit[0]).toBeLessThan(result.unit[1]!)
  })

  it('refuses incomplete geometry instead of returning an empty field', () => {
    expect(() =>
      reconstructShadowRayExtent(input({ inverseShadowMatrix: [1] }))
    ).toThrow('Invalid shadow ray-extent geometry')
    expect(() =>
      reconstructShadowRayExtent(input({ sunDirection: [0, 0, 0] }))
    ).toThrow('Invalid shadow sun direction')
  })

  it('ceiling comes from the shadow fallback and never from clouds.maxRayDistance', () => {
    const bottomRadius = 6360000
    expect(shadowRayExtentCeilingUnit(bottomRadius)).toBe(
      SHADOW_RAY_FAR_FALLBACK / bottomRadius
    )
    // The two differ by 5x on hardware, which is the whole of the p3 contract bug
    expect(
      shadowRayExtentCeilingUnit(bottomRadius) / (200000 / bottomRadius)
    ).toBeCloseTo(5, 6)
    // And the ceiling is reachable: a texel whose ray misses both shells writes it
    expect(
      extentOf(
        reconstructShadowRayExtent(
          input({ bottomRadius, shadowTopHeight: 1e6 })
        )
      )
    ).toEqual([quantise(SHADOW_RAY_FAR_FALLBACK / bottomRadius)])
  })

  it('allows one code where the extent is the size of its operands', () => {
    // A ray that misses both shells: the extent is the 1e6 fallback itself, no
    // cancellation anywhere, so only the fp16 store's own code is allowed
    const field = reconstructShadowRayExtent(
      input({ bottomRadius: 6360000, shadowTopHeight: 1e6 })
    )

    expect([...field.ulpAllowance]).toEqual([1])
  })

  it('widens the allowance where the extent cancels two nearly equal roots', () => {
    // The measured hardware geometry: the cascade-2 sun position sits 3.5e7 m
    // out grazing both shells, so the value is the 738 m DIFFERENCE of rayNear
    // 29415030 m and rayFar 29415768 m, and the two sides disagreed by 2.27 m
    const thin = reconstructShadowRayExtent(
      input({
        bottomRadius: 6360000,
        shadowTopHeight: 1400,
        shadowBottomHeight: 750,
        // z = 1 cancels the identity projection's -1, so p is exactly 3.5e7 out
        altitudeCorrection: [3.5e7, 0, 1],
        sunDirection: [0.9962892569122991, 0.08606809258452776, 0]
      })
    )

    // 738 m of shell inside a 3.5e7 m operand, so 1.16e-4 unit. The f32
    // normalisation of the sun direction moves the last half percent
    expect(thin.unit[0]!).toBeGreaterThan(0.000116)
    expect(thin.unit[0]!).toBeLessThan(0.0001167)
    // 211 codes derived, against the 6 hardware disagreed by, far below the 4096
    // cap (a factor of two)
    expect(thin.ulpAllowance[0]!).toBeGreaterThan(6)
    expect(thin.ulpAllowance[0]!).toBeLessThan(4096)
  })

  it('keeps a missing shell out of the sqrt sensitivity term', () => {
    // Only the inner shell is crossed: the outer miss contributes no sqrt, so
    // the allowance must stay far below the both-miss figure
    const innerOnly = reconstructShadowRayExtent(
      input({
        bottomRadius: 6360000,
        shadowTopHeight: 1e6,
        shadowBottomHeight: 750,
        altitudeCorrection: [0, 0, 6380000]
      })
    )

    expect(innerOnly.ulpAllowance[0]).toBe(1)
  })
})

function quantise(value: number): number {
  return DataUtils.fromHalfFloat(DataUtils.toHalfFloat(value))
}
