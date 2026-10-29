// The sun sync, tested as arithmetic rather than as pixels: unit length, the
// real shape of the sun's day at a real place, longitude conversion, and the
// sinks actually receiving what they were handed. Nothing here touches the
// GPU, and the off-proof that the render is untouched is in
// defaultOutputDigest.test.ts

import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import {
  celestialVector,
  computeCelestialDirections,
  resolveTimeOfDay,
  syncCelestialDirections,
  type CelestialSink
} from './timeOfDay'

// Greenwich, on the equator: longitude 0 makes the local-solar arithmetic the
// identity, so a failure there is the maths rather than the timezone
const GREENWICH = { longitude: 0, latitude: 0, height: 0 }

// A date a few weeks off an equinox, so a solar day is not accidentally
// symmetric about noon for a mid-latitude observer
const DATE = new Date('2026-10-04T12:00:00Z')

// Somewhere the sun actually sets and rises, which is the only latitude where
// "low sun" and "below the horizon" mean anything
const MID_LATITUDE = { longitude: 0, latitude: 45, height: 0 }

const DEG = Math.PI / 180

/** Degrees above the observer's horizon, from an ECEF direction */
function elevationAt(
  location: { longitude: number; latitude: number },
  direction: Vector3
) {
  // ECEF z is the polar axis, so local up is (cos(lat)cos(lon), cos(lat)sin(lon), sin(lat))
  const up = new Vector3(
    Math.cos(location.latitude * DEG) * Math.cos(location.longitude * DEG),
    Math.cos(location.latitude * DEG) * Math.sin(location.longitude * DEG),
    Math.sin(location.latitude * DEG)
  )
  return Math.asin(direction.clone().normalize().dot(up)) / DEG
}

describe('celestial directions', () => {
  it('are unit vectors in ECEF, and the two bodies are not the same direction', () => {
    const directions = computeCelestialDirections(DATE, MID_LATITUDE)
    const separation =
      directions.sunDirection.angleTo(directions.moonDirection) / DEG
    table('celestial-unit', [
      {
        field: 'sun length',
        expected: '1.000000',
        actual: directions.sunDirection.length().toFixed(6)
      },
      {
        field: 'moon length',
        expected: '1.000000',
        actual: directions.moonDirection.length().toFixed(6)
      },
      {
        field: 'sun-moon separation deg',
        expected: '> 5, two different bodies',
        actual: separation.toFixed(2)
      }
    ])
    expect(directions.sunDirection.length()).toBeCloseTo(1, 6)
    expect(directions.moonDirection.length()).toBeCloseTo(1, 6)
    expect(separation).toBeGreaterThan(5)
  })

  // The strongest shape claim available without an ephemeris: the sun is above
  // the horizon at solar noon and below it half a day later. A sign error in ECEF
  // or an hour-angle error inverts both
  it('put the sun up at solar noon and down at solar midnight, at 45 north', () => {
    const noon = computeCelestialDirections(
      resolveTimeOfDay(DATE, 0.5, MID_LATITUDE),
      MID_LATITUDE
    )
    const midnight = computeCelestialDirections(
      resolveTimeOfDay(DATE, 0, MID_LATITUDE),
      MID_LATITUDE
    )
    const noonElevation = elevationAt(MID_LATITUDE, noon.sunDirection)
    const midnightElevation = elevationAt(MID_LATITUDE, midnight.sunDirection)
    table('celestial-day', [
      {
        field: 'elevation at solar noon deg',
        expected: 'in (0, 90)',
        actual: noonElevation.toFixed(2)
      },
      {
        field: 'elevation at solar midnight deg',
        expected: 'in (-90, 0)',
        actual: midnightElevation.toFixed(2)
      }
    ])
    expect(noonElevation).toBeGreaterThan(0)
    expect(noonElevation).toBeLessThan(90)
    expect(midnightElevation).toBeLessThan(0)
    expect(midnightElevation).toBeGreaterThan(-90)
    // Solar noon at 45 north in early October is 90 - latitude + declination,
    // and the declination is near -7, so this is a real number and not a bound
    expect(noonElevation).toBeGreaterThan(36)
    expect(noonElevation).toBeLessThan(42)
  })

  // A scene at solar noon sees the sun toward the equator, so its ECEF x is
  // positive and its polar z is negative. This is the axis claim: an ECEF
  // vector that is not sun-side-of-the-equator has the axes permuted
  it('point the noon sun south of the equator and up the +x axis', () => {
    const { sunDirection } = computeCelestialDirections(
      resolveTimeOfDay(DATE, 0.5, MID_LATITUDE),
      MID_LATITUDE
    )
    table('celestial-axes', [
      {
        field: 'sun x (toward 0 lon on the equator)',
        expected: '> 0.5',
        actual: sunDirection.x.toFixed(3)
      },
      {
        field: 'sun y (toward 90 lon on the equator)',
        expected: 'about 0',
        actual: sunDirection.y.toFixed(3)
      },
      {
        field: 'sun z (north pole)',
        expected: '< 0, the sun is south of the equator',
        actual: sunDirection.z.toFixed(3)
      }
    ])
    expect(sunDirection.x).toBeGreaterThan(0.5)
    expect(Math.abs(sunDirection.y)).toBeLessThan(0.05)
    expect(sunDirection.z).toBeLessThan(0)
  })

  // The observer reaches the topocentric read, and the only body it moves is the
  // moon: at about one degree of parallax per Earth radius, 8 km of altitude is
  // a few arcseconds for the moon and a millionth of that for the sun
  it('moves the moon with the observer position, and leaves the sun alone', () => {
    const ground = computeCelestialDirections(DATE, MID_LATITUDE)
    const high = computeCelestialDirections(DATE, {
      ...MID_LATITUDE,
      height: 8000
    })
    const moonShift = ground.moonDirection.angleTo(high.moonDirection) / DEG
    const sunShift = ground.sunDirection.angleTo(high.sunDirection) / DEG
    table('celestial-observer', [
      {
        field: 'moon shift over 8 km of altitude, arcsec',
        expected: '> 1, about 1e-3 deg per 6371 km',
        actual: (moonShift * 3600).toFixed(3)
      },
      {
        field: 'sun shift over the same 8 km, arcsec',
        expected: '< 0.05, the sun is a million light-minutes away',
        actual: (sunShift * 3600).toFixed(5)
      }
    ])
    expect(moonShift).toBeGreaterThan(1 / 3600)
    expect(sunShift).toBeGreaterThan(0)
    expect(sunShift).toBeLessThan(0.05 / 3600)
  })
})

