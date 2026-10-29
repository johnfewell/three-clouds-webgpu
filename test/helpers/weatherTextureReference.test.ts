import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from './log'
import type { Vec3 } from './tileableNoiseReference'
import {
  curlReference,
  localWeatherLowRawReference,
  localWeatherReference,
  localWeatherWorleyFbmReference,
  perlin3dReference,
  rawCurl,
  turbulenceReference
} from './weatherTextureReference'

describe('turbulence', () => {
  setCurrentSpec('turbulence-reference')

  test('the three Perlin components are decorrelated', () => {
    // Without the swizzles or offsets all three would be the same field, making
    // the vector field a gradient with zero curl: a uniform grey turbulence
    // texture, and nothing downstream would error
    for (const p of [
      [0.1, 0.2, 0.3],
      [0.6, 0.4, 0.8]
    ] as Vec3[]) {
      const [a, b, c] = perlin3dReference(p)
      expect(Math.abs(a - b)).toBeGreaterThan(1e-6)
      expect(Math.abs(b - c)).toBeGreaterThan(1e-6)
      expect(Math.abs(a - c)).toBeGreaterThan(1e-6)
    }
  })

  test('curl is a unit vector', () => {
    for (let i = 0; i < 40; i++) {
      const p: Vec3 = [i * 0.023, i * 0.041, i * 0.017]
      const c = curlReference(p)
      expect(Math.hypot(c[0], c[1], c[2])).toBeCloseTo(1, 9)
    }
  })

  test('the component wiring recovers a known analytic curl', () => {
    // Not checkable on the noise itself (delta 0.1 spans a whole period at
    // frequency 12). On a LINEAR field central differences are exact, so the
    // discrete curl must equal the analytic one: that isolates the wiring
    const cases: Array<{ f: (p: Vec3) => Vec3; curl: Vec3; name: string }> = [
      // F = (-y, x, 0)  ->  curl = (0, 0, 2)
      { name: 'rotation about z', f: p => [-p[1], p[0], 0], curl: [0, 0, 2] },
      // F = (0, -z, y)  ->  curl = (2, 0, 0)
      { name: 'rotation about x', f: p => [0, -p[2], p[1]], curl: [2, 0, 0] },
      // F = (z, 0, -x)  ->  curl = (0, 2, 0)
      { name: 'rotation about y', f: p => [p[2], 0, -p[0]], curl: [0, 2, 0] },
      // A gradient field has zero curl: F = (x, y, z)
      { name: 'gradient', f: p => [p[0], p[1], p[2]], curl: [0, 0, 0] }
    ]

    for (const { f, curl, name } of cases) {
      const got = rawCurl(f, [0.3, 0.7, 0.2])
      for (let i = 0; i < 3; i++) {
        expect(got[i], `${name} component ${i}`).toBeCloseTo(curl[i]!, 9)
      }
    }

    log(
      'curl-analytic',
      cases.map(c => ({
        field: c.name,
        expected: `[${c.curl.join(', ')}]`,
        actual: rawCurl(c.f, [0.3, 0.7, 0.2])
          .map(n => +n.toFixed(6))
          .join(', ')
      }))
    )
  })

  test('turbulence packs into [0, 1]', () => {
    for (let i = 0; i < 60; i++) {
      const v = turbulenceReference([(i * 0.013) % 1, (i * 0.029) % 1])
      for (const c of v) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('localWeather', () => {
  setCurrentSpec('local-weather-reference')

  test('every channel is in [0, 1] and alpha is exactly 1', () => {
    for (let i = 0; i < 200; i++) {
      const w = localWeatherReference([(i * 0.011) % 1, (i * 0.027) % 1])
      for (const c of [w.r, w.g, w.b]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
      // Faithful: the reference overwrites the "Extra" Perlin with 1.0 on the
      // line after computing it (localWeather.frag:77-82)
      expect(w.a).toBe(1)
    }
  })

  test('red is exactly clamp(lowRaw - green, 0, 1)', () => {
    // Red subtracts green, which stops low and mid stacking into a deck
    // Asserted as an identity: mid never saturates here (max 0.948), so a
    // "where mid saturates" check would pass vacuously
    for (let i = 0; i < 400; i++) {
      const uv: [number, number] = [(i * 0.0023) % 1, (i * 0.0041) % 1]
      const w = localWeatherReference(uv)
      const expected = Math.min(
        1,
        Math.max(0, localWeatherLowRawReference(uv) - w.g)
      )
      expect(w.r).toBeCloseTo(expected, 12)
    }
  })

  test('green is computed before red, so red can subtract it', () => {
    // Somewhere red must actually be clipped by the subtraction, or the
    // identity above would hold trivially for an unrelated reason
    let sawClipped = false
    for (let i = 0; i < 2000; i++) {
      const uv: [number, number] = [(i * 0.0011) % 1, (i * 0.0019) % 1]
      const w = localWeatherReference(uv)
      if (localWeatherLowRawReference(uv) > w.r + 1e-6) sawClipped = true
    }
    expect(sawClipped, 'the subtraction must bite somewhere').toBe(true)
  })

  test('the octave sum grows with octave count and is unbounded', () => {
    // Deliberately not clamped: the caller's smoothstep does the ranging, so a
    // clamp here would flatten the high end of both cloud channels
    const p: Vec3 = [0.3, 0.6, 0]
    const one = localWeatherWorleyFbmReference(p, 8, 0.4, 2, 0.95, 1)
    const four = localWeatherWorleyFbmReference(p, 8, 0.4, 2, 0.95, 4)
    expect(four).toBeGreaterThan(one)
    log('weather-fbm-octaves', [
      { field: '1 octave', expected: '<', actual: +one.toFixed(6) },
      { field: '4 octaves', expected: '>', actual: +four.toFixed(6) }
    ])
  })

  test('fixed points are stable', () => {
    const uvs: Array<[number, number]> = [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.83, 0.17]
    ]
    expect(
      uvs.map(uv => {
        const w = localWeatherReference(uv)
        return {
          r: +w.r.toFixed(8),
          g: +w.g.toFixed(8),
          b: +w.b.toFixed(8),
          a: w.a
        }
      })
    ).toMatchSnapshot()
  })
})
