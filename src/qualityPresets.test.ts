import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { log } from '../test/helpers/log'
import { CloudsContext } from './CloudsContext'
import {
  applyQualityPreset,
  cloudsMaterialParameterKeys,
  cloudsUniformKeys,
  defaults,
  qualityPresets,
  shadowMapsParameterKeys,
  shadowMaterialParameterKeys,
  shadowPassParameterKeys,
  shadowUniformKeys,
  type QualityPresetTarget
} from './qualityPresets'
import { CascadedShadowMaps } from './shadow/CascadedShadowMaps'

function makeTarget(): QualityPresetTarget {
  return {
    resolutionScale: defaults.resolutionScale,
    lightShafts: defaults.lightShafts,
    shapeDetail: defaults.shapeDetail,
    turbulence: defaults.turbulence,
    haze: defaults.haze,
    clouds: { ...defaults.clouds },
    shadow: { ...defaults.shadow, mapSize: defaults.shadow.mapSize.clone() }
  }
}

describe('qualityPresets', () => {
  test('defaults values', () => {
    expect(defaults.resolutionScale).toBe(1)
    expect(defaults.lightShafts).toBe(true)
    expect(defaults.shapeDetail).toBe(true)
    expect(defaults.turbulence).toBe(true)
    expect(defaults.haze).toBe(true)
    expect(defaults.clouds.multiScatteringOctaves).toBe(8)
    expect(defaults.clouds.maxIterationCount).toBe(500)
    expect(defaults.clouds.minStepSize).toBe(50)
    expect(defaults.shadow.cascadeCount).toBe(3)
    expect(defaults.shadow.mapSize.x).toBe(512)
  })

  test('low preset overrides', () => {
    const low = qualityPresets.low
    expect(low.lightShafts).toBe(false)
    expect(low.shapeDetail).toBe(false)
    expect(low.turbulence).toBe(false)
    expect(low.clouds.accurateSunSkyLight).toBe(false)
    expect(low.clouds.maxIterationCount).toBe(200)
    expect(low.clouds.minStepSize).toBe(100)
    expect(low.clouds.maxRayDistance).toBe(1e5)
    expect(low.clouds.minDensity).toBe(1e-4)
    expect(low.clouds.minTransmittance).toBe(1e-1)
    expect(low.clouds.maxIterationCountToGround).toBe(0)
    expect(low.clouds.maxIterationCountToSun).toBe(1)
    expect(low.shadow.maxIterationCount).toBe(25)
    expect(low.shadow.cascadeCount).toBe(2)
    expect(low.shadow.mapSize.x).toBe(256)
  })

  test('medium preset overrides', () => {
    const med = qualityPresets.medium
    expect(med.lightShafts).toBe(false)
    expect(med.turbulence).toBe(false)
    expect(med.shapeDetail).toBe(true)
    expect(med.clouds.minDensity).toBe(1e-4)
    expect(med.clouds.accurateSunSkyLight).toBe(false)
    expect(med.clouds.maxIterationCountToGround).toBe(1)
    expect(med.shadow.mapSize.x).toBe(256)
  })

  test('high preset equals defaults', () => {
    expect(qualityPresets.high).toBe(defaults)
  })

  test('ultra preset overrides', () => {
    const ultra = qualityPresets.ultra
    expect(ultra.clouds.minStepSize).toBe(10)
    expect(ultra.shadow.mapSize.x).toBe(1024)
    expect(ultra.resolutionScale).toBe(1)
  })

  test('preset diff table', () => {
    const names = ['low', 'medium', 'high', 'ultra', 'lowEnd'] as const
    const topKeys = [
      'resolutionScale',
      'lightShafts',
      'shapeDetail',
      'turbulence',
      'haze'
    ] as const
    const rows: string[] = []
    for (const key of topKeys) {
      const vals = names.map(n => String(qualityPresets[n][key]))
      rows.push(`${key}: ${vals.join(' | ')}`)
    }
    for (const key of Object.keys(defaults.clouds) as Array<
      keyof typeof defaults.clouds
    >) {
      const vals = names.map(n => String(qualityPresets[n].clouds[key]))
      rows.push(`clouds.${key}: ${vals.join(' | ')}`)
    }
    for (const key of Object.keys(defaults.shadow) as Array<
      keyof typeof defaults.shadow
    >) {
      const vals = names.map(n => {
        const v = qualityPresets[n].shadow[key]
        return typeof v === 'object' && v != null && 'x' in v
          ? `${v.x}x${v.y}`
          : String(v)
      })
      rows.push(`shadow.${key}: ${vals.join(' | ')}`)
    }
    console.log('Preset diff table:\n' + rows.join('\n'))
    expect(rows.length).toBeGreaterThan(0)
  })

  test('applyQualityPreset: low then high restores defaults', () => {
    const target = makeTarget()
    applyQualityPreset(target, 'low')
    expect(target.lightShafts).toBe(false)
    expect(target.clouds.maxIterationCount).toBe(200)

    applyQualityPreset(target, 'high')
    expect(target.resolutionScale).toBe(defaults.resolutionScale)
    expect(target.lightShafts).toBe(defaults.lightShafts)
    expect(target.shapeDetail).toBe(defaults.shapeDetail)
    expect(target.turbulence).toBe(defaults.turbulence)
    expect(target.haze).toBe(defaults.haze)
    expect(target.clouds.maxIterationCount).toBe(
      defaults.clouds.maxIterationCount
    )
    expect(target.clouds.minStepSize).toBe(defaults.clouds.minStepSize)
    expect(target.clouds.accurateSunSkyLight).toBe(
      defaults.clouds.accurateSunSkyLight
    )
    expect(target.shadow.cascadeCount).toBe(defaults.shadow.cascadeCount)
  })

  test('applyQualityPreset leaves unrelated keys untouched', () => {
    const target = makeTarget() as QualityPresetTarget & { extra: string }
    target.extra = 'keep'
    applyQualityPreset(target, 'low')
    expect(target.extra).toBe('keep')
  })

  test.each(['low', 'medium', 'high', 'ultra'] as const)(
    '%s helper and context setter produce the same configuration',
    name => {
      const helperTarget = new CloudsContext()
      const setterTarget = new CloudsContext()
      applyQualityPreset(helperTarget, name)
      setterTarget.qualityPreset = name

      expect(helperTarget.qualityPreset).toBe(name)
      expect(helperTarget.clouds).toEqual(setterTarget.clouds)
      expect(helperTarget.shadow).toEqual(setterTarget.shadow)
      expect(helperTarget.graphFlags()).toEqual(setterTarget.graphFlags())
      expect(helperTarget.graphVersion).toBe(setterTarget.graphVersion)
      log('preset-application-routes', {
        requested: name,
        helper: helperTarget.qualityPreset,
        setter: setterTarget.qualityPreset,
        helperGraphVersion: helperTarget.graphVersion,
        setterGraphVersion: setterTarget.graphVersion
      })
    }
  )

  test.each(['low', 'medium', 'high', 'ultra'] as const)(
    '%s preserves target map identity and isolates contexts and preset values',
    name => {
      const first = new CloudsContext()
      const second = new CloudsContext()
      const firstMapSize = first.shadow.mapSize
      const secondMapSize = second.shadow.mapSize
      const expectedMapSize = qualityPresets[name].shadow.mapSize.clone()
      const expectedDefaults = defaults.shadow.mapSize.clone()
      applyQualityPreset(first, name)
      second.qualityPreset = name

      expect(first.shadow.mapSize).toBe(firstMapSize)
      expect(second.shadow.mapSize).toBe(secondMapSize)
      expect(firstMapSize).not.toBe(secondMapSize)
      expect(firstMapSize).not.toBe(qualityPresets[name].shadow.mapSize)
      expect(firstMapSize).toEqual(expectedMapSize)
      firstMapSize.set(123, 456)

      expect(secondMapSize).toEqual(expectedMapSize)
      expect(qualityPresets[name].shadow.mapSize).toEqual(expectedMapSize)
      expect(defaults.shadow.mapSize).toEqual(expectedDefaults)
      log('preset-map-isolation', {
        name,
        first: firstMapSize.toArray(),
        second: secondMapSize.toArray(),
        preset: qualityPresets[name].shadow.mapSize.toArray(),
        expected: expectedMapSize.toArray()
      })
    }
  )

  test('structural targets preserve their map instance when applying presets', () => {
    const target = makeTarget()
    const mapSize = target.shadow.mapSize
    applyQualityPreset(target, 'low')
    expect(target.shadow.mapSize).toBe(mapSize)
    expect(mapSize).toEqual(qualityPresets.low.shadow.mapSize)
    log('structural-preset-target', {
      mapIdentityPreserved: target.shadow.mapSize === mapSize,
      actual: mapSize.toArray(),
      expected: qualityPresets.low.shadow.mapSize.toArray()
    })
  })

  test.each(['unknown', 'toString', '__proto__'])(
    'invalid preset %s fails before changing target state',
    invalidName => {
      const target = new CloudsContext()
      target.qualityPreset = 'low'
      const before = {
        clouds: { ...target.clouds },
        shadow: { ...target.shadow, mapSize: target.shadow.mapSize.clone() },
        graphVersion: target.graphVersion
      }
      const name = invalidName as Parameters<typeof applyQualityPreset>[1]
      const expectedMessage =
        `Unknown quality preset ${JSON.stringify(invalidName)}; ` +
        'expected one of: low, medium, high, ultra, lowEnd'

      expect(() => applyQualityPreset(target, name)).toThrow(expectedMessage)
      expect(() => {
        target.qualityPreset = name
      }).toThrow(expectedMessage)
      expect(target.qualityPreset).toBe('low')
      expect(target.clouds).toEqual(before.clouds)
      expect(target.shadow).toEqual(before.shadow)
      expect(target.graphVersion).toBe(before.graphVersion)
      log('invalid-quality-preset', {
        invalidName,
        actualPreset: target.qualityPreset,
        expectedPreset: 'low',
        actualGraphVersion: target.graphVersion,
        expectedGraphVersion: before.graphVersion
      })
    }
  )

  test('six exported key lists match CloudsEffect.ts:60-120', () => {
    expect([...cloudsUniformKeys]).toEqual([
      'maxIterationCount',
      'minStepSize',
      'maxStepSize',
      'maxRayDistance',
      'perspectiveStepScale',
      'minDensity',
      'minExtinction',
      'minTransmittance',
      'maxIterationCountToSun',
      'maxIterationCountToGround',
      'minSecondaryStepSize',
      'secondaryStepScale',
      'maxShadowFilterRadius',
      'maxShadowLengthIterationCount',
      'minShadowLengthStepSize',
      'maxShadowLengthRayDistance',
      'hazeDensityScale',
      'hazeExponent',
      'hazeScatteringCoefficient',
      'hazeAbsorptionCoefficient'
    ])

    expect([...cloudsMaterialParameterKeys]).toEqual([
      'multiScatteringOctaves',
      'accurateSunSkyLight',
      'accuratePhaseFunction'
    ])

    expect([...shadowUniformKeys]).toEqual([
      'maxIterationCount',
      'minStepSize',
      'maxStepSize',
      'minDensity',
      'minExtinction',
      'minTransmittance',
      'opticalDepthTailScale'
    ])

    expect([...shadowMaterialParameterKeys]).toEqual(['temporalJitter'])

    expect([...shadowPassParameterKeys]).toEqual(['temporalPass'])

    expect([...shadowMapsParameterKeys]).toEqual([
      'cascadeCount',
      'mapSize',
      'maxFar',
      'farScale',
      'splitMode',
      'splitLambda'
    ])
  })
})

