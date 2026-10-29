// Scene presets: a preset is only worth having if the sky it writes is the sky
// it names. These check the numbers that make that true (the sun really is low
// for a sunset, coverage really lands, the storm presets really ask for the
// convective shoulder) and that the OFF state is untouched, whose proof is
// defaultOutputDigest.test.ts

import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { applyReferenceMode } from '../referenceMode'
import { cloudTypePresetNames } from './cloudTypePresets'
import { experimentalDefaults } from './options'
import {
  applyScenePreset,
  isScenePresetName,
  scenePresetNames,
  scenePresets,
  type ScenePresetName
} from './scenePresets'
import { computeCelestialDirections, resolveTimeOfDay } from './timeOfDay'

const DEG = Math.PI / 180

// The place a preset is judged at: mid latitude, prime meridian, in October, so
// sunset is not solar 18:00 and a "low sun" claim is a real one
const PLACE = { longitude: 0, latitude: 45, height: 0 }
const DATE = new Date('2026-10-04T12:00:00Z')

function elevationAt(location: typeof PLACE, direction: Vector3) {
  const up = new Vector3(
    Math.cos(location.latitude * DEG) * Math.cos(location.longitude * DEG),
    Math.cos(location.latitude * DEG) * Math.sin(location.longitude * DEG),
    Math.sin(location.latitude * DEG)
  )
  return Math.asin(direction.clone().normalize().dot(up)) / DEG
}

/** The sun elevation a preset lands on, at PLACE on DATE */
function sunElevation(name: ScenePresetName) {
  const { timeOfDay } = scenePresets[name]
  const when = resolveTimeOfDay(DATE, timeOfDay, PLACE)
  const { sunDirection } = computeCelestialDirections(when, PLACE)
  return elevationAt(PLACE, sunDirection)
}

describe('scene preset table', () => {
  it('names the eight skies, and each name is a string it claims', () => {
    table('scene-names', [
      { field: 'names', expected: 8, actual: scenePresetNames.length },
      {
        field: 'table keys match the name list',
        expected: scenePresetNames.join(),
        actual: Object.keys(scenePresets).join()
      }
    ])
    expect(scenePresetNames).toHaveLength(8)
    expect(Object.keys(scenePresets).sort()).toEqual(
      [...scenePresetNames].sort()
    )
    for (const name of scenePresetNames) {
      expect(isScenePresetName(name)).toBe(true)
    }
    expect(isScenePresetName('squall')).toBe(false)
    expect(isScenePresetName(42)).toBe(false)
  })

  // A preset with a time outside [0,1) would throw inside resolveTimeOfDay, in
  // the middle of writing a scene, having already written the cloud type
  it('gives every preset a usable time of day and a known cloud type', () => {
    const rows = scenePresetNames.map(name => {
      const preset = scenePresets[name]
      let error = 'none'
      try {
        resolveTimeOfDay(DATE, preset.timeOfDay, PLACE)
      } catch (e) {
        error = e instanceof Error ? e.message : 'unknown error'
      }
      return {
        field: name,
        expected: 'resolves, cloud type known',
        actual: `${error}, ${preset.cloudType}`
      }
    })
    table('scene-time-of-day', rows)
    for (const name of scenePresetNames) {
      const { timeOfDay, cloudType, coverage } = scenePresets[name]
      expect(timeOfDay, `${name} timeOfDay`).toBeGreaterThanOrEqual(0)
      expect(timeOfDay, `${name} timeOfDay`).toBeLessThan(1)
      expect(() => resolveTimeOfDay(DATE, timeOfDay, PLACE)).not.toThrow()
      expect(cloudTypePresetNames, `${name} cloud type exists`).toContain(
        cloudType
      )
      expect(coverage, `${name} coverage`).toBeGreaterThan(0)
      expect(coverage, `${name} coverage`).toBeLessThanOrEqual(1)
    }
  })
})

