// the cloud mask behind cloudFraction was
// thrown away. The committed artifact's property is an IDENTITY: the binary
// channel reproduces computeCloudFraction exactly, or the two have drifted

import { describe, expect, it } from 'vitest'

import {
  buildCloudMaskRGBA,
  CLOUD_ALPHA_THRESHOLD,
  cloudMaskFraction,
  computeCloudFraction
} from './evaluate'

/** RGBA float layer from a list of alphas. Only channel 3 is read */
const layerOf = (alphas: number[]): Float32Array => {
  const out = new Float32Array(alphas.length * 4)
  alphas.forEach((a, i) => {
    out[i * 4] = 0.5
    out[i * 4 + 1] = 0.5
    out[i * 4 + 2] = 0.5
    out[i * 4 + 3] = a
  })
  return out
}

describe('committed cloud mask', () => {
  it('reproduces computeCloudFraction EXACTLY — no tolerance', () => {
    const cases: number[][] = [
      [],
      [0, 0, 0],
      [1, 1, 1],
      [0, 1, 0, 1],
      [0.005, 0.02, 0.5, 0.0001, 0.999],
      Array.from({ length: 997 }, (_, i) => (i % 7) / 6)
    ]
    for (const alphas of cases) {
      const layer = layerOf(alphas)
      expect(cloudMaskFraction(buildCloudMaskRGBA(layer, 4))).toBe(
        computeCloudFraction(layer, 4)
      )
    }
  })

  it('pins the comparison as STRICTLY GREATER at the exact threshold', () => {
    // A plain array, NOT a Float32Array: 0.01 as float32 is already below the
    // threshold, so a float32 fixture never reaches the boundary and a `>` vs
    // `>=` change slips through. This one caught that.
    const exact = [0, 0, 0, CLOUD_ALPHA_THRESHOLD]
    expect(buildCloudMaskRGBA(exact, 4)[0]).toBe(0)
    expect(cloudMaskFraction(buildCloudMaskRGBA(exact, 4))).toBe(
      computeCloudFraction(exact, 4)
    )
  })

  it('agrees at the threshold itself, where 8-bit rounding would not', () => {
    // 0.0099 and 0.0101 both quantise to 3/255 = 0.01176, so a mask carrying
    // ONLY quantised alpha would call both of them cloud. The binary channel is
    // why the identity survives here
    const layer = layerOf([0.0099, CLOUD_ALPHA_THRESHOLD, 0.0101])
    const mask = buildCloudMaskRGBA(layer, 4)
    expect(cloudMaskFraction(mask)).toBe(computeCloudFraction(layer, 4))
    // strictly greater
    expect([mask[0], mask[4], mask[8]]).toEqual([0, 0, 255])
    // …while the quantised channel cannot tell them apart
    expect(mask[1]).toBe(mask[5])
    expect(mask[5]).toBe(mask[9])
  })

  it('carries the veil in the quantised channel', () => {
    const mask = buildCloudMaskRGBA(layerOf([0, 0.25, 0.5, 1]), 4)
    expect([mask[1], mask[5], mask[9], mask[13]]).toEqual([0, 64, 128, 255])
  })

  it('is opaque and uses no third channel', () => {
    const mask = buildCloudMaskRGBA(layerOf([0.3, 0.7]), 4)
    expect([mask[2], mask[6]]).toEqual([0, 0])
    expect([mask[3], mask[7]]).toEqual([255, 255])
  })
})
