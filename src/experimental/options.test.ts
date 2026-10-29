import { describe, expect, it, vi } from 'vitest'

import { log } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { experimentalDefaults } from './options'

describe('experimental cloud options', () => {
  it('ships the promoted set and rebuilds only for real changes', () => {
    const ctx = new CloudsContext()
    // Two options ship on, so the claim is that the
    // DEFAULT SET is the one the module declares, not that every value is false
    expect(ctx.experimental).toEqual({ ...experimentalDefaults })
    // NAMED, not a count: a third promotion has to be written here, so it cannot
    // arrive by editing one boolean in options.ts
    const promoted = ['distantShapeDetailFade', 'cloudFrontRefinement'] as const
    const onByDefault = Object.entries(ctx.experimental)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort()
    expect(onByDefault).toEqual([...promoted].sort())
    const before = ctx.graphVersion
    const reset = vi.fn()
    ctx.registerResetHistory(reset)
    // Setting an option to the value it already has is not a change
    ctx.experimental = {
      distantShapeDetailFade: true,
      cloudFrontRefinement: true
    }
    expect(ctx.graphVersion).toBe(before)
    expect(reset).not.toHaveBeenCalled()
    ctx.experimental = { cloudFrontRefinement: false }
    expect(ctx.graphVersion).toBe(before + 1)
    ctx.experimental = { cloudFrontRefinement: false }
    expect(ctx.graphVersion).toBe(before + 1)
    ctx.experimental = { distantCloudShadows: true }
    expect(ctx.experimental.cloudFrontRefinement).toBe(false)
    expect(Object.isFrozen(ctx.experimental)).toBe(true)
    expect(reset).toHaveBeenCalledTimes(2)
    log('experimental options', {
      before,
      after: ctx.graphVersion,
      onByDefault: onByDefault.length
    })
  })

  it('rejects unknown options and invalid values without changing state', () => {
    const ctx = new CloudsContext()
    expect(() => {
      ctx.experimental = { windReprojection: undefined }
    }).toThrow(TypeError)
    expect(() => {
      ctx.experimental = JSON.parse('{"unknown":true}')
    }).toThrow(TypeError)
    expect(() => {
      ctx.experimental = JSON.parse('{"constructor":true}')
    }).toThrow(TypeError)
    expect(ctx.experimental.windReprojection).toBe(false)
  })
})
