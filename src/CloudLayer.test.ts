import { CloudLayer } from './CloudLayer'
import { DensityProfile } from './DensityProfile'

describe('CloudLayer', () => {
  test('defaults match the spec', () => {
    const l = new CloudLayer()
    expect(l.channel).toBe('r')
    expect(l.altitude).toBe(0)
    expect(l.height).toBe(0)
    expect(l.densityScale).toBe(0.2)
    expect(l.shapeAmount).toBe(1)
    expect(l.shapeDetailAmount).toBe(1)
    expect(l.weatherExponent).toBe(1)
    expect(l.shapeAlteringBias).toBe(0.35)
    expect(l.coverageFilterWidth).toBe(0.6)
    expect(l.shadow).toBe(false)
    expect(l.densityProfile).toBeInstanceOf(DensityProfile)
    expect(l.densityProfile.linearTerm).toBe(0.75)
    expect(l.densityProfile.constantTerm).toBe(0.25)
  })

  test('clone produces independent copy', () => {
    const a = new CloudLayer({ altitude: 500, shadow: true })
    const b = a.clone()
    b.altitude = 999
    expect(a.altitude).toBe(500)
    expect(b.altitude).toBe(999)
    expect(b.shadow).toBe(true)
  })

  test('copy overwrites all fields', () => {
    const a = new CloudLayer({ channel: 'b', altitude: 7500, height: 500 })
    const b = new CloudLayer()
    b.copy(a)
    expect(b.channel).toBe('b')
    expect(b.altitude).toBe(7500)
    expect(b.height).toBe(500)
  })

  test('set applies partial options', () => {
    const l = new CloudLayer()
    l.set({ altitude: 1000, shadow: true })
    expect(l.altitude).toBe(1000)
    expect(l.shadow).toBe(true)
    expect(l.channel).toBe('r')
  })
})
