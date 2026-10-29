import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  BAYER_PERIOD,
  planTemporal,
  STBN_PERIOD,
  TEMPORAL_RUNUP,
  warmupFramePlan
} from './warmupFrames'

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const cells = (plan: number[]): Set<number> =>
  new Set(plan.map(f => f % BAYER_PERIOD))

describe('warmupFramePlan', () => {
  // The property the whole fix exists for. A warm-up of 16 or more must march
  // every Bayer cell, or the resolve reprojects cells it never marched and the
  // history assembles as 4x4 blocks
  test.each([16, 17, 32, 64, 128])(
    'a warmup of %i visits all 16 Bayer cells',
    warmup => {
      expect(cells(warmupFramePlan(0, warmup, true)).size).toBe(BAYER_PERIOD)
    }
  )

  test('a warmup below 16 cannot cover every cell — the plan does not pretend otherwise', () => {
    expect(cells(warmupFramePlan(0, 8, true)).size).toBe(9)
  })

  test('renders warmup + 1 frames: the warm-up renders plus the final one', () => {
    expect(warmupFramePlan(0, 64, true)).toHaveLength(65)
    expect(warmupFramePlan(0, 4, true)).toHaveLength(5)
  })

  // Every call lands on the same final frame whatever its warmup, which is what
  // keeps side A's single renderOnce(64) and side B's renderOnce(64) + (4) on
  // the same cell with the same history depth
  test('all warmups finish on the same final frame', () => {
    const finals = [4, 16, 32, 64].map(w => warmupFramePlan(0, w, true).at(-1))
    expect(new Set(finals).size).toBe(1)
    expect(finals[0]).toBe(TEMPORAL_RUNUP)
  })

  test('the final frame keeps the pinned frame Bayer cell and jitter offset', () => {
    for (const frame of [0, 1, 7, 15, 63]) {
      const final = warmupFramePlan(frame, 64, true).at(-1)!
      expect(final % BAYER_PERIOD).toBe(frame % BAYER_PERIOD)
      expect(final % STBN_PERIOD).toBe(frame % STBN_PERIOD)
    }
  })

  test('frames advance by exactly one and never go negative', () => {
    const plan = warmupFramePlan(0, 64, true)
    expect(Math.min(...plan)).toBeGreaterThanOrEqual(0)
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]! - plan[i - 1]!).toBe(1)
    }
  })

  // hjhq: a caller asking for no warm-up wants the frame it named, not a
  // run-up's endpoint. There is no history to assemble, so there is nothing to
  // advance for
  test('warmup 0 stays pinned to the requested frame', () => {
    expect(warmupFramePlan(0, 0, true)).toEqual([0])
    expect(warmupFramePlan(7, 0, true)).toEqual([7])
  })

  // Non-temporal cases march every pixel every render, so advancing the frame
  // would only perturb the jitter for no benefit
  test('non-temporal cases hold the pinned frame throughout', () => {
    expect(warmupFramePlan(3, 64, false)).toEqual(new Array(65).fill(3))
    expect(cells(warmupFramePlan(3, 64, false)).size).toBe(1)
  })
})

describe('planTemporal', () => {
  test('reads the live state of the side being rendered, not the other one', () => {
    const on = { temporalUpscale: true }
    const off = { temporalUpscale: false }
    expect(planTemporal('A', on, off)).toBe(true)
    expect(planTemporal('A', off, on)).toBe(false)
    expect(planTemporal('B', off, on)).toBe(true)
    expect(planTemporal('B', on, off)).toBe(false)
  })

  // A side that is not booted has no warm-up to plan, and an undefined flag is
  // not a temporal render. Neither may fall through to a truthy plan.
  test('an absent side or an unset flag is not temporal', () => {
    expect(planTemporal('B', { temporalUpscale: true }, null)).toBe(false)
    expect(planTemporal('B', null, undefined)).toBe(false)
    expect(planTemporal('A', {}, {})).toBe(false)
  })

  // The arithmetic the defect produced. A case that does not DECLARE temporal
  // but has it toggled on at runtime used to reach the plan as `false`
  test('the stale-knob input marched one Bayer cell in sixteen', () => {
    const staleDeclaredKnob = warmupFramePlan(0, 128, false)
    const liveState = warmupFramePlan(0, 128, true)
    expect(cells(staleDeclaredKnob).size).toBe(1)
    expect(cells(liveState).size).toBe(BAYER_PERIOD)
  })

  // The defect is which VALUE reaches the plan, a property of the call site
  // main.ts cannot be imported (side effects), so this asserts on the source,
  // like errorCapture.test.ts. Reverting the fix must turn this red.
  test('renderOnce plans from the live state and never from the case knob', () => {
    // Comments are stripped first. The first version of this guard matched
    // main.ts's prose about the defect, and a guard that reads its own
    // documentation cannot be satisfied by fixing the code
    const source = stripComments(
      readFileSync(join(__dirname, 'main.ts'), 'utf8')
    )
    expect(
      source,
      'renderOnce must not plan from pc.knobs.temporalUpscale — it is the case declaration and goes stale on any runtime toggle'
    ).not.toMatch(/knobs\.temporalUpscale/)
    expect(
      source,
      'renderOnce must derive the plan input through planTemporal'
    ).toMatch(/planTemporal\(/)
  })
})
