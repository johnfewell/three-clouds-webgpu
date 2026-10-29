import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import { CloudsContext, type DebugView } from '../CloudsContext'
import {
  experimentalDefaults,
  experimentalWarnings,
  type ExperimentalWarningInput
} from './options'

// Read out of the source rather than hand-listed: a new DebugView member then
// joins the computeResolve check with no second edit, and a renamed one cannot
// leave the list asserting a type that no longer exists
const ALL_DEBUG_VIEWS = [
  ...readFileSync(resolve(import.meta.dirname, '../CloudsContext.ts'), 'utf8')
    .match(/export type DebugView =([\s\S]*?)\n\n/)![1]!
    .matchAll(/'([^']+)'/g)
].map(match => match[1]!) as DebugView[]

/** One option on, the rest at their shipped defaults */
function only<K extends keyof typeof experimentalDefaults>(
  key: K
): ExperimentalWarningInput['experimental'] {
  return { ...experimentalDefaults, [key]: true }
}

/** All three warnable options on at once */
const ALL_THREE = {
  ...experimentalDefaults,
  computeResolve: true,
  windReprojection: true,
  distantCloudShadows: true
}

// Drives the checks through the real context, so a rename of a field the
// checks read is a type error here rather than a silently stale check
function input(
  overrides: Partial<ExperimentalWarningInput> = {}
): ExperimentalWarningInput {
  const ctx = new CloudsContext()
  return {
    experimental: ctx.experimental,
    debug: ctx.debug,
    castsShadow: ctx.cloudLayers.castsShadow,
    localWeatherVelocity: ctx.localWeatherVelocity,
    lightShafts: ctx.lightShafts,
    ...overrides
  }
}

function ids(input: ExperimentalWarningInput): string[] {
  return experimentalWarnings(input).map(warning => warning.id)
}

