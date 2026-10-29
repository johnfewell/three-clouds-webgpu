import { describe, expect, test } from 'vitest'

import { approximateRadianceFromGroundCPU } from './secondaryGroundMarch'

describe('approximateRadianceFromGroundCPU', () => {
  test('zero optical depth passes full bounced radiance', () => {
    const sun: [number, number, number] = [1, 1, 1]
    const sky: [number, number, number] = [0.2, 0.2, 0.2]
    const coverage = 0.3
    const result = approximateRadianceFromGroundCPU(0, sun, sky, coverage)

    const groundAlbedo = 0.3
    const recipPi = 1 / Math.PI
    const groundIrr = 0.2 + (1 - 0.3) * 1
    const expected = groundIrr * groundAlbedo * recipPi

    for (const c of result) {
      expect(c).toBeCloseTo(expected, 10)
    }
  })

  test('large optical depth attenuates radiance toward zero', () => {
    const sun: [number, number, number] = [1, 1, 1]
    const sky: [number, number, number] = [0.2, 0.2, 0.2]
    const result = approximateRadianceFromGroundCPU(10, sun, sky, 0.3)

    for (const c of result) {
      expect(c).toBeLessThan(1e-3)
      expect(c).toBeGreaterThan(0)
    }
  })

  test('full coverage zeroes direct sun contribution', () => {
    const sun: [number, number, number] = [5, 5, 5]
    const sky: [number, number, number] = [0.1, 0.1, 0.1]
    const fullCoverage = approximateRadianceFromGroundCPU(0, sun, sky, 1.0)
    const noCoverage = approximateRadianceFromGroundCPU(0, sun, sky, 0.0)

    expect(fullCoverage[0]).toBeLessThan(noCoverage[0])

    const groundAlbedo = 0.3
    const recipPi = 1 / Math.PI
    const expectedFull = 0.1 * groundAlbedo * recipPi
    expect(fullCoverage[0]).toBeCloseTo(expectedFull, 10)
  })

  test('channels are independent', () => {
    const sun: [number, number, number] = [1, 0.5, 0.25]
    const sky: [number, number, number] = [0.1, 0.2, 0.3]
    const result = approximateRadianceFromGroundCPU(1, sun, sky, 0.5)

    expect(result[0]).not.toBeCloseTo(result[1], 5)
    expect(result[1]).not.toBeCloseTo(result[2], 5)
  })
})