describe('the time each preset names', () => {
  // The claims in the table's comments, as assertions: a sunset preset whose sun
  // is 40 degrees up, or a night preset whose sun is up, is a preset that lies
  it('puts the sun low for the sunset preset and below the horizon for the night', () => {
    const rows = scenePresetNames.map(name => ({
      field: name,
      expected: scenePresetExpectation(name),
      actual: `${sunElevation(name).toFixed(1)} deg`
    }))
    table('scene-sun-elevation', rows)
    expect(sunElevation('stunningSunset')).toBeLessThan(12)
    expect(sunElevation('stunningSunset')).toBeGreaterThan(-8)
    expect(sunElevation('moonlitNight')).toBeLessThan(-20)
    expect(sunElevation('partlyCloudy')).toBeGreaterThan(10)
    expect(sunElevation('pixar')).toBeGreaterThan(10)
    expect(sunElevation('fluffy')).toBeGreaterThan(10)
    expect(sunElevation('hazy')).toBeGreaterThan(30)
    expect(sunElevation('thunderstorm')).toBeGreaterThan(20)
    expect(sunElevation('stormyEvening')).toBeGreaterThan(20)
  })

  it('orders the presets by sun height the way their names promise', () => {
    const rows = [
      {
        field: 'night below day',
        expected: true,
        actual: sunElevation('moonlitNight') < sunElevation('partlyCloudy')
      },
      {
        field: 'sunset below midday',
        expected: true,
        actual: sunElevation('stunningSunset') < sunElevation('hazy')
      }
    ]
    table('scene-sun-order', rows)
    expect(sunElevation('moonlitNight')).toBeLessThan(
      sunElevation('partlyCloudy')
    )
    expect(sunElevation('stunningSunset')).toBeLessThan(sunElevation('hazy'))
  })
})

function scenePresetExpectation(name: ScenePresetName) {
  if (name === 'moonlitNight') return 'below -20 deg'
  if (name === 'stunningSunset') {
    return 'near the horizon'
  }
  return 'above 10 deg'
}