describe('experimental warnings', () => {
  it('is silent when no experimental option is on', () => {
    expect(experimentalWarnings(input())).toEqual([])
  })

  describe('windReprojection', () => {
    // The design doc calls this the single highest-value change available:
    // an ordinary user animating weather gets a feature that silently does
    // nothing, forever (docs/design/standalone-defaults.md 4.3)
    it('warns when weather velocity makes every frame reject the history', () => {
      const velocity = new CloudsContext().localWeatherVelocity
      velocity.set(1, 0)
      const warnings = experimentalWarnings(
        input({
          experimental: only('windReprojection'),
          localWeatherVelocity: velocity
        })
      )
      log('windReprojection', {
        velocityNonZero: true,
        warnings: warnings.map(w => w.id)
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.id).toBe('windReprojection/localWeatherVelocity')
      expect(warnings[0]!.message).toContain('localWeatherVelocity')
    })

    it('stays silent at zero velocity, where the option does work', () => {
      const warnings = experimentalWarnings(
        input({
          experimental: only('windReprojection')
        })
      )
      expect(warnings).toEqual([])
    })

    it('stays silent when the option is off, whatever the velocity', () => {
      const velocity = new CloudsContext().localWeatherVelocity
      velocity.set(0, -3)
      expect(ids(input({ localWeatherVelocity: velocity }))).toEqual([])
    })

    // A tiny non-zero velocity still advances the offset, so the threshold is
    // exact rather than an epsilon. Reading it as an epsilon would leave the
    // worst case (a slow drift) unwarned
    it('treats a very small non-zero velocity as non-zero', () => {
      const velocity = new CloudsContext().localWeatherVelocity
      velocity.set(1e-9, 0)
      expect(
        ids(
          input({
            experimental: only('windReprojection'),
            localWeatherVelocity: velocity
          })
        )
      ).toEqual(['windReprojection/localWeatherVelocity'])
    })
  })

  describe('distantCloudShadows', () => {
    // Layers 0 and 1 ship with shadow: true (src/CloudLayers.ts:68,80), so the
    // default sky casts shadows and this warning is correctly silent
    it('stays silent on the shipped default layers, which do cast shadows', () => {
      const ctx = new CloudsContext()
      expect(ctx.cloudLayers.castsShadow).toBe(true)
      expect(ids(input({ experimental: only('distantCloudShadows') }))).toEqual(
        []
      )
    })

    it('warns once every layer has shadow turned off', () => {
      const ctx = new CloudsContext()
      for (const layer of ctx.cloudLayers) {
        layer.shadow = false
      }
      expect(ctx.cloudLayers.castsShadow).toBe(false)
      const warnings = experimentalWarnings(
        input({
          experimental: only('distantCloudShadows'),
          castsShadow: ctx.cloudLayers.castsShadow
        })
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.id).toBe('distantCloudShadows/noShadowCastingLayer')
    })

    it('stays silent while any one layer still casts shadows', () => {
      const ctx = new CloudsContext()
      for (const layer of ctx.cloudLayers) {
        layer.shadow = false
      }
      ctx.cloudLayers[2]!.shadow = true
      expect(
        ids(
          input({
            experimental: only('distantCloudShadows'),
            castsShadow: ctx.cloudLayers.castsShadow
          })
        )
      ).toEqual([])
    })

    it('reads castsShadow off the real layers, not a hand-set flag', () => {
      const ctx = new CloudsContext()
      const before = ctx.cloudLayers.castsShadow
      for (const layer of ctx.cloudLayers) {
        layer.shadow = false
      }
      expect(ctx.cloudLayers.castsShadow).not.toBe(before)
      ctx.cloudLayers[3]!.shadow = true
      expect(ctx.cloudLayers.castsShadow).toBe(true)
    })
  })

  describe('computeResolve', () => {
    // The compute path is skipped under a debug view
    // (src/CloudsPassNode.ts buildComputeResolveGraph), so the option reads as
    // on while doing nothing
    it.each([
      'cascades',
      'shadowMap',
      'uv',
      'sampleCount',
      'frontDepth',
      'shadowLength',
      'velocity',
      'marchIntervals'
    ] as const)('warns under the %s debug view', debug => {
      const warnings = experimentalWarnings(
        input({
          experimental: only('computeResolve'),
          debug
        })
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.id).toBe('computeResolve/debugView')
      // The message names the view, so the reader is told which one is on
      expect(warnings[0]!.message).toContain(debug)
    })

    it('stays silent under the none debug view', () => {
      expect(
        ids(
          input({
            experimental: only('computeResolve'),
            debug: 'none'
          })
        )
      ).toEqual([])
    })

    // A new DebugView that nobody thought about would silently escape the
    // warning. Driven off the DebugView type, so adding a member makes this
    // loop cover it without a second edit
    it('warns under every DebugView except none', () => {
      const views = ALL_DEBUG_VIEWS.filter(view => view !== 'none')
      // The list must not be trivially empty, or this test passes for free
      expect(views.length).toBeGreaterThan(3)
      const warned = views.map(debug =>
        ids(input({ experimental: only('computeResolve'), debug }))
      )
      for (const got of warned) {
        expect(got).toEqual(['computeResolve/debugView'])
      }
    })
  })

  it('reports every active problem at once, not just the first', () => {
    const velocity = new CloudsContext().localWeatherVelocity
    velocity.set(2, 0)
    const warnings = experimentalWarnings(
      input({
        experimental: ALL_THREE,
        debug: 'shadowMap',
        castsShadow: false,
        localWeatherVelocity: velocity
      })
    )
    log('all three at once', { ids: warnings.map(w => w.id) })
    expect(
      ids(
        input({
          experimental: ALL_THREE,
          debug: 'shadowMap',
          castsShadow: false,
          localWeatherVelocity: velocity
        })
      )
    ).toHaveLength(3)
  })

  it('gives every warning the library prefix and a stable id', () => {
    const velocity = new CloudsContext().localWeatherVelocity
    velocity.set(1, 1)
    const warnings = experimentalWarnings(
      input({
        experimental: ALL_THREE,
        debug: 'cloud',
        localWeatherVelocity: velocity
      })
    )
    table(
      'experimental-warning-messages',
      warnings.map(warning => ({
        id: warning.id,
        prefixed: warning.message.startsWith('three-clouds-webgpu:')
          ? 'yes'
          : 'NO'
      }))
    )
    for (const warning of warnings) {
      expect(warning.message).toMatch(/^three-clouds-webgpu:/)
      expect(warning.id).toMatch(/^[\w/]+$/)
    }
    // Two calls with the same input must not produce different ids, since the
    // emitter uses the id to warn once per problem
    expect(
      ids(
        input({
          experimental: ALL_THREE,
          debug: 'cloud',
          localWeatherVelocity: velocity
        })
      )
    ).toEqual(warnings.map(warning => warning.id))
  })
})
