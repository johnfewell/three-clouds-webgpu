import { approximateMultipleScattering } from './multiScatter'
import { phaseFunction, phaseFunctionDefault } from './phaseFunction'

const G1 = 0.7
const G2 = -0.2
const MIX = 0.5

describe('approximateMultipleScattering', () => {
  test('1 octave equals exp(-od) * phase(cosTheta)', () => {
    const od = 2
    const cosTheta = 0.5
    const expected = Math.exp(-od) * phaseFunctionDefault(cosTheta, G1, G2, MIX)
    const actual = approximateMultipleScattering(od, cosTheta, 1, G1, G2, MIX)
    expect(actual).toBeCloseTo(expected, 12)
  })

  test('8 octaves at od=0: sum of 0.5^i * phase(cosTheta, 0.5^i)', () => {
    const cosTheta = 0.3
    let expected = 0
    for (let i = 0; i < 8; i++) {
      const attenA = Math.pow(0.5, i)
      const attenC = Math.pow(0.5, i)
      // exp(-0 * coeffB) = 1 for any coeffB
      expected += attenA * phaseFunction(cosTheta, attenC, G1, G2, MIX)
    }
    const actual = approximateMultipleScattering(0, cosTheta, 8, G1, G2, MIX)
    expect(actual).toBeCloseTo(expected, 12)
  })

  test('increasing octaves increases scattering (od > 0)', () => {
    const od = 1
    const cosTheta = 0
    const s1 = approximateMultipleScattering(od, cosTheta, 1, G1, G2, MIX)
    const s4 = approximateMultipleScattering(od, cosTheta, 4, G1, G2, MIX)
    const s8 = approximateMultipleScattering(od, cosTheta, 8, G1, G2, MIX)
    expect(s4).toBeGreaterThan(s1)
    expect(s8).toBeGreaterThan(s4)
  })

  test('scattering at od=0 is positive and finite', () => {
    const val = approximateMultipleScattering(0, 1, 8, G1, G2, MIX)
    expect(val).toBeGreaterThan(0)
    expect(Number.isFinite(val)).toBe(true)
  })

  test('CPU-twin octave table logged', () => {
    const od = 1.5
    const cosTheta = 0.5
    const rows: string[] = []
    let coeffA = 1
    let coeffB = 1
    let coeffC = 1
    let running = 0

    for (let i = 0; i < 8; i++) {
      const bl = Math.exp(-od * coeffB)
      const pf = phaseFunction(cosTheta, coeffC, G1, G2, MIX)
      const contrib = coeffA * bl * pf
      running += contrib
      rows.push(
        `octave ${i}: coeffs=(${coeffA.toFixed(4)}, ${coeffB.toFixed(4)}, ${coeffC.toFixed(4)}) ` +
          `bl=${bl.toFixed(6)} pf=${pf.toFixed(6)} contrib=${contrib.toFixed(8)} running=${running.toFixed(8)}`
      )
      coeffA *= 0.5
      coeffB *= 0.5
      coeffC *= 0.5
    }
    console.log(
      `Multi-scatter octave table (od=${od}, cosθ=${cosTheta}):\n` +
        rows.join('\n')
    )

    const actual = approximateMultipleScattering(od, cosTheta, 8, G1, G2, MIX)
    expect(actual).toBeCloseTo(running, 12)
  })
})