describe('applyScenePreset', () => {
  it('writes cloud type, coverage, haze, options and the sun in one call', () => {
    const ctx = new CloudsContext()
    const atmosphereSun = { value: new Vector3() }
    const shadowSun = { value: new Vector3() }
    const applied = applyScenePreset(ctx, 'hazy', {
      date: DATE,
      location: PLACE,
      timeOfDay: scenePresets.hazy.timeOfDay,
      sinks: [
        {
          sunDirection: atmosphereSun,
          moonDirection: { value: new Vector3() }
        },
        { sunDirection: ctx.sunDirection },
        { sunDirection: shadowSun }
      ]
    })
    const preset = scenePresets.hazy
    table('scene-apply', [
      { field: 'coverage', expected: preset.coverage, actual: ctx.coverage },
      { field: 'haze', expected: preset.haze, actual: ctx.haze },
      {
        field: 'live lanes',
        expected: 2,
        actual: ctx.cloudLayers.structure.active.length
      },
      {
        field: 'applied date is the resolved one',
        expected: applied.date.toISOString(),
        actual: resolveTimeOfDay(DATE, preset.timeOfDay, PLACE).toISOString()
      },
      {
        field: 'atmosphere sun equals the returned sun',
        expected: 'identical',
        actual: atmosphereSun.value.equals(applied.directions.sunDirection)
          ? 'identical'
          : 'DIVERGED'
      },
      {
        field: 'shadow deps sun equals the returned sun',
        expected: 'identical',
        actual: shadowSun.value.equals(applied.directions.sunDirection)
          ? 'identical'
          : 'DIVERGED'
      },
      {
        field: 'clouds sun equals the returned sun',
        expected: 'identical',
        actual: ctx.sunDirection.equals(applied.directions.sunDirection)
          ? 'identical'
          : 'DIVERGED'
      }
    ])
    expect(ctx.coverage).toBe(preset.coverage)
    expect(ctx.haze).toBe(preset.haze)
    expect(ctx.sunDirection.equals(applied.directions.sunDirection)).toBe(true)
    expect(atmosphereSun.value.equals(applied.directions.sunDirection)).toBe(
      true
    )
    expect(shadowSun.value.equals(applied.directions.sunDirection)).toBe(true)
    expect(applied.date.getTime()).toBe(
      resolveTimeOfDay(DATE, preset.timeOfDay, PLACE).getTime()
    )
  })

  it('reaches the shader: every preset moves the context off the default', () => {
    const rows: Array<Record<string, unknown>> = []
    for (const name of scenePresetNames) {
      const ctx = new CloudsContext()
      const before = ctx.coverage
      const structure = ctx.cloudLayers.structure.active.join('')
      applyScenePreset(ctx, name, {
        date: DATE,
        location: PLACE,
        sinks: { sunDirection: ctx.sunDirection }
      })
      rows.push({
        field: name,
        expected: 'coverage and layers differ',
        actual:
          ctx.coverage !== before &&
          ctx.cloudLayers.structure.active.join('') !== structure
            ? `coverage ${before}->${ctx.coverage}, lanes ${structure}->${ctx.cloudLayers.structure.active.join('')}`
            : 'INERT'
      })
      expect(ctx.coverage, `${name} coverage`).toBe(scenePresets[name].coverage)
    }
    table('scene-reaches-context', rows)
  })

  it('merges experimental options instead of clearing the callers', () => {
    const ctx = new CloudsContext()
    ctx.experimental = { cloudTypeMap: true }
    applyScenePreset(ctx, 'thunderstorm', {
      date: DATE,
      location: PLACE,
      sinks: { sunDirection: ctx.sunDirection }
    })
    table('scene-experimental', [
      {
        field: 'convectiveProfile asked for by the preset',
        expected: true,
        actual: ctx.experimental.convectiveProfile
      },
      {
        field: 'the callers own option survived',
        expected: true,
        actual: ctx.experimental.cloudTypeMap
      },
      {
        field: 'an option the preset says nothing about',
        expected: experimentalDefaults.windReprojection,
        actual: ctx.experimental.windReprojection
      }
    ])
    expect(ctx.experimental.convectiveProfile).toBe(true)
    expect(ctx.experimental.cloudTypeMap).toBe(true)
    expect(ctx.experimental.windReprojection).toBe(
      experimentalDefaults.windReprojection
    )
  })

  it('resets preset-managed experiments and scattering when switching presets', () => {
    const ctx = new CloudsContext()
    ctx.experimental = { cloudEnvironment: true }
    applyScenePreset(ctx, 'moonlitNight', {
      date: DATE,
      location: PLACE,
      sinks: {
        sunDirection: ctx.sunDirection,
        moonDirection: ctx.moonDirection
      }
    })
    expect(ctx.experimental.moonlight).toBe(true)
    expect(ctx.moonGain).toBeGreaterThan(1)

    applyScenePreset(ctx, 'partlyCloudy', {
      date: DATE,
      location: PLACE,
      sinks: {
        sunDirection: ctx.sunDirection,
        moonDirection: ctx.moonDirection
      }
    })
    table('scene-switch-reset', [
      {
        field: 'moonlight cleared after switching to partlyCloudy',
        expected: false,
        actual: ctx.experimental.moonlight
      },
      {
        field: 'cloudEnvironment caller flag preserved',
        expected: true,
        actual: ctx.experimental.cloudEnvironment
      },
      {
        field: 'moonGain reset to 1',
        expected: 1,
        actual: ctx.moonGain
      }
    ])
    expect(ctx.experimental.moonlight).toBe(false)
    expect(ctx.experimental.cloudEnvironment).toBe(true)
    expect(ctx.moonGain).toBe(1)
  })

  // The reference promise is one call away, and a storm preset is exactly the
  // case where a consumer who wants the original's look must be able to undo it
  it('leaves reference mode able to pin the options back off', () => {
    const ctx = new CloudsContext()
    applyScenePreset(ctx, 'thunderstorm', {
      date: DATE,
      location: PLACE,
      sinks: { sunDirection: ctx.sunDirection }
    })
    const afterPreset = ctx.experimental.convectiveProfile
    applyReferenceMode(ctx)
    log('scene-reference', {
      presetTurnedItOn: afterPreset,
      pinnedBackOff: ctx.experimental.convectiveProfile
    })
    expect(afterPreset).toBe(true)
    expect(ctx.experimental.convectiveProfile).toBe(false)
  })

  it('refuses an unknown preset before it writes anything', () => {
    const ctx = new CloudsContext()
    const coverage = ctx.coverage
    let error = 'none'
    try {
      applyScenePreset(ctx, 'squall' as ScenePresetName, {
        date: DATE,
        location: PLACE,
        sinks: { sunDirection: ctx.sunDirection }
      })
    } catch (e) {
      error = e instanceof RangeError ? 'RangeError' : 'wrong error type'
    }
    table('scene-unknown', [
      { field: 'error', expected: 'RangeError', actual: error },
      { field: 'coverage after', expected: coverage, actual: ctx.coverage }
    ])
    expect(error).toBe('RangeError')
    expect(ctx.coverage).toBe(coverage)
  })
})
