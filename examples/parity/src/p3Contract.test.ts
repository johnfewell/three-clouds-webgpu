import { DataUtils } from 'three'

import { log } from '../../../test/helpers/log'
import { caseByName } from '../cases/index'
import {
  atlasContractPasses,
  deltasWithinMeasuredFloor,
  evaluateAtlasContract,
  evaluateShadowLengthSurfaceEnd,
  layerMaskContractPasses,
  motionContractPasses,
  neutralisationContractPasses,
  neutralisationFloorVerdict,
  plainReceiverContractPasses,
  receiverMask,
  receiverMaskDomainPasses,
  receiverMaskWithControls,
  receiverRatiosAgree,
  receiverShadowPasses,
  samplerTailContractPasses,
  shadowKnobContractPasses,
  shadowLengthSurfaceEndPasses,
  shaftsDarkeningPasses,
  shaftsEffectPasses,
  temporalContractPasses,
  type ReceiverShadowResult,
  type ShadowRayExtents
} from './p3Contract'
import { SHADOW_RAY_FAR_FALLBACK } from './shadowRayExtent'
import { groundDistances } from './surfaceDistance'

const quantize = (value: number): number =>
  DataUtils.fromHalfFloat(DataUtils.toHalfFloat(value))

// The twin ships the extent field AND the fp16 codes its own f32 arithmetic
// may be off by at each texel. 1 code is what a well-conditioned texel gets.
function witness(
  extent: readonly { width: number; height: number; data: number[] }[],
  ulpAllowance = 1
): ShadowRayExtents {
  return {
    extent,
    ulpAllowance: extent.map(layer => ({
      width: layer.width,
      height: layer.height,
      data: layer.data.map(() => ulpAllowance)
    }))
  }
}

