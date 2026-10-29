// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  Data3DTexture,
  Matrix4,
  PerspectiveCamera,
  Texture,
  Vector2,
  Vector3
} from 'three'
import { vi } from 'vitest'

import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

import { log, setCurrentSpec } from '../test/helpers/log'
import { CloudLayers } from './CloudLayers'
import { CloudsContext, getCloudsContext } from './CloudsContext'
import {
  applyQualityPreset,
  cloudsMaterialParameterKeys,
  cloudsUniformKeys,
  defaults,
  shadowMapsParameterKeys,
  shadowMaterialParameterKeys,
  shadowPassParameterKeys,
  shadowUniformKeys
} from './qualityPresets'
import { CascadedShadowMaps } from './shadow/CascadedShadowMaps'

describe('CloudsContext', () => {
  test('defaults match the spec', () => {
    const ctx = new CloudsContext()

    expect(ctx.cloudLayers).toBeInstanceOf(CloudLayers)
    expect(ctx.cloudLayers).toHaveLength(4)

    expect(ctx.localWeatherRepeat).toEqual(new Vector2(100, 100))
    expect(ctx.localWeatherOffset).toEqual(new Vector2(0, 0))
    expect(ctx.shapeRepeat).toEqual(new Vector3(0.0003, 0.0003, 0.0003))
    expect(ctx.shapeOffset).toEqual(new Vector3(0, 0, 0))
    expect(ctx.shapeDetailRepeat).toEqual(new Vector3(0.006, 0.006, 0.006))
    expect(ctx.shapeDetailOffset).toEqual(new Vector3(0, 0, 0))
    expect(ctx.turbulenceRepeat).toEqual(new Vector2(20, 20))

    expect(ctx.localWeatherVelocity).toEqual(new Vector2(0, 0))
    expect(ctx.shapeVelocity).toEqual(new Vector3(0, 0, 0))
    expect(ctx.shapeDetailVelocity).toEqual(new Vector3(0, 0, 0))

    expect(ctx.localWeatherTexture).toBeNull()
    expect(ctx.shapeTexture).toBeNull()
    expect(ctx.shapeDetailTexture).toBeNull()
    expect(ctx.turbulenceTexture).toBeNull()
    expect(ctx.stbnTexture).toBeDefined()

    expect(ctx.coverage).toBe(0.3)
    expect(ctx.scatteringCoefficient).toBe(1)
    expect(ctx.absorptionCoefficient).toBe(0)
    expect(ctx.turbulenceDisplacement).toBe(350)

    expect(ctx.skyLightScale).toBe(1)
    expect(ctx.groundBounceScale).toBe(1)
    expect(ctx.powderScale).toBe(0.8)
    expect(ctx.powderExponent).toBe(150)

    expect(ctx.scatterAnisotropy1).toBe(0.7)
    expect(ctx.scatterAnisotropy2).toBe(-0.2)
    expect(ctx.scatterAnisotropyMix).toBe(0.5)

    expect(ctx.resolutionScale).toBe(1)
    expect(ctx.temporalUpscale).toBe(true)
    expect(ctx.lightShafts).toBe(true)
    expect(ctx.shapeDetail).toBe(true)
    expect(ctx.turbulence).toBe(true)
    expect(ctx.haze).toBe(true)

    expect(ctx.correctAltitude).toBe(true)
    expect(ctx.worldToECEFMatrix).toBeInstanceOf(Matrix4)
    expect(ctx.ecefToWorldMatrix).toBeInstanceOf(Matrix4)
    expect(ctx.altitudeCorrection).toBeInstanceOf(Vector3)
    expect(ctx.sunDirection).toBeInstanceOf(Vector3)
    expect(ctx.ellipsoid).toBe(Ellipsoid.WGS84)
    expect(ctx.sunAngularRadius).toBeCloseTo(0.004675, 6)
    expect(ctx.bottomRadius).toBe(6360000)
    expect(ctx.cameraHeight).toBe(0)

    expect(ctx.time).toBe(0)
    expect(ctx.frame).toBe(0)
    expect(ctx.enabled).toBe(true)
    expect(ctx.warnings).toBe(true)

    expect(ctx.clouds.maxIterationCount).toBe(defaults.clouds.maxIterationCount)
    expect(ctx.clouds.minStepSize).toBe(defaults.clouds.minStepSize)
    expect(ctx.clouds.maxShadowFilterRadius).toBe(
      defaults.clouds.maxShadowFilterRadius
    )
    expect(ctx.clouds.hazeDensityScale).toBe(defaults.clouds.hazeDensityScale)
    expect(ctx.shadow.cascadeCount).toBe(defaults.shadow.cascadeCount)
    expect(ctx.shadow.mapSize.x).toBe(512)
    expect(ctx.shadow.opticalDepthTailScale).toBe(
      defaults.shadow.opticalDepthTailScale
    )
    expect(ctx.shadow.temporalJitter).toBe(defaults.shadow.temporalJitter)
    expect(ctx.shadow.temporalPass).toBe(defaults.shadow.temporalPass)
    expect(ctx.shadow.maxFar).toBe(defaults.shadow.maxFar)
    expect(ctx.shadow.splitLambda).toBe(defaults.shadow.splitLambda)
  })

  test('getCloudsContext retrieves from TSL context', () => {
    const ctx = new CloudsContext()
    const mockContext = { getClouds: () => ctx }
    expect(getCloudsContext(mockContext as Record<string, unknown>)).toBe(ctx)
  })

  test('getCloudsContext throws when no getClouds function', () => {
    expect(() => getCloudsContext({})).toThrow(
      'no CloudsContext in the TSL context'
    )
  })

  test('getCloudsContext throws when getClouds returns wrong type', () => {
    const mockContext = { getClouds: () => ({}) }
    expect(() =>
      getCloudsContext(mockContext as Record<string, unknown>)
    ).toThrow()
  })

  test('dispose() disposes owned textures', () => {
    const ctx = new CloudsContext()
    const tex1 = new Texture()
    const tex2 = new Texture()
    const disposeSpy1 = vi.spyOn(tex1, 'dispose')
    const disposeSpy2 = vi.spyOn(tex2, 'dispose')

    ctx.localWeatherTexture = tex1
    ctx.turbulenceTexture = tex2
    ctx.dispose()

    expect(disposeSpy1).toHaveBeenCalledOnce()
    expect(disposeSpy2).toHaveBeenCalledOnce()
    expect(ctx.localWeatherTexture).toBeNull()
    expect(ctx.turbulenceTexture).toBeNull()
  })

  test('dispose releases every generated jitter once after slot replacement', () => {
    const context = new CloudsContext()
    const first = context.stbnTexture
    const firstDispose = vi.spyOn(first, 'dispose')
    context.stbnTexture = null
    const second = context.stbnTexture
    const secondDispose = vi.spyOn(second, 'dispose')
    expect(second).not.toBe(first)
    expect(context.stbnTexture).toBe(second)
    context.dispose()
    context.dispose()
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).toHaveBeenCalledTimes(1)
    expect(context.resolvedStbnTexture).toBeNull()
    log('generated jitter ownership', {
      retired: firstDispose.mock.calls.length,
      current: secondDispose.mock.calls.length
    })
  })

  test('detaching borrowed jitter preserves it without leaking generated jitter', () => {
    const context = new CloudsContext()
    const generated = context.stbnTexture
    const generatedDispose = vi.spyOn(generated, 'dispose')
    const borrowed = new Data3DTexture(new Uint8Array(1), 1, 1, 1)
    const borrowedDispose = vi.spyOn(borrowed, 'dispose')
    context.stbnTexture = borrowed
    context.stbnTexture = null
    context.dispose()
    expect(generatedDispose).toHaveBeenCalledTimes(1)
    expect(borrowedDispose).not.toHaveBeenCalled()
    log('detached jitter ownership', {
      generated: generatedDispose.mock.calls.length,
      borrowed: borrowedDispose.mock.calls.length
    })
    borrowed.dispose()
  })

  test('graphVersion increments for graph-shape setters', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion
    ctx.multiScatteringOctaves = 4
    expect(ctx.graphVersion).toBe(v0 + 1)
    ctx.accurateSunSkyLight = false
    expect(ctx.graphVersion).toBe(v0 + 2)
    ctx.accuratePhaseFunction = true
    expect(ctx.graphVersion).toBe(v0 + 3)
    ctx.shapeDetail = false
    expect(ctx.graphVersion).toBe(v0 + 4)
    ctx.turbulence = false
    expect(ctx.graphVersion).toBe(v0 + 5)
  })

  // `enabled` was the one graph-shape setter that did not bump
  // graphVersion, so toggling it changed nothing on screen (ADR-003 needs a
  // rebuild). Separate from the list above so a failure names itself
  test('graphVersion increments when enabled is toggled', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion

    ctx.enabled = false
    expect(ctx.graphVersion).toBe(v0 + 1)
    ctx.enabled = true
    expect(ctx.graphVersion).toBe(v0 + 2)
  })

  test('graphVersion no-ops when enabled is set to its current value', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion

    // Already true by default, so assigning it again must not force a rebuild
    ctx.enabled = true
    expect(ctx.graphVersion).toBe(v0)
  })

  test('graphVersion does not increment for uniform knobs', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion
    ctx.coverage = 0.5
    ctx.time = 10
    ctx.frame = 5
    ctx.skyLightScale = 2
    expect(ctx.graphVersion).toBe(v0)
  })

  test('graphVersion no-ops on same value', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion
    ctx.multiScatteringOctaves = defaults.clouds.multiScatteringOctaves
    ctx.shapeDetail = defaults.shapeDetail
    ctx.turbulence = defaults.turbulence
    ctx.accurateSunSkyLight = defaults.clouds.accurateSunSkyLight
    expect(ctx.graphVersion).toBe(v0)
  })

  test('resetHistory before registration is a no-op', () => {
    const ctx = new CloudsContext()
    expect(() => ctx.resetHistory()).not.toThrow()
  })

  test('resetHistory after registration forwards', () => {
    const ctx = new CloudsContext()
    const spy = vi.fn()
    ctx.registerResetHistory(spy)
    ctx.resetHistory()
    expect(spy).toHaveBeenCalledOnce()
  })

  // the graph-shape fields must follow the preset and bump
  // graphVersion, as the reference's accessor shorthand does (CloudsEffect.ts:290),
  // since writing only `clouds` kept 'high' lighting under 'medium' / 'low'
  test('qualityPreset applies its graph-shape fields and bumps graphVersion', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion
    ctx.qualityPreset = 'medium'
    const medium = {
      accurateSunSkyLight: ctx.accurateSunSkyLight,
      bumped: ctx.graphVersion > v0,
      flag: ctx.graphFlags().accurateSunSkyLight
    }
    // A user edit a preset must reset
    ctx.multiScatteringOctaves = 4
    const v1 = ctx.graphVersion
    ctx.qualityPreset = 'high'
    const high = {
      accurateSunSkyLight: ctx.accurateSunSkyLight,
      octaves: ctx.multiScatteringOctaves,
      bumped: ctx.graphVersion > v1
    }
    const v2 = ctx.graphVersion
    // Same preset again: nothing to rebuild
    ctx.qualityPreset = 'high'
    log('preset-graph-fields', {
      mediumAccurate: medium.accurateSunSkyLight,
      mediumBumped: medium.bumped,
      highAccurate: high.accurateSunSkyLight,
      highOctaves: high.octaves,
      highBumped: high.bumped,
      reapplyBumped: ctx.graphVersion > v2
    })
    expect(medium).toEqual({
      accurateSunSkyLight: false,
      bumped: true,
      flag: false
    })
    expect(high).toEqual({
      accurateSunSkyLight: true,
      octaves: 8,
      bumped: true
    })
    expect(ctx.graphVersion).toBe(v2)
  })

  test('qualityPreset = "low" writes the low table', () => {
    const ctx = new CloudsContext()
    ctx.qualityPreset = 'low'

    expect(ctx.lightShafts).toBe(false)
    expect(ctx.shapeDetail).toBe(false)
    expect(ctx.turbulence).toBe(false)
    expect(ctx.clouds.accurateSunSkyLight).toBe(false)
    expect(ctx.clouds.maxIterationCount).toBe(200)
    expect(ctx.clouds.minStepSize).toBe(100)
    expect(ctx.clouds.maxRayDistance).toBe(1e5)
    expect(ctx.clouds.minDensity).toBe(1e-4)
    expect(ctx.clouds.minTransmittance).toBe(1e-1)
    expect(ctx.clouds.maxIterationCountToGround).toBe(0)
    expect(ctx.clouds.maxIterationCountToSun).toBe(1)
    expect(ctx.shadow.maxIterationCount).toBe(25)
    expect(ctx.shadow.cascadeCount).toBe(2)
    expect(ctx.shadow.mapSize.x).toBe(256)
  })

  test.each([
    {
      field: 'accurateSunSkyLight' as const,
      expected: false,
      write: (context: CloudsContext) => {
        context.clouds.accurateSunSkyLight = false
      }
    },
    {
      field: 'accuratePhaseFunction' as const,
      expected: true,
      write: (context: CloudsContext) => {
        context.clouds.accuratePhaseFunction = true
      }
    },
    {
      field: 'multiScatteringOctaves' as const,
      expected: 4,
      write: (context: CloudsContext) => {
        context.clouds.multiScatteringOctaves = 4
      }
    }
  ])(
    '$field shorthand writes update the effective graph exactly once',
    entry => {
      const context = new CloudsContext()
      const initialVersion = context.graphVersion
      const reset = vi.fn()
      context.registerResetHistory(reset)

      entry.write(context)
      expect(context[entry.field]).toBe(entry.expected)
      expect(context.clouds[entry.field]).toBe(entry.expected)
      expect(context.graphFlags()[entry.field]).toBe(entry.expected)
      expect(Object.keys(context.clouds)).toContain(entry.field)
      expect(
        JSON.parse(JSON.stringify(context.clouds)) as Record<string, unknown>
      ).toHaveProperty(entry.field, entry.expected)
      expect(context.graphVersion).toBe(initialVersion + 1)
      const resetsAfterChange = reset.mock.calls.length
      entry.write(context)
      expect(context.graphVersion).toBe(initialVersion + 1)
      expect(reset).toHaveBeenCalledTimes(resetsAfterChange)
      expect(context.qualityPreset).toBe('high')
      log('shorthand-graph-write', {
        field: entry.field,
        actual: context.graphFlags()[entry.field],
        expected: entry.expected,
        actualGraphVersion: context.graphVersion,
        expectedGraphVersion: initialVersion + 1
      })

      context.qualityPreset = 'high'
      expect(context.clouds[entry.field]).toBe(defaults.clouds[entry.field])
      expect(context[entry.field]).toBe(defaults.clouds[entry.field])
    }
  )

  test('reapplying a preset restores overrides and unchanged application is inert', () => {
    const context = new CloudsContext()
    const reset = vi.fn()
    context.registerResetHistory(reset)
    applyQualityPreset(context, 'low')
    context.clouds.accurateSunSkyLight = true
    context.clouds.multiScatteringOctaves = 4
    context.clouds.maxIterationCount = 17
    context.shadow.mapSize.set(123, 456)

    expect(context.qualityPreset).toBe('low')
    applyQualityPreset(context, 'low')
    expect(context.qualityPreset).toBe('low')
    expect(context.accurateSunSkyLight).toBe(false)
    expect(context.multiScatteringOctaves).toBe(8)
    expect(context.clouds.maxIterationCount).toBe(200)
    expect(context.shadow.mapSize).toEqual(new Vector2(256, 256))
    const restoredVersion = context.graphVersion
    const restoredResets = reset.mock.calls.length
    context.qualityPreset = 'low'
    applyQualityPreset(context, 'low')
    expect(context.graphVersion).toBe(restoredVersion)
    expect(reset).toHaveBeenCalledTimes(restoredResets)
    log('preset-reapplication', {
      actualPreset: context.qualityPreset,
      expectedPreset: 'low',
      actualGraphVersion: context.graphVersion,
      expectedGraphVersion: restoredVersion,
      actualResetCount: reset.mock.calls.length,
      expectedResetCount: restoredResets
    })
  })

  test('graphFlags returns current graph-time flag snapshot', () => {
    const ctx = new CloudsContext()
    const flags = ctx.graphFlags()
    expect(flags.shapeDetail).toBe(true)
    expect(flags.turbulence).toBe(true)
    expect(flags.lightShafts).toBe(true)
    expect(flags.haze).toBe(true)
    expect(flags.temporalUpscale).toBe(true)
    expect(flags.accurateSunSkyLight).toBe(true)
    expect(flags.multiScatteringOctaves).toBe(8)
    expect(typeof flags.localWeatherChannels).toBe('string')

    ctx.qualityPreset = 'low'
    const lowFlags = ctx.graphFlags()
    expect(lowFlags.shapeDetail).toBe(false)
    expect(lowFlags.turbulence).toBe(false)
    expect(lowFlags.lightShafts).toBe(false)
  })

  test('graphFlags reflects each Phase 1 flag flip independently', () => {
    const flagTable: Array<{
      flag: string
      set: (ctx: CloudsContext) => void
      check: (flags: ReturnType<CloudsContext['graphFlags']>) => unknown
      expected: unknown
    }> = [
      {
        flag: 'shapeDetail',
        set: ctx => {
          ctx.shapeDetail = false
        },
        check: f => f.shapeDetail,
        expected: false
      },
      {
        flag: 'turbulence',
        set: ctx => {
          ctx.turbulence = false
        },
        check: f => f.turbulence,
        expected: false
      },
      {
        flag: 'accurateSunSkyLight',
        set: ctx => {
          ctx.accurateSunSkyLight = false
        },
        check: f => f.accurateSunSkyLight,
        expected: false
      },
      {
        flag: 'multiScatteringOctaves',
        set: ctx => {
          ctx.multiScatteringOctaves = 4
        },
        check: f => f.multiScatteringOctaves,
        expected: 4
      }
    ]

    const rows: Array<{
      flag: string
      versionBumped: boolean
      flagChanged: boolean
    }> = []

    for (const { flag, set, check, expected } of flagTable) {
      const ctx = new CloudsContext()
      const v0 = ctx.graphVersion
      set(ctx)
      const flags = ctx.graphFlags()
      rows.push({
        flag,
        versionBumped: ctx.graphVersion > v0,
        flagChanged: check(flags) === expected
      })
    }

    console.table(rows)

    for (const row of rows) {
      expect(row.versionBumped, `${row.flag}: graphVersion should bump`).toBe(
        true
      )
      expect(
        row.flagChanged,
        `${row.flag}: graphFlags should reflect change`
      ).toBe(true)
    }
  })

  test('debug setter bumps graphVersion and reflects in graphFlags', () => {
    const ctx = new CloudsContext()
    const v0 = ctx.graphVersion
    expect(ctx.debug).toBe('none')
    ctx.debug = 'shadowMap'
    expect(ctx.graphVersion).toBe(v0 + 1)
    expect(ctx.graphFlags().debug).toBe('shadowMap')
    ctx.debug = 'shadowMap'
    expect(ctx.graphVersion).toBe(v0 + 1)
  })

  test('qualityPreset = "high" restores defaults', () => {
    const ctx = new CloudsContext()
    ctx.qualityPreset = 'low'
    ctx.qualityPreset = 'high'

    expect(ctx.resolutionScale).toBe(defaults.resolutionScale)
    expect(ctx.lightShafts).toBe(defaults.lightShafts)
    expect(ctx.shapeDetail).toBe(defaults.shapeDetail)
    expect(ctx.clouds.maxIterationCount).toBe(defaults.clouds.maxIterationCount)
    expect(ctx.shadow.cascadeCount).toBe(defaults.shadow.cascadeCount)
    expect(ctx.shadow.mapSize.x).toBe(512)
  })

  test('ellipsoid defaults to WGS84', () => {
    const ctx = new CloudsContext()
    expect(ctx.ellipsoid).toBe(Ellipsoid.WGS84)
  })

  test('sunAngularRadius defaults to atmosphere value', () => {
    const ctx = new CloudsContext()
    expect(ctx.sunAngularRadius).toBeCloseTo(0.004675, 6)
  })

  test('clouds.* keys match cloudsUniformKeys + cloudsMaterialParameterKeys', () => {
    const ctx = new CloudsContext()
    const expected = new Set([
      ...cloudsUniformKeys,
      ...cloudsMaterialParameterKeys
    ])
    const actual = new Set(Object.keys(ctx.clouds))
    const rows = [...expected].map(key => ({
      key,
      present: actual.has(key)
    }))
    console.table(rows)
    for (const key of expected) {
      expect(actual.has(key), `clouds.${key} missing`).toBe(true)
    }
  })

  test('shadow.* keys match shadow key lists', () => {
    const ctx = new CloudsContext()
    const expected = new Set([
      ...shadowUniformKeys,
      ...shadowMaterialParameterKeys,
      ...shadowPassParameterKeys,
      ...shadowMapsParameterKeys
    ])
    const actual = new Set(Object.keys(ctx.shadow))
    const rows = [...expected].map(key => ({
      key,
      present: actual.has(key)
    }))
    console.table(rows)
    for (const key of expected) {
      expect(actual.has(key), `shadow.${key} missing`).toBe(true)
    }
  })

  test('Phase 0–1 PARITY_KEYS all exist on CloudsContext', () => {
    const PHASE_1_KEYS: Array<{
      key: string
      nested?: 'clouds' | 'shadow'
    }> = [
      { key: 'coverage' },
      { key: 'scatteringCoefficient' },
      { key: 'absorptionCoefficient' },
      { key: 'turbulenceDisplacement' },
      { key: 'skyLightScale' },
      { key: 'powderScale' },
      { key: 'powderExponent' },
      { key: 'correctAltitude' },
      { key: 'resolutionScale' },
      { key: 'shapeDetail' },
      { key: 'turbulence' },
      { key: 'localWeatherRepeat' },
      { key: 'localWeatherOffset' },
      { key: 'shapeRepeat' },
      { key: 'shapeOffset' },
      { key: 'shapeDetailRepeat' },
      { key: 'shapeDetailOffset' },
      { key: 'turbulenceRepeat' },
      { key: 'localWeatherVelocity' },
      { key: 'shapeVelocity' },
      { key: 'shapeDetailVelocity' },
      { key: 'maxIterationCount', nested: 'clouds' },
      { key: 'minStepSize', nested: 'clouds' },
      { key: 'maxStepSize', nested: 'clouds' },
      { key: 'maxRayDistance', nested: 'clouds' },
      { key: 'perspectiveStepScale', nested: 'clouds' },
      { key: 'minDensity', nested: 'clouds' },
      { key: 'minExtinction', nested: 'clouds' },
      { key: 'minTransmittance', nested: 'clouds' },
      { key: 'maxIterationCountToSun', nested: 'clouds' },
      { key: 'maxIterationCountToGround', nested: 'clouds' },
      { key: 'minSecondaryStepSize', nested: 'clouds' },
      { key: 'secondaryStepScale', nested: 'clouds' },
      { key: 'multiScatteringOctaves', nested: 'clouds' },
      { key: 'accurateSunSkyLight', nested: 'clouds' }
    ]

    const ctx = new CloudsContext() as unknown as Record<string, unknown>
    const rows = PHASE_1_KEYS.map(({ key, nested }) => {
      const target =
        nested != null ? (ctx[nested] as Record<string, unknown>) : ctx
      return { key, nested: nested ?? '', exists: target[key] !== undefined }
    })
    console.table(rows)

    for (const { key, nested } of PHASE_1_KEYS) {
      const target =
        nested != null ? (ctx[nested] as Record<string, unknown>) : ctx
      expect(
        target[key],
        `${nested ? nested + '.' : ''}${key} missing`
      ).not.toBeUndefined()
    }
  })

  describe('updateCamera', () => {
    setCurrentSpec('CloudsContext_updateCamera')

    function cameraAtECEF(ecef: Vector3): PerspectiveCamera {
      const cam = new PerspectiveCamera(60, 16 / 9, 0.5, 5000)
      cam.position.copy(ecef)
      cam.lookAt(0, 0, 0)
      cam.updateMatrixWorld(true)
      return cam
    }

    test('cameraHeight at 8 km equals Geodetic height (±0.01 m)', () => {
      const ctx = new CloudsContext()
      const geo = new Geodetic(0, 0, 8000)
      const ecef = geo.toECEF(new Vector3())
      const cam = cameraAtECEF(ecef)

      ctx.updateCamera(cam)

      log('updateCamera', {
        test: 'cameraHeight_8km',
        cameraHeight: ctx.cameraHeight,
        expected: 8000,
        diff: Math.abs(ctx.cameraHeight - 8000)
      })
      expect(ctx.cameraHeight).toBeCloseTo(8000, 2)
    })

    // the reference rotates the sun direction only (applyMatrix3,
    // CloudsEffect.ts:389-395). applyMatrix4 added the translation, pointing
    // the sun at the anchor in any frame not centred on the earth

    // No ladder case has a translated frame, so the test supplies one
    test('sun direction is rotated, not translated, into world space', () => {
      const ctx = new CloudsContext()
      const cam = cameraAtECEF(new Geodetic(0, 0, 8000).toECEF(new Vector3()))
      ctx.updateCamera(cam)
      ctx.shadowMaps = new CascadedShadowMaps({
        cascadeCount: 1,
        mapSize: new Vector2(256, 256)
      })

      const sun = new Vector3(0, 0, 1)
      ctx.sunDirection.copy(sun)

      // A frame with a large translation and no rotation: the sun direction
      // must come through unchanged
      const anchor = new Vector3(6378137, 0, 0)
      ctx.ecefToWorldMatrix.makeTranslation(anchor.x, anchor.y, anchor.z)
      ctx.worldToECEFMatrix.copy(ctx.ecefToWorldMatrix).invert()

      const captured = new Vector3()
      ctx.shadowMaps.update = vi.fn((_c, dir: Vector3) => {
        captured.copy(dir)
      })

      ctx.updateShadowMaps(cam)

      log('sunDirectionWorld', {
        expected: sun.toArray().join(', '),
        actual: captured
          .toArray()
          .map(v => +v.toFixed(6))
          .join(', '),
        angleErrorDeg:
          (Math.acos(Math.min(1, captured.dot(sun))) * 180) / Math.PI
      })
      // Translation-free: identical to the input direction
      expect(captured.x).toBeCloseTo(sun.x, 6)
      expect(captured.y).toBeCloseTo(sun.y, 6)
      expect(captured.z).toBeCloseTo(sun.z, 6)
    })

    test('try-catch path: origin keeps previous value', () => {
      const ctx = new CloudsContext()
      const geo = new Geodetic(0, 0, 8000)
      const ecef = geo.toECEF(new Vector3())
      const cam = cameraAtECEF(ecef)
      ctx.updateCamera(cam)
      expect(ctx.cameraHeight).toBeCloseTo(8000, 2)

      const originCam = cameraAtECEF(new Vector3(0, 0, 0))
      ctx.updateCamera(originCam)

      log('updateCamera', {
        test: 'origin_keeps_previous',
        cameraHeight: ctx.cameraHeight,
        expected: 8000
      })
      expect(ctx.cameraHeight).toBeCloseTo(8000, 2)
    })

    test('correctAltitude on/off toggles the correction vector', () => {
      const ctx = new CloudsContext()
      const geo = new Geodetic(0, Math.PI / 4, 8000)
      const ecef = geo.toECEF(new Vector3())
      const cam = cameraAtECEF(ecef)

      ctx.correctAltitude = true
      ctx.updateCamera(cam)
      const correctionOn = ctx.altitudeCorrection.length()

      ctx.correctAltitude = false
      ctx.updateCamera(cam)
      const correctionOff = ctx.altitudeCorrection.length()

      log('updateCamera', {
        test: 'correctAltitude_toggle',
        correctionOn,
        correctionOff,
        latitude: 'PI/4'
      })
      expect(correctionOn).toBeGreaterThan(0)
      expect(correctionOff).toBe(0)
    })

    test('non-identity worldToECEFMatrix round-trips through ecefToWorld', () => {
      const ctx = new CloudsContext()
      const rotation = new Matrix4().makeRotationY(Math.PI / 6)
      ctx.worldToECEFMatrix.copy(rotation)

      const geo = new Geodetic(0, 0, 8000)
      const ecef = geo.toECEF(new Vector3())
      const cam = cameraAtECEF(ecef)

      ctx.updateCamera(cam)

      const worldPos = new Vector3().copy(ecef)
      const ecefPos = new Vector3()
        .copy(worldPos)
        .applyMatrix4(ctx.worldToECEFMatrix)
      const roundTrip = new Vector3()
        .copy(ecefPos)
        .applyMatrix4(ctx.ecefToWorldMatrix)

      const delta = roundTrip.distanceTo(worldPos)

      log('updateCamera', {
        test: 'worldToECEF_roundtrip',
        worldPos: `${worldPos.x.toFixed(2)},${worldPos.y.toFixed(2)},${worldPos.z.toFixed(2)}`,
        roundTrip: `${roundTrip.x.toFixed(2)},${roundTrip.y.toFixed(2)},${roundTrip.z.toFixed(2)}`,
        delta
      })
      expect(delta).toBeLessThan(1e-3)
    })

    test('ecefToWorldMatrix is the inverse of worldToECEFMatrix', () => {
      const ctx = new CloudsContext()
      const rotation = new Matrix4()
        .makeRotationY(0.3)
        .setPosition(100, 200, 300)
      ctx.worldToECEFMatrix.copy(rotation)

      const cam = cameraAtECEF(new Geodetic(0, 0, 8000).toECEF(new Vector3()))
      ctx.updateCamera(cam)

      const product = new Matrix4()
        .copy(ctx.worldToECEFMatrix)
        .multiply(ctx.ecefToWorldMatrix)
      const identity = new Matrix4()
      const maxDiff = Math.max(
        ...product.elements.map((v, i) => Math.abs(v - identity.elements[i]!))
      )

      log('updateCamera', {
        test: 'inverse_check',
        maxElementDiff: maxDiff
      })
      expect(maxDiff).toBeLessThan(1e-10)
    })
  })

  test('NOT-ported WebGL-only keys are absent', () => {
    const NOT_PORTED = [
      'irradianceTexture',
      'scatteringTexture',
      'transmittanceTexture',
      'singleMieScatteringTexture',
      'higherOrderScatteringTexture',
      'events',
      'atmosphereOverlay',
      'atmosphereShadow',
      'atmosphereShadowLength',
      'shadowPass',
      'cloudsPass',
      'resolution',
      'initialize',
      'setSize',
      'setDepthTexture'
    ]

    const ctx = new CloudsContext() as unknown as Record<string, unknown>
    const rows = NOT_PORTED.map(key => ({
      key,
      absent: ctx[key] === undefined
    }))
    console.table(rows)

    for (const key of NOT_PORTED) {
      expect(ctx[key], `${key} should not be ported`).toBeUndefined()
    }
  })

  // each slot takes a baked texture or a
  // generator (CloudsEffect.ts:518-580). Wrong routing is invisible, the clouds
  // just render from the wrong source
  describe('texture slots accept a texture or a generator', () => {
    it('round-trips a generator as the generator, not as its texture', async () => {
      const { CloudShape } = await import('./textures/generators')
      const ctx = new CloudsContext()
      const gen = new CloudShape()

      ctx.shapeTexture = gen

      // The getter hands back what was set, so a caller can still drive it
      expect(ctx.shapeTexture).toBe(gen)
      // The uniforms bind the underlying texture, never the generator
      expect(ctx.resolvedShapeTexture).toBe(gen.texture)
      gen.dispose()
    })

    it('round-trips a plain texture unchanged', () => {
      const ctx = new CloudsContext()
      const tex = new Data3DTexture()
      ctx.shapeTexture = tex
      expect(ctx.shapeTexture).toBe(tex)
      expect(ctx.resolvedShapeTexture).toBe(tex)
    })

    it('clears the generator when a plain texture replaces it', async () => {
      const { CloudShape } = await import('./textures/generators')
      const ctx = new CloudsContext()
      const gen = new CloudShape()
      const tex = new Data3DTexture()

      ctx.shapeTexture = gen
      ctx.shapeTexture = tex

      // If the generator survived, renderProceduralTextures would keep filling
      // a volume nothing samples, and the getter would lie about the source
      expect(ctx.shapeTexture).toBe(tex)
      expect(ctx.resolvedShapeTexture).toBe(tex)
      gen.dispose()
    })

    it('drives only the slots holding a generator', async () => {
      const { CloudShape } = await import('./textures/generators')
      const ctx = new CloudsContext()
      const gen = new CloudShape()
      ctx.shapeTexture = gen
      ctx.localWeatherTexture = new Texture()

      const renderer = { compute: vi.fn() }
      ctx.renderProceduralTextures(renderer as never)
      expect(renderer.compute).toHaveBeenCalledTimes(1)

      // Second call is a no-op: each generator clears its own needsRender, so
      // this is cheap to call every frame as the reference does
      ctx.renderProceduralTextures(renderer as never)
      expect(renderer.compute).toHaveBeenCalledTimes(1)
      gen.dispose()
    })
  })
})
