import { DensityProfile } from './DensityProfile'

describe('DensityProfile', () => {
  test('default profile density at h = 0, 0.5, 1', () => {
    const p = new DensityProfile(0, 0, 0.75, 0.25)
    const density = (h: number) =>
      p.expTerm * Math.exp(p.exponent * h) + p.linearTerm * h + p.constantTerm
    expect(density(0)).toBeCloseTo(0.25)
    expect(density(0.5)).toBeCloseTo(0.625)
    expect(density(1)).toBeCloseTo(1.0)
  })

  test('clone produces independent copy', () => {
    const a = new DensityProfile(1, 2, 3, 4)
    const b = a.clone()
    b.expTerm = 99
    expect(a.expTerm).toBe(1)
    expect(b.expTerm).toBe(99)
  })

  test('copy overwrites fields', () => {
    const a = new DensityProfile(1, 2, 3, 4)
    const b = new DensityProfile()
    b.copy(a)
    expect(b.expTerm).toBe(1)
    expect(b.exponent).toBe(2)
    expect(b.linearTerm).toBe(3)
    expect(b.constantTerm).toBe(4)
  })

  test('set resets fields', () => {
    const p = new DensityProfile(1, 2, 3, 4)
    p.set(10, 20, 30, 40)
    expect(p.expTerm).toBe(10)
    expect(p.exponent).toBe(20)
    expect(p.linearTerm).toBe(30)
    expect(p.constantTerm).toBe(40)
  })
})