describe('resolveTimeOfDay', () => {
  it('is the identity in solar time on the prime meridian', () => {
    const rows = [0, 0.25, 0.5, 0.75].map(timeOfDay => {
      const date = resolveTimeOfDay(DATE, timeOfDay, GREENWICH)
      return {
        field: `timeOfDay ${timeOfDay}`,
        expected: `${(timeOfDay * 24).toFixed(0)}:00 UTC`,
        actual: `${date.getUTCHours()}:00 UTC`
      }
    })
    table('solar-prime-meridian', rows)
    for (const timeOfDay of [0, 0.25, 0.5, 0.75]) {
      expect(resolveTimeOfDay(DATE, timeOfDay, GREENWICH).getTime()).toBe(
        Date.UTC(2026, 9, 4, timeOfDay * 24)
      )
    }
  })

  // 15 degrees an hour, so 90 east is six hours ahead and the same local solar
  // noon is 06:00 UTC there. Getting this backwards is silent, so it is asserted
  // as a number, and the offset wraps into [0, 24) rather than spilling over
  it('shifts by longitude at 15 degrees an hour, wrapping rather than spilling', () => {
    const east = resolveTimeOfDay(DATE, 0.5, { longitude: 90, latitude: 0 })
    const west = resolveTimeOfDay(DATE, 0.5, { longitude: -90, latitude: 0 })
    const dateline = resolveTimeOfDay(DATE, 0.5, {
      longitude: 180,
      latitude: 0
    })
    const wrapped = resolveTimeOfDay(DATE, 0.1, { longitude: 180, latitude: 0 })
    table('solar-longitude', [
      {
        field: 'solar noon at 90E',
        expected: '06:00 UTC on 2026-10-04',
        actual: east.toISOString()
      },
      {
        field: 'solar noon at 90W',
        expected: '18:00 UTC on 2026-10-04',
        actual: west.toISOString()
      },
      {
        field: 'solar noon at 180E',
        expected: '00:00 UTC on 2026-10-04',
        actual: dateline.toISOString()
      },
      {
        field: 'solar 02:24 at 180E wraps to',
        expected: '14:24 UTC on 2026-10-04',
        actual: wrapped.toISOString()
      }
    ])
    expect(east.toISOString()).toBe('2026-10-04T06:00:00.000Z')
    expect(west.toISOString()).toBe('2026-10-04T18:00:00.000Z')
    expect(dateline.toISOString()).toBe('2026-10-04T00:00:00.000Z')
    expect(wrapped.toISOString()).toBe('2026-10-04T14:24:00.000Z')
  })

  it('ignores the time of day the date was written in', () => {
    // 22:30 local reads as 22:30 UTC on the Date, which is a different instant
    // from solar midnight. Only the DATE part is an input
    const date = new Date('2026-10-04T22:30:00Z')
    expect(resolveTimeOfDay(date, 0, GREENWICH).toISOString()).toBe(
      '2026-10-04T00:00:00.000Z'
    )
  })

  it('refuses a fraction outside [0, 1) rather than wrapping it', () => {
    const rows: Array<Record<string, unknown>> = []
    for (const bad of [-0.1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let error = 'none'
      try {
        resolveTimeOfDay(DATE, bad, GREENWICH)
      } catch (e) {
        error = e instanceof RangeError ? 'RangeError' : 'wrong error type'
      }
      rows.push({
        field: `timeOfDay ${bad}`,
        expected: 'RangeError',
        actual: error
      })
    }
    table('solar-range', rows)
    expect(() => resolveTimeOfDay(DATE, 1, GREENWICH)).toThrow(RangeError)
    expect(() => resolveTimeOfDay(DATE, -0.1, GREENWICH)).toThrow(RangeError)
    expect(() => resolveTimeOfDay(DATE, Number.NaN, GREENWICH)).toThrow(
      RangeError
    )
  })
})

describe('syncCelestialDirections', () => {
  it('writes one sun into every sink shape a consumer actually holds', () => {
    const plain = new Vector3()
    const uniformLike = { value: new Vector3() }
    const atmosphereLike = {
      sunDirection: { value: new Vector3() },
      moonDirection: { value: new Vector3() }
    }
    const sinks = [
      { sunDirection: plain },
      { sunDirection: uniformLike },
      atmosphereLike
    ] satisfies CelestialSink[]
    const directions = syncCelestialDirections(sinks, {
      date: DATE,
      location: MID_LATITUDE
    })
    table('sync-sinks', [
      {
        field: 'plain Vector3 sink',
        expected: directions.sunDirection
          .toArray()
          .map(n => n.toFixed(4))
          .join(),
        actual: plain
          .toArray()
          .map(n => n.toFixed(4))
          .join()
      },
      {
        field: 'uniform .value sink',
        expected: directions.sunDirection
          .toArray()
          .map(n => n.toFixed(4))
          .join(),
        actual: uniformLike.value
          .toArray()
          .map(n => n.toFixed(4))
          .join()
      },
      {
        field: 'atmosphere sun',
        expected: directions.sunDirection
          .toArray()
          .map(n => n.toFixed(4))
          .join(),
        actual: atmosphereLike.sunDirection.value
          .toArray()
          .map(n => n.toFixed(4))
          .join()
      },
      {
        field: 'atmosphere moon',
        expected: directions.moonDirection
          .toArray()
          .map(n => n.toFixed(4))
          .join(),
        actual: atmosphereLike.moonDirection.value
          .toArray()
          .map(n => n.toFixed(4))
          .join()
      }
    ])
    expect(plain.equals(directions.sunDirection)).toBe(true)
    expect(uniformLike.value.equals(directions.sunDirection)).toBe(true)
    expect(
      atmosphereLike.sunDirection.value.equals(directions.sunDirection)
    ).toBe(true)
    expect(
      atmosphereLike.moonDirection.value.equals(directions.moonDirection)
    ).toBe(true)
  })

  // The failure this helper exists to prevent: one consumer left at zero, which
  // is valid arithmetic through the march and reads as a black or unshadowed
  // frame rather than as an error
  it('leaves no sink at the zero vector, which is the silent failure', () => {
    const clouds = new Vector3()
    const shadowDeps = { value: new Vector3() }
    syncCelestialDirections(
      [{ sunDirection: clouds }, { sunDirection: shadowDeps }],
      {
        date: DATE,
        location: MID_LATITUDE
      }
    )
    table('sync-no-zero', [
      { field: 'clouds length', expected: '> 0', actual: clouds.length() },
      {
        field: 'shadow deps length',
        expected: '> 0',
        actual: shadowDeps.value.length()
      }
    ])
    expect(clouds.length()).toBeGreaterThan(0)
    expect(shadowDeps.value.length()).toBeGreaterThan(0)
  })

  it('returns what it wrote, so a caller can light the scene from it', () => {
    const sink = new Vector3(9, 9, 9)
    const target = { sunDirection: sink }
    const directions = syncCelestialDirections(target, {
      date: DATE,
      location: MID_LATITUDE
    })
    table('sync-returns-what-it-wrote', [
      {
        field: 'sink was overwritten, not appended to',
        expected: directions.sunDirection.toArray().join(),
        actual: sink.toArray().join()
      },
      {
        field: 'a second call gives the same sun',
        expected: '0',
        actual: syncCelestialDirections(target, {
          date: DATE,
          location: MID_LATITUDE
        })
          .sunDirection.angleTo(directions.sunDirection)
          .toFixed(12)
      }
    ])
    expect(sink.equals(directions.sunDirection)).toBe(true)
    expect(
      syncCelestialDirections(target, {
        date: DATE,
        location: MID_LATITUDE
      }).sunDirection.equals(directions.sunDirection)
    ).toBe(true)
  })

  it('takes a local solar time as well as a date, and reaches the same sun', () => {
    const byDate = syncCelestialDirections(
      { sunDirection: new Vector3() },
      {
        date: resolveTimeOfDay(DATE, 0.75, MID_LATITUDE),
        location: MID_LATITUDE
      }
    )
    const byTime = syncCelestialDirections(
      { sunDirection: new Vector3() },
      {
        date: DATE,
        location: MID_LATITUDE,
        timeOfDay: 0.75
      }
    )
    table('sync-time-of-day', [
      {
        field: 'solar 18:00 elevation deg',
        expected: 'a low sun',
        actual: elevationAt(MID_LATITUDE, byTime.sunDirection).toFixed(2)
      },
      {
        field: 'date and timeOfDay agree',
        expected: '0',
        actual: byDate.sunDirection.angleTo(byTime.sunDirection).toFixed(12)
      }
    ])
    expect(byDate.sunDirection.angleTo(byTime.sunDirection)).toBeLessThan(1e-9)
  })

  it('moves the sun when the clock moves, which is the whole point', () => {
    const morning = syncCelestialDirections(
      { sunDirection: new Vector3() },
      {
        date: DATE,
        location: MID_LATITUDE,
        timeOfDay: 0.3
      }
    )
    const afternoon = syncCelestialDirections(
      { sunDirection: new Vector3() },
      {
        date: DATE,
        location: MID_LATITUDE,
        timeOfDay: 0.7
      }
    )
    const moved = morning.sunDirection.angleTo(afternoon.sunDirection) / DEG
    table('sync-clock', [
      {
        field: 'angle between 07:12 and 16:48 solar deg',
        expected: '> 60',
        actual: moved.toFixed(1)
      }
    ])
    expect(moved).toBeGreaterThan(60)
  })

  it('never bakes a clock in: the same request twice gives the same sun', () => {
    // The library has no time source of its own, so a
    // helper that quietly read Date.now() would be the only one in the pass
    const first = syncCelestialDirections(
      { sunDirection: new Vector3() },
      {
        date: DATE,
        location: MID_LATITUDE
      }
    )
    const later = syncCelestialDirections(
      { sunDirection: new Vector3() },
      {
        date: DATE,
        location: MID_LATITUDE
      }
    )
    log('sync-deterministic', {
      angle: first.sunDirection.angleTo(later.sunDirection),
      wallClockDiffers: Date.now() > 0
    })
    expect(first.sunDirection.equals(later.sunDirection)).toBe(true)
  })
})

describe('celestialVector', () => {
  it('reads both shapes a sink field can have', () => {
    const plain = new Vector3(1, 2, 3)
    const wrapped = { value: new Vector3(4, 5, 6) }
    table('celestial-vector', [
      {
        field: 'plain',
        expected: '1,2,3',
        actual: celestialVector(plain).toArray().join()
      },
      {
        field: 'wrapped',
        expected: '4,5,6',
        actual: celestialVector(wrapped).toArray().join()
      }
    ])
    expect(celestialVector(plain)).toBe(plain)
    expect(celestialVector(wrapped)).toBe(wrapped.value)
  })
})