// The preset's shadow-structural fields are the ones CloudsEffect.ts:250-254
// hands to CascadedShadowMaps. A value the reference lacks is a port-only
// deviation, and the preset reaches BOTH sides, so the ladder cannot see it
describe('the shadow-structural defaults are the reference values', () => {
  // Cite: reference/clouds/src/CascadedShadowMaps.ts cascadedShadowMapsDefaults
  const referenceDefaults = {
    maxFar: null,
    farScale: 1,
    splitMode: 'practical',
    splitLambda: 0.5
  } as const

  // Cite: reference/clouds/src/CloudsEffect.ts:250-254. The constructor passes
  // ONLY these three, so every other structural field keeps the class default
  const explicitlyPassed = { splitLambda: 0.6 } as const

  const effect = readFileSync(
    join(import.meta.dirname, '../reference/clouds/src/CloudsEffect.ts'),
    'utf8'
  )

  // SPLIT_MODE_NAMES at src/CloudsContext.ts:47-51, indexed by
  // syncShadowMaps at :540. The preset holds an index (harness wire format)
  const SPLIT_MODE_NAMES = ['uniform', 'logarithmic', 'practical'] as const

  test('every structural field is either the class default or explicitly passed', () => {
    const s = defaults.shadow
    const rows = [
      {
        field: 'maxFar',
        expected: referenceDefaults.maxFar,
        actual: s.maxFar
      },
      {
        field: 'farScale',
        expected: referenceDefaults.farScale,
        actual: s.farScale
      },
      {
        field: 'splitMode',
        expected: referenceDefaults.splitMode,
        actual: SPLIT_MODE_NAMES[s.splitMode] ?? 'practical'
      },
      {
        field: 'splitLambda',
        expected: explicitlyPassed.splitLambda,
        actual: s.splitLambda
      }
    ]
    for (const row of rows) {
      expect(row.actual, `${row.field} diverges from the reference`).toBe(
        row.expected
      )
    }
  })

  test('the INSTALLED split is practical, and the reference installs its default', () => {
    // The index test below reads a preset field. This one reads what
    // CloudsContext.syncShadowMaps hands the CascadedShadowMaps, which is the
    // state the render builds its cascades from
    const ctx = new CloudsContext()
    ctx.shadowMaps = new CascadedShadowMaps({
      cascadeCount: ctx.shadow.cascadeCount,
      mapSize: ctx.shadow.mapSize.clone(),
      splitLambda: ctx.shadow.splitLambda
    })
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps?.splitMode).toBe(referenceDefaults.splitMode)
    expect(referenceDefaults.splitMode).toBe('practical')
    expect(defaults.shadow.splitMode).toBe(2)

    // Whether the REFERENCE installs that default is the other half, and it is
    // a question about CloudsEffect's constructor, not about a preset
    // reference/ is outside this tsconfig, so the check is over its text
    const start = effect.indexOf('this.shadowMaps = new CascadedShadowMaps({')
    const construction = effect.slice(start, start + 400)
    expect(
      start,
      'CloudsEffect no longer builds a CascadedShadowMaps here'
    ).toBeGreaterThan(-1)
    expect(
      construction,
      'the reference now passes splitMode, so its effective mode is no ' +
        'longer the class default and this guard needs re-deriving'
    ).not.toContain('splitMode')
    expect(construction).toContain('cascadeCount')
    expect(construction).toContain('mapSize')
    expect(construction).toContain('splitLambda: 0.6')
  })

  test('the split index resolves to practical, and 2 is not logarithmic', () => {
    // Its own case because the index is the whole hazard: reading index 2 as
    // 'logarithmic' would fix a divergence that does not exist
    expect(SPLIT_MODE_NAMES[2]).toBe('practical')
    expect(SPLIT_MODE_NAMES[1]).toBe('logarithmic')
    expect(defaults.shadow.splitMode).toBe(2)
    expect(
      SPLIT_MODE_NAMES[defaults.shadow.splitMode],
      'the live preset must resolve to the reference split'
    ).toBe(referenceDefaults.splitMode)
  })
})

