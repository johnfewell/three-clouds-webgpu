import {
  accuratePhaseFunction,
  draine,
  henyeyGreenstein,
  phaseFunction,
  phaseFunctionDefault
} from './phaseFunction'

const RECIPROCAL_PI4 = 1 / (4 * Math.PI)

describe('phaseFunction', () => {
  test('HG with g=0 equals 1/(4pi) for any cosTheta (isotropic)', () => {
    for (const cosTheta of [-1, -0.5, 0, 0.5, 1]) {
      const [lobe1, lobe2] = henyeyGreenstein(0, 0, cosTheta)
      expect(lobe1).toBeCloseTo(RECIPROCAL_PI4, 10)
      expect(lobe2).toBeCloseTo(RECIPROCAL_PI4, 10)
    }
  })

  test('dual-lobe at defaults for cosTheta=1 matches hand-computed', () => {
    const g1 = 0.7
    const g2 = -0.2
    const cosTheta = 1
    // HG(g, 1) = 1/(4pi) * (1-g^2) / (1+g^2-2g)^1.5 = 1/(4pi) * (1-g^2)/(1-g)^3
    const expected1 = (RECIPROCAL_PI4 * (1 - g1 * g1)) / Math.pow(1 - g1, 3)
    const expected2 = (RECIPROCAL_PI4 * (1 - g2 * g2)) / Math.pow(1 - g2, 3)
    const [lobe1, lobe2] = henyeyGreenstein(g1, g2, cosTheta)
    expect(lobe1).toBeCloseTo(expected1, 10)
    expect(lobe2).toBeCloseTo(expected2, 10)
    console.log(
      `HG(g=${g1}, cosθ=1) = ${lobe1.toFixed(8)}, ` +
        `HG(g=${g2}, cosθ=1) = ${lobe2.toFixed(8)}`
    )
  })

  test('dual-lobe at defaults for cosTheta=-1 matches hand-computed', () => {
    const g1 = 0.7
    const g2 = -0.2
    const cosTheta = -1
    // HG(g, -1) = 1/(4pi) * (1-g^2) / (1+g)^3
    const expected1 = (RECIPROCAL_PI4 * (1 - g1 * g1)) / Math.pow(1 + g1, 3)
    const expected2 = (RECIPROCAL_PI4 * (1 - g2 * g2)) / Math.pow(1 + g2, 3)
    const [lobe1, lobe2] = henyeyGreenstein(g1, g2, cosTheta)
    expect(lobe1).toBeCloseTo(expected1, 10)
    expect(lobe2).toBeCloseTo(expected2, 10)
    console.log(
      `HG(g=${g1}, cosθ=-1) = ${lobe1.toFixed(8)}, ` +
        `HG(g=${g2}, cosθ=-1) = ${lobe2.toFixed(8)}`
    )
  })

  test('phaseFunction with default params at cosTheta=1', () => {
    const val = phaseFunctionDefault(1, 0.7, -0.2, 0.5)
    const [lobe1, lobe2] = henyeyGreenstein(0.7, -0.2, 1)
    const expected = lobe1 * 0.5 + lobe2 * 0.5
    expect(val).toBeCloseTo(expected, 10)
    console.log(`phaseFunction(cosθ=1, defaults) = ${val.toFixed(8)}`)
  })

  test('phaseFunction with attenuation < 1 reduces anisotropy', () => {
    const full = phaseFunction(1, 1, 0.7, -0.2, 0.5)
    const half = phaseFunction(1, 0.5, 0.7, -0.2, 0.5)
    const iso = phaseFunctionDefault(1, 0, 0, 0.5)
    expect(half).toBeLessThan(full)
    expect(half).toBeGreaterThan(iso)
  })

  test('CPU-twin diff table logged', () => {
    const cases = [
      { g1: 0, g2: 0, cosTheta: 0 },
      { g1: 0.7, g2: -0.2, cosTheta: 1 },
      { g1: 0.7, g2: -0.2, cosTheta: -1 },
      { g1: 0.7, g2: -0.2, cosTheta: 0 },
      { g1: 0.9, g2: -0.5, cosTheta: 0.5 }
    ]
    const rows = cases.map(({ g1, g2, cosTheta }) => {
      const [l1, l2] = henyeyGreenstein(g1, g2, cosTheta)
      return `g=(${g1},${g2}) cosθ=${cosTheta}: lobe1=${l1.toFixed(8)} lobe2=${l2.toFixed(8)}`
    })
    console.log('CPU-twin HG table:\n' + rows.join('\n'))
    expect(rows.length).toBe(5)
  })

  test('dual-lobe HG integrates to 1 over the sphere (±1%)', () => {
    const g1 = 0.7
    const g2 = -0.2
    const mix = 0.5
    const N = 10000
    let sum = 0
    for (let i = 0; i < N; i++) {
      const cosTheta = -1 + (2 * (i + 0.5)) / N
      const val = phaseFunctionDefault(cosTheta, g1, g2, mix)
      sum += val * (2 / N) * 2 * Math.PI
    }
    console.log(
      `Sphere integral of dual-lobe HG: ${sum.toFixed(6)} (expect ~1.0)`
    )
    expect(sum).toBeCloseTo(1, 1)
  })
})

describe('draine', () => {
  test('with g=0 and a=0 equals 1/(4pi) (isotropic)', () => {
    for (const u of [-1, 0, 0.5, 1]) {
      expect(draine(u, 0, 0)).toBeCloseTo(RECIPROCAL_PI4, 10)
    }
  })

  test('forward peak increases with positive g', () => {
    const forward = draine(1, 0.5, 1)
    const backward = draine(-1, 0.5, 1)
    expect(forward).toBeGreaterThan(backward)
  })

  test('alpha amplifies forward scattering', () => {
    const low = draine(1, 0.5, 1)
    const high = draine(1, 0.5, 20)
    expect(high).toBeGreaterThan(low)
  })
})

describe('accuratePhaseFunction', () => {
  test('integrates to ~1 over the sphere (±2%)', () => {
    const N = 200000
    let sum = 0
    for (let i = 0; i < N; i++) {
      const cosTheta = -1 + (2 * (i + 0.5)) / N
      sum += accuratePhaseFunction(cosTheta, 1) * (2 / N) * 2 * Math.PI
    }
    console.log(
      `Sphere integral of accurate phase: ${sum.toFixed(6)} (expect ~1.0)`
    )
    expect(Math.abs(sum - 1)).toBeLessThan(0.02)
  })

  test('has a strong forward peak (cosTheta=1 >> cosTheta=-1)', () => {
    const forward = accuratePhaseFunction(1, 1)
    const backward = accuratePhaseFunction(-1, 1)
    expect(forward).toBeGreaterThan(backward * 10)
  })

  test('attenuation < 1 reduces anisotropy', () => {
    const full = accuratePhaseFunction(1, 1)
    const half = accuratePhaseFunction(1, 0.5)
    expect(half).toBeLessThan(full)
  })

  test('differs from standard dual-lobe HG', () => {
    const accurate = accuratePhaseFunction(0.5, 1)
    const standard = phaseFunctionDefault(0.5, 0.7, -0.2, 0.5)
    expect(accurate).not.toBeCloseTo(standard, 3)
  })
})
