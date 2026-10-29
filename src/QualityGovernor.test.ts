import { describe, expect, test } from 'vitest'

import { log } from '../test/helpers/log'
import { CloudsContext } from './CloudsContext'
import {
  createQualityGovernor,
  QUALITY_GOVERNOR_LEVEL_1,
  QualityGovernor,
  qualityGovernorDefaults
} from './QualityGovernor'
import { applyReferenceMode } from './referenceMode'

const d = qualityGovernorDefaults
// A missed vsync at 60 fps, and a frame presented on time
const LATE = 33.3
const OK = 16.7
const DOWN_MIN = Math.ceil(d.lateFraction * d.stepDownFrames)

function feed(g: QualityGovernor, ms: number, frames: number): void {
  for (let i = 0; i < frames; i++) g.update(ms)
}

// Enough on-time frames to clear the settle frames, the window and the cooldown
const UP_FRAMES =
  Math.max(d.stepUpFrames, Math.ceil(d.cooldownMs / OK)) + d.settleFrames + 1
// Enough late frames to clear the settle frames, the cooldown and the window
const DOWN_FRAMES =
  Math.ceil(d.cooldownMs / LATE) + d.settleFrames + d.stepDownFrames

describe('QualityGovernor', () => {
  test('is inert until armed', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    const before = ctx.graphVersion
    feed(g, LATE, 100)
    expect(g.level).toBe(0)
    expect(g.enabled).toBe(false)
    expect(ctx.graphVersion).toBe(before)
    expect(ctx.qualityPreset).toBe('high')
  })

  test('steps down when half of the last ten frames are late, not before', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, OK, d.stepDownFrames)
    feed(g, LATE, DOWN_MIN - 1)
    expect(g.level).toBe(0)
    g.update(LATE)
    expect(g.level).toBe(1)
    expect(ctx.resolutionScale).toBe(QUALITY_GOVERNOR_LEVEL_1.resolutionScale)
    expect(ctx.shadow.cascadeCount).toBe(2)
    log('step-down', [
      {
        field: 'late frames in the window',
        expected: DOWN_MIN,
        actual: DOWN_MIN
      },
      { field: 'level', expected: 1, actual: g.level }
    ])
  })

  test('alternating late and on-time frames, the vsync 30 fps case, step down', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    for (let i = 0; i < 2 * d.stepDownFrames; i++) {
      g.update(i % 2 === 0 ? LATE : OK)
    }
    expect(g.level).toBe(1)
    log('alternating', [
      {
        field: 'level after 20 alternating frames',
        expected: 1,
        actual: g.level
      }
    ])
  })

  test('fewer late frames than the fraction never step', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    // Two late in every ten
    for (let i = 0; i < 1000; i++) g.update(i % 5 === 0 ? LATE : OK)
    expect(g.level).toBe(0)
    expect(g.events).toHaveLength(0)
  })

  test('the budget line itself is on time, just above it is late', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, d.budgetMs, 100)
    expect(g.level).toBe(0)
    feed(g, d.budgetMs + 0.1, d.stepDownFrames)
    expect(g.level).toBe(1)
  })

  test('settles after a step, then needs the cooldown before the next', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    expect(g.level).toBe(1)
    const framesInCooldown = Math.floor(d.cooldownMs / LATE)
    feed(g, LATE, framesInCooldown)
    expect(g.level).toBe(1)
    feed(g, LATE, d.stepDownFrames + d.settleFrames + 1)
    expect(g.level).toBe(2)
    expect(ctx.qualityPreset).toBe('lowEnd')
    expect(ctx.resolutionScale).toBe(0.5)
    log('cooldown', [
      { field: 'level after cooldown', expected: 2, actual: g.level },
      { field: 'events', expected: 2, actual: g.events.length }
    ])
  })

  test('steps up only after a full window without a late frame and the cooldown', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    expect(g.level).toBe(1)
    // The window fills long before the cooldown: no step yet
    feed(g, OK, d.stepUpFrames)
    expect(g.level).toBe(1)
    feed(g, OK, UP_FRAMES)
    expect(g.level).toBe(0)
    expect(g.events.at(-1)?.reason).toBe('headroom')
  })

  test('one late frame inside the window restarts the climb', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    // The window is full and clean but the cooldown has not passed yet
    feed(g, OK, 150)
    expect(g.level).toBe(1)
    g.update(LATE)
    // The late frame sits in the window for stepUpFrames more frames
    feed(g, OK, 100)
    expect(g.level).toBe(1)
    feed(g, OK, 30)
    expect(g.level).toBe(0)
    log('late-in-window', [
      { field: 'level 100 frames after the late one', expected: 1, actual: 1 },
      { field: 'level once the window is clean', expected: 0, actual: g.level }
    ])
  })

  test('level 0 restores custom values and the preset name', () => {
    const ctx = new CloudsContext()
    ctx.qualityPreset = 'medium'
    ctx.clouds.minStepSize = 33
    ctx.shadow.mapSize.set(300, 300)
    ctx.temporalUpscale = false
    ctx.lightShaftsHalfResolution = true
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    feed(g, LATE, DOWN_FRAMES)
    expect(g.level).toBe(2)
    expect(ctx.qualityPreset).toBe('lowEnd')
    feed(g, OK, UP_FRAMES)
    expect(g.level).toBe(1)
    feed(g, OK, UP_FRAMES)
    expect(g.level).toBe(0)
    const actual = {
      preset: ctx.qualityPreset,
      minStepSize: ctx.clouds.minStepSize,
      mapSize: ctx.shadow.mapSize.x,
      temporalUpscale: ctx.temporalUpscale,
      lightShaftsHalfResolution: ctx.lightShaftsHalfResolution
    }
    log('restore', [
      { field: 'preset', expected: 'medium', actual: actual.preset },
      { field: 'minStepSize', expected: 33, actual: actual.minStepSize },
      { field: 'mapSize', expected: 300, actual: actual.mapSize }
    ])
    expect(actual).toEqual({
      preset: 'medium',
      minStepSize: 33,
      mapSize: 300,
      temporalUpscale: false,
      lightShaftsHalfResolution: true
    })
  })

  test('a step up reverted within the window doubles the next step-up wait', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx)
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    feed(g, OK, UP_FRAMES)
    expect(g.level).toBe(0)
    // Late again as soon as the cooldown allows, inside the revert window
    feed(g, LATE, DOWN_FRAMES)
    expect(g.level).toBe(1)
    // The same clean run that stepped up before is now too short
    feed(g, OK, UP_FRAMES)
    expect(g.level).toBe(1)
    feed(g, OK, UP_FRAMES)
    expect(g.level).toBe(0)
    log('backoff', [
      { field: 'events', expected: 4, actual: g.events.length },
      {
        field: 'reasons',
        expected: 'late,headroom,late,headroom',
        actual: g.events.map(e => e.reason).join(',')
      }
    ])
  })

  test('ignores the settle frames after a step', () => {
    const ctx = new CloudsContext()
    const g = new QualityGovernor(ctx, { cooldownMs: 0 })
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    expect(g.level).toBe(1)
    const framesAtStep = g.frames
    feed(g, LATE, d.settleFrames)
    expect(g.frames - framesAtStep).toBe(d.settleFrames)
    feed(g, LATE, d.stepDownFrames - 1)
    expect(g.level).toBe(1)
    g.update(LATE)
    expect(g.level).toBe(2)
  })

  test('createQualityGovernor registers on the context and reference mode disarms it', () => {
    const ctx = new CloudsContext()
    const g = createQualityGovernor(ctx)
    expect(ctx.qualityGovernor).toBe(g)
    g.arm()
    feed(g, LATE, d.stepDownFrames)
    expect(g.level).toBe(1)
    const changed = applyReferenceMode(ctx)
    expect(changed).toBe(true)
    expect(g.enabled).toBe(false)
    expect(g.level).toBe(0)
    expect(ctx.resolutionScale).toBe(1)
    expect(g.events.at(-1)?.reason).toBe('disarm')
    log('reference-mode', [
      { field: 'enabled after', expected: false, actual: g.enabled },
      { field: 'level after', expected: 0, actual: g.level }
    ])
  })

  test('onStep is called with each event and the history is bounded', () => {
    const ctx = new CloudsContext()
    const seen: string[] = []
    const g = new QualityGovernor(ctx, {
      cooldownMs: 0,
      settleFrames: 0,
      stepDownFrames: 1,
      stepUpFrames: 1,
      lateFraction: 1,
      onStep: e => seen.push(`${e.from}>${e.to}:${e.reason}`)
    })
    g.arm()
    for (let i = 0; i < 100; i++) {
      g.update(LATE)
      g.update(OK)
    }
    expect(seen.length).toBeGreaterThan(64)
    expect(g.events.length).toBe(64)
    expect(seen.slice(0, 2)).toEqual(['0>1:late', '1>0:headroom'])
  })
})