describe('Phase 3 e2e contract predicates', () => {
  it('drives every atlas semantic arm red before the valid fixture passes', () => {
    const valid = [
      { width: 2, height: 1, data: [0.25, 1, 2, 3, 0.75, 0, 0, 0] }
    ]
    const rayExtents = [{ width: 2, height: 1, data: [0.25, 0.75] }]
    const broken = [
      { layers: [], extents: [] },
      {
        layers: [{ width: 2, height: 1, data: [0.25, 1, 2, Number.NaN] }],
        extents: rayExtents
      },
      {
        layers: [{ width: 1, height: 1, data: [0.75, 0, 0, 0] }],
        extents: []
      },
      {
        layers: [{ width: 1, height: 1, data: [0.75, 0, 0, 0] }],
        extents: [{ width: 2, height: 1, data: [0.75, 0.75] }]
      },
      {
        layers: [{ width: 1, height: 1, data: [1, 0, 0, 0] }],
        extents: [{ width: 1, height: 1, data: [0.75] }]
      },
      {
        layers: [{ width: 1, height: 1, data: [0.75, 0.0005, 0, 0] }],
        extents: [{ width: 1, height: 1, data: [0.75] }]
      },
      {
        layers: [{ width: 1, height: 1, data: [0.75, 0, 0.0005, 0] }],
        extents: [{ width: 1, height: 1, data: [0.75] }]
      },
      {
        layers: [{ width: 1, height: 1, data: [0.75, 0, 0, 0.0005] }],
        extents: [{ width: 1, height: 1, data: [0.75] }]
      },
      {
        layers: [{ width: 2, height: 1, data: [0.25, 1, 0, 3, 0.75, 0, 0, 0] }],
        extents: rayExtents
      },
      {
        layers: [{ width: 2, height: 1, data: [0.25, 1, 2, 3, 0.75, 0, 0, 0] }],
        extents: [{ width: 2, height: 1, data: [0.25, Number.NaN] }]
      },
      {
        layers: [{ width: 2, height: 1, data: [1.5, 1, 2, 3, 0.75, 0, 0, 0] }],
        extents: rayExtents
      }
    ]

    for (const { layers, extents } of broken) {
      expect(
        atlasContractPasses(
          evaluateAtlasContract(layers, witness(extents), 1, 1)
        )
      ).toBe(false)
    }
    expect(
      atlasContractPasses(
        evaluateAtlasContract(valid, witness(rayExtents), 2, 1)
      )
    ).toBe(false)
    const result = evaluateAtlasContract(valid, witness(rayExtents), 1, 1)
    expect(result).toMatchObject({
      rayExtentFieldValid: true,
      noSampleRayExtentRoundedDifferences: 0,
      noSampleRayExtentOutOfTolerance: 0,
      maxNoSampleRayExtentUlpDistance: 0,
      maxNoSampleRayExtentError: 0
    })
    expect(atlasContractPasses(result)).toBe(true)
  })

  it('accepts one fp16 code of ray-extent drift and rejects two at allowance 1', () => {
    const extent = [{ width: 2, height: 1, data: [0.25, 0.75] }]
    const oneUlp = evaluateAtlasContract(
      [
        {
          width: 2,
          height: 1,
          data: [0.25, 1, 2, 3, 0.75048828125, 0, 0, 0]
        }
      ],
      witness(extent),
      1,
      1
    )
    const twoUlps = evaluateAtlasContract(
      [
        {
          width: 2,
          height: 1,
          data: [0.25, 1, 2, 3, 0.7509765625, 0, 0, 0]
        }
      ],
      witness(extent),
      1,
      1
    )

    expect(oneUlp).toMatchObject({
      noSampleRayExtentRoundedDifferences: 1,
      noSampleRayExtentOutOfTolerance: 0,
      maxNoSampleRayExtentUlpDistance: 1,
      maxNoSampleRayExtentError: 0.00048828125,
      noSampleRayExtentWithinF32Resolution: true,
      noSampleZeroChannelsExact: true
    })
    expect(atlasContractPasses(oneUlp)).toBe(true)
    expect(twoUlps).toMatchObject({
      noSampleRayExtentOutOfTolerance: 1,
      maxNoSampleRayExtentUlpDistance: 2,
      maxNoSampleRayExtentError: 0.0009765625,
      noSampleRayExtentWithinF32Resolution: false,
      noSampleZeroChannelsExact: true
    })
    expect(atlasContractPasses(twoUlps)).toBe(false)
  })

  it('reads the bar off the twin, so a thin-shell drift in allowance passes and out fails', () => {
    // The 6 codes hardware disagreed by on a razor-thin shell. At the twin's
    // allowance there it is rounding, at a well-conditioned texel's 1 code the
    // same pair is a different value
    const extent = [
      { width: 2, height: 1, data: [0.25, 0.0001163482666015625] }
    ]
    const sixCodesApart = [
      {
        width: 2,
        height: 1,
        data: [0.25, 1, 2, 3, 0.00011599063873291016, 0, 0, 0]
      }
    ]

    const thinShell = evaluateAtlasContract(
      sixCodesApart,
      witness(extent, 199),
      1,
      1
    )
    expect(thinShell).toMatchObject({
      frontDepthWithinRange: true,
      noSampleRayExtentOutOfTolerance: 0,
      maxNoSampleRayExtentUlpDistance: 6,
      maxNoSampleRayExtentUlpAllowance: 199,
      noSampleRayExtentWithinF32Resolution: true
    })
    expect(atlasContractPasses(thinShell)).toBe(true)

    // Same pair of numbers, well-conditioned texel: out of tolerance
    expect(
      evaluateAtlasContract(sixCodesApart, witness(extent), 1, 1)
    ).toMatchObject({
      maxNoSampleRayExtentUlpDistance: 6,
      maxNoSampleRayExtentUlpAllowance: 1,
      noSampleRayExtentWithinF32Resolution: false
    })
    // And an absent or malformed allowance invalidates the field rather than
    // reading as a zero-width bar that everything fails
    for (const broken of [
      { extent, ulpAllowance: [] },
      {
        extent,
        ulpAllowance: [{ width: 3, height: 1, data: [1, 1] }]
      },
      {
        extent,
        ulpAllowance: [{ width: 2, height: 1, data: [1, Number.NaN] }]
      }
    ] satisfies ShadowRayExtents[]) {
      expect(
        evaluateAtlasContract(sixCodesApart, broken, 1, 1).rayExtentFieldValid,
        JSON.stringify(broken.ulpAllowance)
      ).toBe(false)
    }
  })

  it('bounds the front depth by the shadow fallback, not clouds.maxRayDistance', () => {
    // What a texel whose ray misses the inner shell writes: 1e6 m / 6360000 m,
    // fp16-quantised. clouds.maxRayDistance over the same bottomRadius is 0.0314
    // unit, a fifth of it
    const fallbackUnit = quantize(SHADOW_RAY_FAR_FALLBACK / 6360000)
    const layers = [
      {
        width: 2,
        height: 1,
        data: [fallbackUnit, 1, 2, 3, fallbackUnit, 0, 0, 0]
      }
    ]
    const extents = [
      { width: 2, height: 1, data: [fallbackUnit, fallbackUnit] }
    ]

    expect(
      evaluateAtlasContract(layers, witness(extents), 1, fallbackUnit)
    ).toMatchObject({
      frontDepthWithinRange: true,
      noSampleRayExtentRoundedDifferences: 0,
      noSampleRayExtentWithinF32Resolution: true
    })
    // The ceiling every earlier run used: the primary march's own cap
    expect(
      evaluateAtlasContract(layers, witness(extents), 1, 200000 / 6360000)
    ).toMatchObject({ frontDepthWithinRange: false })
    // And it still rejects a value past the shadow ceiling, per texel or not
    expect(
      evaluateAtlasContract(
        [
          {
            width: 2,
            height: 1,
            data: [fallbackUnit, 1, 2, 3, fallbackUnit * 2, 0, 0, 0]
          }
        ],
        witness(extents),
        1,
        fallbackUnit
      )
    ).toMatchObject({ frontDepthWithinRange: false })
  })

  it("accepts the shadow march's own negative extent, and only that value", () => {
    // 28 texels measured on hardware, whose cascade sun position sits outside
    // the outer shell so rayNear exceeds the 1e6 fallback and the extent the
    // march receives is negative. GPU and reconstruction agree to 0 ULP
    const negativeExtent = -1.0244140625
    const extent = [{ width: 2, height: 1, data: [0.25, negativeExtent] }]
    const matching = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0.25, 1, 2, 3, negativeExtent, 0, 0, 0] }],
      witness(extent),
      1,
      1
    )

    expect(matching).toMatchObject({
      frontDepthWithinRange: true,
      noSampleTexels: 1,
      noSampleRayExtentRoundedDifferences: 0,
      noSampleRayExtentOutOfTolerance: 0,
      maxNoSampleRayExtentUlpDistance: 0,
      noSampleRayExtentWithinF32Resolution: true
    })
    expect(atlasContractPasses(matching)).toBe(true)

    const arms = {
      // A sign flip: fp16 is sign-magnitude, so the codes are thousands apart
      flipped: -negativeExtent,
      // Two storage ULPs of magnitude away (the fp16 ULP here is 0.0009765625)
      twoUlps: negativeExtent - 0.001953125,
      // Positive, which the reference never writes for a negative extent
      positive: 0.25
    }
    for (const [name, value] of Object.entries(arms)) {
      const arm = evaluateAtlasContract(
        [
          {
            width: 2,
            height: 1,
            data: [0.25, 1, 2, 3, value, 0, 0, 0]
          }
        ],
        witness(extent),
        1,
        1
      )
      expect(arm, name).toMatchObject({
        noSampleRayExtentWithinF32Resolution: false
      })
      expect(atlasContractPasses(arm), name).toBe(false)
    }
    // All three also leave the per-texel interval, at the measured epsilon
    expect(
      evaluateAtlasContract(
        [
          {
            width: 2,
            height: 1,
            data: [0.25, 1, 2, 3, arms.flipped, 0, 0, 0]
          }
        ],
        witness(extent),
        1,
        1
      )
    ).toMatchObject({ frontDepthWithinRange: false })
  })

  it('code distance rejects a 2-code drift the range epsilon cannot see', () => {
    // The smallest extent hardware measured, layer 2 of the shadow-plane case
    // Its fp16 ULP is 9.5367e-7, two sit inside the 1e-3 range slack, and only
    // the code distance separates them
    const small = 0.001145362854003906
    const twoUlps = small + 2 ** -19
    const layers = (frontDepth: number) => [
      { width: 2, height: 1, data: [0.25, 1, 2, 3, frontDepth, 0, 0, 0] }
    ]
    const extents = [{ width: 2, height: 1, data: [0.25, small] }]

    const drifted = evaluateAtlasContract(
      layers(twoUlps),
      witness(extents),
      1,
      1
    )
    expect(drifted).toMatchObject({
      frontDepthWithinRange: true,
      noSampleRayExtentRoundedDifferences: 1,
      noSampleRayExtentOutOfTolerance: 1,
      maxNoSampleRayExtentUlpDistance: 2,
      noSampleRayExtentWithinF32Resolution: false
    })
    expect(atlasContractPasses(drifted)).toBe(false)
    expect(
      atlasContractPasses(
        evaluateAtlasContract(layers(small), witness(extents), 1, 1)
      )
    ).toBe(true)
  })

  it('rejects a sampler with no tail distinction before accepting 3 vs 2', () => {
    expect(samplerTailContractPasses({ inCloud: 2, ground: 2 })).toBe(false)
    expect(samplerTailContractPasses({ inCloud: 3, ground: 2 })).toBe(true)
  })

  it('drives each receiver and ratio arm red before accepting darkening', () => {
    expect(receiverMask([0, 0, 0, 1], [0, 0, 0, 1])).toEqual([])
    expect(receiverMask([1, 0, 0, 1], [0, 0, 0, 1])).toEqual([0])
    expect(receiverMaskWithControls([], [], [], [])).toEqual([])
    expect(
      receiverMaskWithControls(
        [1, 0, 0, 1],
        [1.001, 0, 0, 1],
        [1.002, 0, 0, 1],
        [1.003, 0, 0, 1]
      )
    ).toEqual([])
    expect(
      receiverMaskWithControls(
        [1, 0, 0, 1],
        [0.999, 0, 0, 1],
        [0, 0, 0, 1],
        [0.001, 0, 0, 1]
      )
    ).toEqual([0])
    expect(receiverMaskDomainPasses(0, 1_000, 1_000)).toBe(false)
    expect(receiverMaskDomainPasses(100, 0, 0)).toBe(false)
    expect(receiverMaskDomainPasses(100.5, 1_000, 1_000)).toBe(false)
    expect(receiverMaskDomainPasses(100, 1_000, 999)).toBe(false)
    expect(receiverMaskDomainPasses(891_846, 921_600, 921_600)).toBe(false)
    expect(receiverMaskDomainPasses(140, 921_600, 921_600)).toBe(true)

    const darkened: ReceiverShadowResult = {
      pixels: 64,
      shadedFraction: 0.5,
      shadowedMean: 0.7,
      unshadowedMean: 1,
      darkening: 0.3,
      ratio: 0.7
    }
    const broken = [
      { ...darkened, pixels: 63 },
      { ...darkened, shadedFraction: 0 },
      { ...darkened, darkening: 0 },
      { ...darkened, ratio: Number.NaN },
      { ...darkened, ratio: 0 },
      { ...darkened, ratio: 1 }
    ]

    for (const result of broken)
      expect(receiverShadowPasses(result)).toBe(false)
    expect(receiverShadowPasses(darkened)).toBe(true)
    expect(receiverRatiosAgree(darkened, { ...darkened, ratio: 0.9 })).toBe(
      false
    )
    expect(receiverRatiosAgree(darkened, { ...darkened, ratio: 0.735 })).toBe(
      true
    )
    expect(plainReceiverContractPasses(darkened, darkened)).toBe(false)
    expect(
      plainReceiverContractPasses(
        {
          ...darkened,
          pixels: 0,
          shadedFraction: 0,
          shadowedMean: 1,
          unshadowedMean: 1,
          darkening: 0,
          ratio: 1
        },
        darkened
      )
    ).toBe(false)
    expect(
      plainReceiverContractPasses(
        {
          ...darkened,
          shadedFraction: 0,
          shadowedMean: 1,
          unshadowedMean: 1,
          darkening: 0,
          ratio: 1
        },
        darkened
      )
    ).toBe(true)
  })

  it('drives every motion arm red before accepting aligned motion', () => {
    const reference = { dx: 4, dy: 2, score: 0.8 }
    expect(motionContractPasses(null, reference)).toBe(false)
    expect(motionContractPasses(reference, { ...reference, score: 0 })).toBe(
      false
    )
    expect(motionContractPasses(reference, { dx: 1, dy: 0, score: 0.8 })).toBe(
      false
    )
    expect(
      motionContractPasses(reference, { dx: -4, dy: -2, score: 0.8 })
    ).toBe(false)
    expect(motionContractPasses(reference, { dx: 6, dy: 3, score: 0.7 })).toBe(
      true
    )
  })

  it('drives each shafts arm red before accepting effects', () => {
    expect(shaftsEffectPasses([1, 1, 1, 1], [1, 1, 1, 1], 1e-4)).toBe(false)
    expect(shaftsEffectPasses([1, 1, 1, 1], [1], 1e-4)).toBe(false)
    expect(shaftsEffectPasses([0.5, 0.5, 0.5, 1], [1, 1, 1, 1], 1e-4)).toBe(
      true
    )
    expect(shaftsDarkeningPasses([1, 1, 1, 1], [0.5, 0.5, 0.5, 1], 1e-4)).toBe(
      false
    )
    expect(shaftsDarkeningPasses([0.5, 0.5, 0.5, 1], [1, 1, 1, 1], 1e-4)).toBe(
      true
    )
  })

  it('drives every knob, error, and target-leak arm red before round-trip', () => {
    const expected = {
      cascadeCount: 2,
      mapSize: [128, 128] as [number, number]
    }
    const valid = {
      expected,
      A: expected,
      B: expected,
      targetCounts: [8, 8, 8],
      errorCount: 0
    }
    const broken = [
      { ...valid, B: null },
      { ...valid, targetCounts: [8, 8] },
      { ...valid, A: { cascadeCount: 2 } },
      { ...valid, A: { ...expected, cascadeCount: 4 } },
      { ...valid, B: { ...expected, cascadeCount: 4 } },
      { ...valid, targetCounts: [0, 0, 0] },
      { ...valid, targetCounts: [8, 9, 8] },
      { ...valid, errorCount: 1 }
    ]

    for (const input of broken) {
      expect(shadowKnobContractPasses(input)).toBe(false)
    }
    expect(shadowKnobContractPasses(valid)).toBe(true)
  })

  it('drives every temporal arm red before accepting measured convergence', () => {
    const broken = [
      { earlyDelta: Number.NaN, lateDelta: 0 },
      { earlyDelta: 0.02, lateDelta: Number.NaN },
      // A skip frame under shadow.updateInterval > 1: the history did not
      // change at all between the two early reads
      { earlyDelta: 0, lateDelta: 0 },
      { earlyDelta: 0.02, lateDelta: -1e-4 },
      // No accumulation: consecutive frames differ by the same jitter noise
      { earlyDelta: 0.02, lateDelta: 0.02 },
      // Decays, but not two-fold
      { earlyDelta: 0.02, lateDelta: 0.011 }
    ]
    for (const result of broken) {
      expect(temporalContractPasses(result, 0.5)).toBe(false)
    }
    expect(
      temporalContractPasses({ earlyDelta: 0.02, lateDelta: 0.01 }, 0.5)
    ).toBe(true)
    // The reference's own decay under the e2e protocol (measured early
    // 83.753396, late 8.333591) passes the bound it replaced by 8,334x
    expect(
      temporalContractPasses(
        { earlyDelta: 83.753396, lateDelta: 8.333591 },
        0.5
      )
    ).toBe(true)
  })

  it('drives each layer-mask arm red before accepting complete suppression', () => {
    const extents = [{ width: 2, height: 1, data: [0.25, 0.75] }]
    const enabled = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0.25, 1, 2, 3, 0.75, 0, 0, 0] }],
      witness(extents),
      1,
      1
    )
    const disabled = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0.25, 0, 0, 0, 0.75, 0, 0, 0] }],
      witness(extents),
      1,
      1
    )
    const blank = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0, 0, 0, 0, 0, 0, 0, 0] }],
      witness(extents),
      1,
      1
    )
    const enabledWithoutFourChannels = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0.25, 1, 0, 0, 0.75, 0, 0, 0] }],
      witness(extents),
      1,
      1
    )
    const enabledWrongDepth = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0.25, 1, 2, 3, 0.75, 0, 0, 0] }],
      witness(extents),
      2,
      1
    )
    const disabledWrongDepth = evaluateAtlasContract(
      [{ width: 2, height: 1, data: [0.25, 0, 0, 0, 0.75, 0, 0, 0] }],
      witness(extents),
      2,
      1
    )

    expect(layerMaskContractPasses(disabled, disabled)).toBe(false)
    expect(layerMaskContractPasses(enabled, enabled)).toBe(false)
    expect(layerMaskContractPasses(enabled, blank)).toBe(false)
    expect(layerMaskContractPasses(enabled, disabledWrongDepth)).toBe(false)
    expect(layerMaskContractPasses(enabledWrongDepth, disabled)).toBe(false)
    expect(layerMaskContractPasses(enabled, disabled)).toBe(true)
    expect(layerMaskContractPasses(enabledWithoutFourChannels, disabled)).toBe(
      true
    )
  })

  it('drives every neutralisation arm red before accepting no work', () => {
    const valid = {
      disabledShadowDelta: 0,
      disabledShaftsDelta: 0,
      reenabledShadowDelta: 0.2,
      disabledFrameMs: 1,
      passes: { atlas: 0, march: 0, shadowLength: 0 },
      equalityTolerance: 1e-5,
      effectFloor: 1e-4
    }
    const broken = [
      { ...valid, disabledShadowDelta: 1e-3 },
      { ...valid, disabledShaftsDelta: 1e-3 },
      { ...valid, reenabledShadowDelta: 0 },
      { ...valid, reenabledShadowDelta: Number.POSITIVE_INFINITY },
      { ...valid, disabledFrameMs: null },
      { ...valid, disabledFrameMs: Number.NaN },
      { ...valid, passes: { ...valid.passes, atlas: 1 } },
      { ...valid, passes: { ...valid.passes, march: 1 } },
      { ...valid, passes: { ...valid.passes, shadowLength: 1 } }
    ]
    for (const input of broken) {
      expect(neutralisationContractPasses(input)).toBe(false)
    }
    expect(neutralisationContractPasses(valid)).toBe(true)
  })

  it('scores neutralisation against a complete measured control distribution', () => {
    const controls = {
      withinShadowOff: Array(10).fill(0.001),
      withinShadowOn: Array(10).fill(0.002)
    }
    const complete = { ...controls, crossState: Array(10).fill(0.001) }
    for (const key of [
      'withinShadowOff',
      'withinShadowOn',
      'crossState'
    ] as const) {
      expect(
        neutralisationFloorVerdict({ ...complete, [key]: Array(9).fill(0.001) })
      ).toBe('invalid')
      expect(
        neutralisationFloorVerdict({
          ...complete,
          [key]: [...Array(9).fill(0.001), Number.NaN]
        })
      ).toBe('invalid')
      expect(
        neutralisationFloorVerdict({
          ...complete,
          [key]: [...Array(9).fill(0.001), -0.001]
        })
      ).toBe('invalid')
    }
    expect(
      neutralisationFloorVerdict({
        ...controls,
        crossState: Array(10).fill(0.0015)
      })
    ).toBe('neutralised')
    expect(
      neutralisationFloorVerdict({
        ...controls,
        crossState: Array(10).fill(0.003)
      })
    ).toBe('real-difference')
    expect(
      neutralisationFloorVerdict({
        ...controls,
        crossState: [0.001, ...Array(9).fill(0.003)]
      })
    ).toBe('inconclusive')

    expect(deltasWithinMeasuredFloor([], 0.002)).toBe(false)
    expect(deltasWithinMeasuredFloor([0.001], Number.NaN)).toBe(false)
    expect(deltasWithinMeasuredFloor([0.001], -0.001)).toBe(false)
    expect(deltasWithinMeasuredFloor([Number.NaN], 0.002)).toBe(false)
    expect(deltasWithinMeasuredFloor([-0.001], 0.002)).toBe(false)
    expect(deltasWithinMeasuredFloor([0.001, 0.0021], 0.002)).toBe(false)
    expect(deltasWithinMeasuredFloor([0.001, 0.002], 0.002)).toBe(true)
  })
})

