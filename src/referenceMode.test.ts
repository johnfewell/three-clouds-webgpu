// Reference mode's contract: the pin values, the write set, and the way back

import { describe, expect, test } from 'vitest'

import { table } from '../test/helpers/cpuTwin'
import { log } from '../test/helpers/log'
import { CloudsContext } from './CloudsContext'
import { cloudShapeDefaults } from './experimental/cloudShape'
import { experimentalDefaults } from './experimental/options'
import { defaults } from './qualityPresets'
import {
  applyPortDefaults,
  applyReferenceMode,
  PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION,
  REFERENCE_CLOUD_SHAPE,
  REFERENCE_MODE,
  REFERENCE_MODE_PORT_ONLY_PATHS,
  REFERENCE_SHADOW_UPDATE_INTERVAL,
  referenceModePins
} from './referenceMode'

// A recording stand-in for the three write paths, so the test can compare the
// writes against the declared path list in both directions
interface Written {
  readonly paths: string[]
}

function recordingContext(written: Written): CloudsContext {
  const ctx = new CloudsContext()
  const originalShadow = ctx.shadow
  let shadow: { updateInterval: number } = { updateInterval: 0 }
  const proxyShadow = new Proxy(originalShadow, {
    set(target, key, value) {
      if (key === 'updateInterval') {
        written.paths.push('shadow.updateInterval')
        shadow = { updateInterval: value as number }
        return true
      }
      return Reflect.set(target, key, value)
    },
    get(target, key) {
      return key === 'updateInterval'
        ? shadow.updateInterval
        : Reflect.get(target, key)
    }
  })
  return new Proxy(ctx, {
    get(target, key, receiver) {
      if (key === 'shadow') return proxyShadow
      return Reflect.get(target, key, receiver)
    },
    set(target, key, value, receiver) {
      if (key === 'lightShaftsHalfResolution') {
        written.paths.push('lightShaftsHalfResolution')
        return Reflect.set(target, key, value, receiver)
      }
      if (key === 'cloudShape') {
        written.paths.push('cloudShape')
      }
      if (key === 'experimental') {
        const partial = value as Record<string, boolean>
        for (const name of Object.keys(partial)) {
          written.paths.push(`experimental.${name}`)
        }
      }
      return Reflect.set(target, key, value, receiver)
    }
  })
}

