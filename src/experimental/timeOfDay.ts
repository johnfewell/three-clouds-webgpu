// A time of day and a place in one call: sun and moon directions in ECEF,
// written into every consumer that needs them. No shader maths, no graph
// change, so the off state is byte-identical by construction
// Cite: @takram/three-atmosphere `celestialDirections` (MIT, Copyright (c) 2024
// Shota Matsuda), https://github.com/takram-design-engineering/three-geospatial

import { Vector3 } from 'three'

import {
  getMoonDirectionECEF,
  getSunDirectionECEF
} from '@takram/three-atmosphere'
import { Geodetic } from '@takram/three-geospatial'

/**
 * Where the observer is: degrees, metres. A `Geodetic` from
 * `@takram/three-geospatial` is accepted as it stands.
 */
export interface TimeOfDayLocation {
  readonly longitude: number
  readonly latitude: number
  readonly height?: number
}

/** Both bodies as ECEF unit vectors, which is what every consumer wants */
export interface CelestialDirections {
  readonly sunDirection: Vector3
  readonly moonDirection: Vector3
}

/**
 * A place a direction can be written to: a plain `Vector3` like
 * `CloudsContext.sunDirection`, or a uniform wrapper like
 * `atmosphere.sunDirectionECEF`. Both are what the shipped consumers hold, so
 * no consumer changes shape to take part.
 */
export type CelestialVector = Vector3 | { readonly value: Vector3 }

/** One consumer. `sunDirection` is required, `moonDirection` is optional */
export interface CelestialSink {
  sunDirection: CelestialVector
  moonDirection?: CelestialVector
}

const MS_PER_DAY = 86_400_000

// The observer position is passed to both bodies' topocentric maths, so a low
// observer gets them parallax-corrected rather than geocentric
function observerPosition(location: TimeOfDayLocation, result: Vector3) {
  return new Geodetic(
    location.longitude,
    location.latitude,
    location.height ?? 0
  ).toECEF(result)
}

/** The `Vector3` behind a sink field, whatever shape that field has */
export function celestialVector(target: CelestialVector): Vector3 {
  return target instanceof Vector3 ? target : target.value
}

/**
 * Sun and moon directions for an instant and a place, in ECEF, unit length
 */
export function computeCelestialDirections(
  date: Date | number,
  location: TimeOfDayLocation,
  result?: CelestialDirections
): CelestialDirections {
  const observer = observerPosition(location, new Vector3())
  return {
    sunDirection: getSunDirectionECEF(date, result?.sunDirection, observer),
    moonDirection: getMoonDirectionECEF(date, result?.moonDirection, observer)
  }
}

/**
 * The instant a local solar time of day names, on a date already in some
 * timezone. `timeOfDay` is a fraction of a day in LOCAL SOLAR time: 0 is local
 * midnight, 0.5 local noon. Longitude is the only thing that converts it, at 15
 * degrees per hour, so the result wraps across UTC midnight instead of
 * clamping.
 *
 * Solar rather than civil time, because this is a sun-direction helper: civil
 * "18:00" is the observer's timezone, which is not where the sun is.
 *
 * Throws a RangeError outside [0, 1), because a wrapped fraction would silently
 * pick a different time of day than the caller asked for.
 */
export function resolveTimeOfDay(
  date: Date | number,
  timeOfDay: number,
  location: TimeOfDayLocation
): Date {
  if (!Number.isFinite(timeOfDay) || timeOfDay < 0 || timeOfDay >= 1) {
    throw new RangeError(
      `time of day must be a fraction of a day in [0, 1), got ${timeOfDay}`
    )
  }
  const utcHours = (((timeOfDay * 24 - location.longitude / 15) % 24) + 24) % 24
  const instant = new Date(date).getTime()
  if (!Number.isFinite(instant)) {
    throw new RangeError(`not a date: ${String(date)}`)
  }
  const dayStart =
    instant - ((((instant / MS_PER_DAY) % 1) + 1) % 1) * MS_PER_DAY
  return new Date(dayStart + (utcHours / 24) * MS_PER_DAY)
}

/** What a caller hands {@link syncCelestialDirections} */
export interface TimeOfDayRequest {
  /** The date the time of day lands on, in any timezone */
  readonly date: Date | number
  readonly location: TimeOfDayLocation
  /**
   * Local solar time as a fraction of a day, in [0, 1). Omit it to use the
   * date's own UTC time, which is what a UTC-driven consumer wants.
   */
  readonly timeOfDay?: number
}

/**
 * Compute both directions and write each into the sinks that take it: one call
 * for the whole sun sync, which is the part consumers get wrong. The
 * atmosphere, the clouds and the shadow dependencies each read their own copy,
 * and a scene missing two of the three is black or unshadowed rather than
 * broken.
 *
 * A sink with no `moonDirection` gets the sun and nothing else, so the clouds
 * context takes part unchanged. Returns the same values it wrote, so a caller can
 * light the scene from them without computing twice.
 */
export function syncCelestialDirections(
  sinks: CelestialSink | readonly CelestialSink[],
  request: TimeOfDayRequest
): CelestialDirections {
  const when =
    request.timeOfDay === undefined
      ? new Date(request.date)
      : resolveTimeOfDay(request.date, request.timeOfDay, request.location)
  const directions = computeCelestialDirections(when, request.location)
  for (const sink of Array.isArray(sinks) ? sinks : [sinks]) {
    celestialVector(sink.sunDirection).copy(directions.sunDirection)
    if (sink.moonDirection !== undefined) {
      celestialVector(sink.moonDirection).copy(directions.moonDirection)
    }
  }
  return directions
}