// e2e 18's contract, on synthetic readbacks built from the real
// inside-deck ground distances, so each failure mode the e2e must catch is
// shown to fail here
describe('shadow-length surface-end contract', () => {
  const W = 1280
  const H = 720
  const KM = 1e-3
  const samples = groundDistances(
    caseByName('shafts-inside-deck')!.pose,
    W,
    H,
    40
  ).map(s => ({ ...s, distance: s.distance == null ? null : s.distance * KM }))
  const tolerance = { relative: 0.01, absolute: 0.01 }

  function readback(encode: (d: number | null, i: number) => [number, number]) {
    const data = new Float32Array(W * H * 4)
    samples.forEach(({ col, row, distance }, i) => {
      const [x, y] = encode(distance, i)
      data[(row * W + col) * 4] = x
      data[(row * W + col) * 4 + 1] = y
    })
    return { width: W, height: H, data }
  }
  // Shadow on every other sampled pixel, a quarter of the ray, as a shaft does
  const partial = (d: number, i: number) => (i % 2 === 0 ? d * 0.25 : 0)

  it('the inside-deck frame is all ground, 5-21 km away', () => {
    const d = samples.map(s => s.distance)
    expect(d.every(v => v != null)).toBe(true)
    const km = d as number[]
    expect(Math.min(...km)).toBeGreaterThan(5)
    expect(Math.max(...km)).toBeLessThan(21)
  })

  it('passes the surface-end encoding (x + y = D)', () => {
    const r = evaluateShadowLengthSurfaceEnd(
      readback((d, i) => {
        const x = partial(d!, i)
        return [x, d! - x]
      }),
      samples,
      0.1,
      tolerance
    )
    log('surface-end-new', { ...r })
    expect(shadowLengthSurfaceEndPasses(r)).toBe(true)
  })

  it('fails the old camera-end encoding (y = near)', () => {
    const r = evaluateShadowLengthSurfaceEnd(
      readback((d, i) => [partial(d!, i), 0.1]),
      samples,
      0.1,
      tolerance
    )
    log('surface-end-old', { violations: r.violations })
    expect(r.violations).toBeGreaterThan(0)
    expect(shadowLengthSurfaceEndPasses(r)).toBe(false)
  })

  it('fails a sky pixel whose shadow does not start at the camera', () => {
    const sky = [...samples, { col: 1, row: 1, distance: null }]
    const data = readback((d, i) => {
      const x = partial(d!, i)
      return [x, d! - x]
    })
    data.data[(1 * W + 1) * 4 + 1] = 0.1
    const r = evaluateShadowLengthSurfaceEnd(data, sky, 0.1, tolerance)
    expect(r.skyPixels).toBe(1)
    expect(shadowLengthSurfaceEndPasses(r)).toBe(false)
  })

  it('refuses a frame with no shadow, and one that cannot tell old from new', () => {
    const none = evaluateShadowLengthSurfaceEnd(
      readback(d => [0, d!]),
      samples,
      0.1,
      tolerance
    )
    expect(none.shadowedPixels).toBe(0)
    expect(shadowLengthSurfaceEndPasses(none)).toBe(false)
    // Every ray shadowed from the near bound on: both encodings give x + y = D
    const full = evaluateShadowLengthSurfaceEnd(
      readback(d => [d! - 0.1, 0.1]),
      samples,
      0.1,
      tolerance
    )
    expect(full.discriminating).toBe(0)
    expect(shadowLengthSurfaceEndPasses(full)).toBe(false)
  })
})