// lowEnd is the perf map's c4, a fallback for low-end or contended GPUs. It is
// opt-in: never what a context starts with, and the four original presets
// must keep leaving the two knobs they never set alone
describe('lowEnd preset', () => {
  test('sets the judged c4 values', () => {
    const p = qualityPresets.lowEnd
    expect(p.resolutionScale).toBe(0.5)
    expect(p.temporalUpscale).toBe(true)
    expect(p.lightShaftsHalfResolution).toBe(true)
    expect(p.lightShafts).toBe(true)
    expect(p.haze).toBe(false)
    expect(p.turbulence).toBe(false)
    expect(p.shapeDetail).toBe(true)
    expect(p.clouds.accurateSunSkyLight).toBe(false)
    expect(p.clouds.maxIterationCountToSun).toBe(0)
    expect(p.clouds.maxIterationCountToGround).toBe(0)
    expect(p.clouds.minStepSize).toBe(200)
    expect(p.clouds.minDensity).toBe(1e-4)
    expect(p.shadow.cascadeCount).toBe(1)
    expect(p.shadow.updateInterval).toBe(4)
    expect([p.shadow.mapSize.x, p.shadow.mapSize.y]).toEqual([128, 128])
    log('lowEnd-values', [
      { field: 'resolutionScale', expected: 0.5, actual: p.resolutionScale },
      { field: 'cascadeCount', expected: 1, actual: p.shadow.cascadeCount },
      { field: 'minStepSize', expected: 200, actual: p.clouds.minStepSize }
    ])
  })

  test('is not the default', () => {
    const ctx = new CloudsContext()
    expect(ctx.qualityPreset).toBe('high')
    expect(ctx.resolutionScale).toBe(defaults.resolutionScale)
    expect(ctx.shadow.updateInterval).toBe(defaults.shadow.updateInterval)
    expect(ctx.shadow.cascadeCount).toBe(defaults.shadow.cascadeCount)
  })

  test('reaches the context through its setters', () => {
    const ctx = new CloudsContext()
    ctx.temporalUpscale = false
    ctx.lightShaftsHalfResolution = false
    const before = ctx.graphVersion
    ctx.qualityPreset = 'lowEnd'
    expect(ctx.qualityPreset).toBe('lowEnd')
    expect(ctx.temporalUpscale).toBe(true)
    expect(ctx.lightShaftsHalfResolution).toBe(true)
    expect(ctx.resolutionScale).toBe(0.5)
    expect(ctx.shadow.updateInterval).toBe(4)
    expect(ctx.shadow.cascadeCount).toBe(1)
    expect(ctx.graphVersion).toBeGreaterThan(before)
    log('lowEnd-setters', {
      graphVersionBefore: before,
      graphVersionAfter: ctx.graphVersion
    })
  })

  test.each(['low', 'medium', 'high', 'ultra'] as const)(
    '%s leaves temporalUpscale and lightShaftsHalfResolution alone',
    name => {
      expect('temporalUpscale' in qualityPresets[name]).toBe(false)
      expect('lightShaftsHalfResolution' in qualityPresets[name]).toBe(false)
      const ctx = new CloudsContext()
      ctx.temporalUpscale = false
      ctx.lightShaftsHalfResolution = false
      ctx.qualityPreset = name
      expect(ctx.temporalUpscale).toBe(false)
      expect(ctx.lightShaftsHalfResolution).toBe(false)
    }
  )
})