describe('reference mode pins', () => {
  test('the pins are the original behaviour, not the port defaults', () => {
    // The port's own defaults, so a change to either one fails here rather
    // than silently redefining what reference mode means
    expect(defaults.shadow.updateInterval).not.toBe(
      REFERENCE_SHADOW_UPDATE_INTERVAL
    )
    expect(PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION).toBe(true)
    expect(REFERENCE_MODE.shadowUpdateInterval).toBe(1)
    expect(REFERENCE_MODE.lightShaftsHalfResolution).toBe(false)
    // Not the library defaults: one promoted option is the live case, and the
    // dedicated guard below holds the whole set
    expect(experimentalDefaults.distantShapeDetailFade).not.toBe(
      REFERENCE_MODE.experimental.distantShapeDetailFade
    )

    const ctx = new CloudsContext()
    // The context starts on the port's defaults, which reference mode moves
    expect(ctx.shadow.updateInterval).toBe(defaults.shadow.updateInterval)
    expect(ctx.lightShaftsHalfResolution).toBe(true)
    table('reference-mode-pins', [
      {
        path: 'shadow.updateInterval',
        port: ctx.shadow.updateInterval,
        reference: REFERENCE_MODE.shadowUpdateInterval
      },
      {
        path: 'lightShaftsHalfResolution',
        port: ctx.lightShaftsHalfResolution,
        reference: REFERENCE_MODE.lightShaftsHalfResolution
      },
      ...Object.keys(experimentalDefaults).map(k => ({
        path: `experimental.${k}`,
        port: ctx.experimental[k as keyof typeof ctx.experimental],
        reference:
          REFERENCE_MODE.experimental[
            k as keyof typeof REFERENCE_MODE.experimental
          ]
      }))
    ])
  })

  test('the pins are frozen, so a consumer cannot mutate them', () => {
    expect(Object.isFrozen(REFERENCE_MODE)).toBe(true)
    expect(Object.isFrozen(REFERENCE_MODE.experimental)).toBe(true)
    expect(Object.isFrozen(REFERENCE_MODE_PORT_ONLY_PATHS)).toBe(true)
  })

  // The failure ruled out here: REFERENCE_MODE.experimental was a remembered
  // copy of the defaults, so promoting one moved every parity capture while the
  // pin reports still read as pinned. Every assertion below fails on that shape
  test('a promoted default is off in reference mode, however the library ships it', () => {
    // the premise: the port default and the pin really are different values
    expect(experimentalDefaults.distantShapeDetailFade).toBe(true)
    expect(REFERENCE_MODE.experimental.distantShapeDetailFade).toBe(false)
    // the rule, not one value: the original has no experimental features, so
    // every option is off in reference mode whatever the library ships
    for (const [key, value] of Object.entries(REFERENCE_MODE.experimental)) {
      expect(value, `${key} is off in reference mode`).toBe(false)
    }
    // A remembered copy satisfies neither line, and this is what says so
    expect(REFERENCE_MODE.experimental).not.toEqual(experimentalDefaults)

    // and the two ends of it, on a real context: a library user gets the fade,
    // reference mode takes it away again
    const user = new CloudsContext()
    expect(user.experimental.distantShapeDetailFade).toBe(true)
    expect(applyReferenceMode(user)).toBe(true)
    expect(user.experimental.distantShapeDetailFade).toBe(false)
    expect(applyPortDefaults(user)).toBe(true)
    expect(user.experimental.distantShapeDetailFade).toBe(true)

    log('reference-mode-promoted-default', { portDefault: true, pinned: false })
  })

  test('applyReferenceMode writes every declared port-only path and nothing else', () => {
    const written: Written = { paths: [] }
    const ctx = recordingContext(written)
    // The shape controls ship neutral, which is the reference value, so
    // reference mode has nothing to write unless a caller moved one first
    ctx.cloudShape = { ...cloudShapeDefaults, erosionShape: 0.5 }
    written.paths.length = 0
    applyReferenceMode(ctx)

    const unique = [...new Set(written.paths)].sort()
    expect(unique).toEqual([...REFERENCE_MODE_PORT_ONLY_PATHS].sort())
    // Every experiment is pinned, not just the ones that happened to be true
    expect(unique.filter(p => p.startsWith('experimental.'))).toHaveLength(
      Object.keys(experimentalDefaults).length
    )
    log('reference-mode-writes', {
      writes: written.paths.length,
      paths: unique
    })
  })

  test('applyReferenceMode leaves the context on the reference values', () => {
    const ctx = new CloudsContext()
    ctx.experimental = { computeResolve: true, windReprojection: true }
    ctx.cloudShape = { ...cloudShapeDefaults, baseShadowStrength: 1.2 }
    expect(applyReferenceMode(ctx)).toBe(true)
    expect(referenceModePins(ctx)).toEqual({
      shadowUpdateInterval: REFERENCE_MODE.shadowUpdateInterval,
      lightShaftsHalfResolution: REFERENCE_MODE.lightShaftsHalfResolution,
      experimental: { ...REFERENCE_MODE.experimental },
      cloudShape: { ...REFERENCE_CLOUD_SHAPE }
    })
    // and again, for idempotence
    expect(applyReferenceMode(ctx)).toBe(false)
    expect(referenceModePins(ctx).experimental).toEqual(
      REFERENCE_MODE.experimental
    )
    log('reference-mode-idempotent', { changed: true, secondCall: false })
  })

  test('applyPortDefaults reads the library defaults rather than restating them', () => {
    const ctx = new CloudsContext()
    applyReferenceMode(ctx)
    expect(applyPortDefaults(ctx)).toBe(true)
    expect(ctx.shadow.updateInterval).toBe(defaults.shadow.updateInterval)
    expect(ctx.lightShaftsHalfResolution).toBe(
      PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION
    )
    // The way back reaches a promoted default: reference mode held it away from
    // the library's value, so leaving it would ship the pin to ordinary users
    expect(ctx.experimental.distantShapeDetailFade).toBe(
      experimentalDefaults.distantShapeDetailFade
    )
    expect(applyPortDefaults(ctx)).toBe(false)
    log('reference-mode-exit', { interval: ctx.shadow.updateInterval })
  })

  // The way back still leaves an option a caller set for itself alone, which is
  // the other half of the rule above: only what reference mode moved is restored
  test('applyPortDefaults leaves a caller-set option alone', () => {
    const ctx = new CloudsContext()
    applyReferenceMode(ctx)
    ctx.experimental = { computeResolve: true }
    applyPortDefaults(ctx)
    expect(ctx.experimental.computeResolve).toBe(true)
    expect(ctx.experimental.distantShapeDetailFade).toBe(
      experimentalDefaults.distantShapeDetailFade
    )
    log('reference-mode-exit-caller', { computeResolve: true })
  })

  // The failure guarded: a default change redefining what the pins mean. A
  // hardcoded interval strands the context at 1, so the ladder keeps measuring
  // the reference while the product ships something else
  test('moving the library default moves applyPortDefaults with it', () => {
    const original = defaults.shadow.updateInterval
    const ctx = new CloudsContext()
    applyReferenceMode(ctx)
    try {
      defaults.shadow.updateInterval = 7
      applyPortDefaults(ctx)
      expect(ctx.shadow.updateInterval).toBe(7)
      // reference mode is unaffected: it is the original's cadence, not a default
      applyReferenceMode(ctx)
      expect(ctx.shadow.updateInterval).toBe(REFERENCE_SHADOW_UPDATE_INTERVAL)
    } finally {
      defaults.shadow.updateInterval = original
    }
    log('reference-mode-default-drift', { moved: 7, pinned: 1 })
  })

  test('an experimental key outside the interface is refused, so a typo cannot pass', () => {
    const ctx = new CloudsContext()
    expect(() => {
      ;(ctx as unknown as { experimental: unknown }).experimental = {
        notAnOption: true
      }
    }).toThrow(TypeError)
  })
})
