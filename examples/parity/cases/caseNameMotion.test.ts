// a case named for a moving phenomenon must actually move. Shipped
// three times, each fix one case short (29 and 36, then 32, whose
// SSIM matched the static case to six decimals), so the guard is on the NAME
// Conversely `temporal-on-static` must have NO velocity: it is the control

import { describe, expect, it } from 'vitest'

import { cases, type CaseDefinition } from './index'

const VELOCITY_KEYS = [
  'localWeatherVelocity',
  'cameraVelocity',
  'sunVelocity'
] as const

/** Every velocity a case actually carries, wherever it is declared */
function velocitiesOf(c: CaseDefinition): string[] {
  const seq = (c as unknown as { sequence?: Record<string, unknown> }).sequence
  if (seq == null) return []
  const found: string[] = []
  const seqState = (seq.state ?? {}) as Record<string, unknown>
  for (const k of VELOCITY_KEYS) {
    if (k in seq || k in seqState) found.push(k)
  }
  return found
}

describe('a case named for motion must have it', () => {
  it("every case named 'wind' carries a localWeatherVelocity", () => {
    const named = cases.filter(c => c.name.includes('wind'))
    expect(
      named.length,
      'no wind-named cases found — selector is stale'
    ).toBeGreaterThan(0)

    const without = named
      .map(c => ({ name: c.name, vel: velocitiesOf(c) }))
      .filter(r => !r.vel.includes('localWeatherVelocity'))

    expect(
      without.map(r => r.name),
      'a case named for wind with no localWeatherVelocity renders sixteen ' +
        'copies of the still frame and scores as though it moved: ' +
        JSON.stringify(without)
    ).toEqual([])
  })

  it("every case named 'moving' carries at least one velocity", () => {
    const named = cases.filter(c => c.name.includes('moving'))
    expect(
      named.length,
      'no moving-named cases found — selector is stale'
    ).toBeGreaterThan(0)

    const without = named
      .filter(c => velocitiesOf(c).length === 0)
      .map(c => c.name)
    expect(
      without,
      `named for motion but carrying none: ${JSON.stringify(without)}`
    ).toEqual([])
  })

  // The converse. Protects the control from a sweep that "fixes" the family.
  it("every case named 'static' carries NO velocity", () => {
    const named = cases.filter(c => c.name.includes('static'))
    expect(
      named.length,
      'no static-named cases found — selector is stale'
    ).toBeGreaterThan(0)

    const withMotion = named
      .map(c => ({ name: c.name, vel: velocitiesOf(c) }))
      .filter(r => r.vel.length > 0)

    expect(
      withMotion.map(r => r.name),
      'a case named static is a CONTROL; giving it velocity destroys the only ' +
        'motionless member of its family: ' +
        JSON.stringify(withMotion)
    ).toEqual([])
  })

  // The pair the discriminator depends on: same motion, and the temporal
  // path the ONLY difference. If these diverge, that discriminator is measuring
  // two scenes rather than one variable
  it('wind and temporal-on-wind differ ONLY in temporalUpscale', () => {
    const wind = cases.find(c => c.name === 'wind')
    const tow = cases.find(c => c.name === 'temporal-on-wind')
    expect(wind, 'case wind missing').toBeDefined()
    expect(tow, 'case temporal-on-wind missing').toBeDefined()

    expect(velocitiesOf(tow!)).toEqual(velocitiesOf(wind!))
    expect(tow!.pose).toEqual(wind!.pose)
    expect(tow!.sun).toEqual(wind!.sun)

    const ws = (wind!.state ?? {}) as Record<string, unknown>
    const ts = (tow!.state ?? {}) as Record<string, unknown>
    expect(
      ts.temporalUpscale,
      'temporal-on-wind must enable temporalUpscale'
    ).toBe(true)
    expect(
      ws.temporalUpscale,
      'wind must NOT enable temporalUpscale'
    ).toBeUndefined()
  })
})
