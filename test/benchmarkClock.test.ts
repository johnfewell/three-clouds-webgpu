import { describe, expect, it } from 'vitest'

import {
  clockStability,
  installClockProbe,
  PROBE_DRIFT_LIMIT,
  RAMP_LIMIT,
  thirdsRatio,
  toProbeUnits
} from '../examples/parity/scripts/benchmarks/clock.mjs'
import { log } from './helpers/log'

// Deterministic jitter, so a flat series is noisy the way real frames are
const jitter = (i: number, amplitude: number) =>
  1 + amplitude * Math.sin(i * 12.9898)

describe('per-frame clock normalisation', () => {
  // perf/2026-10-08-marchcost: the same work read 16.79 ms at probe 0.400 and
  // twice the time in the slow state. Probe units must cancel the clock
  it('makes the same work read the same across clock states', () => {
    const cycles = 42
    const fast = Array.from({ length: 30 }, () => 0.4)
    const slow = Array.from({ length: 30 }, () => 0.79)
    const msFast = fast.map(p => cycles * p)
    const msSlow = slow.map(p => cycles * p)
    const unitsFast = toProbeUnits(msFast, fast)!
    const unitsSlow = toProbeUnits(msSlow, slow)!
    log('same work, two clock states', [
      { state: 'fast', ms: msFast[0], units: unitsFast[0] },
      { state: 'slow', ms: msSlow[0], units: unitsSlow[0] }
    ])
    expect(msSlow[0]! / msFast[0]!).toBeGreaterThan(1.9)
    expect(unitsSlow[0]).toBeCloseTo(unitsFast[0]!, 9)
  })

  it('refuses a partial normalisation rather than mixing clock states', () => {
    expect(toProbeUnits([1, 2, 3], [0.4, 0.4])).toBeNull()
    expect(toProbeUnits([1, 2, 3], [0.4, 0, 0.4])).toBeNull()
    expect(toProbeUnits([1, 2, 3], null)).toBeNull()
  })
})

describe('the ramp guard', () => {
  // The run that prompted the guard: frame time doubled between frames 15
  // and 45 of a 60-frame run
  const ramp = Array.from({ length: 60 }, (_, i) => {
    const t = Math.min(1, Math.max(0, (i - 15) / 30))
    return 10 * (1 + t) * jitter(i, 0.03)
  })

  it('fires on the 2x ramp at frames 15-45', () => {
    const result = clockStability(ramp, null)
    log('2x ramp', [result])
    expect(result.stable).toBe(false)
    expect(result.frameRamp).toBeGreaterThan(1.8)
    expect(result.reasons[0]).toMatch(/ramped/)
  })

  it('fires on a ramp in either direction', () => {
    expect(clockStability([...ramp].reverse(), null).stable).toBe(false)
  })

  // A guard that fires on ordinary frame noise would be switched off. Real
  // stable runs move +-5 % frame to frame (r9 control: 46.71-47.21 ms)
  it('stays quiet on a flat run with frame-to-frame noise', () => {
    const flat = Array.from({ length: 30 }, (_, i) => 47 * jitter(i, 0.05))
    const probes = Array.from({ length: 30 }, (_, i) => 0.4 * jitter(i, 0.02))
    const result = clockStability(flat, probes)
    log('flat run', [result])
    expect(result.stable).toBe(true)
    expect(result.normalised).toBe(true)
    expect(result.unitsMedian).toBeCloseTo(47 / 0.4, -1)
  })

  // r5's lighting knock-out: frames drifted up 1-2 ms as the probe moved from
  // 0.40 to 0.47. That is a clock change inside the run even where the frame
  // ramp alone stays under the limit
  it('fires when the probe says the clock changed inside the run', () => {
    const probes = Array.from({ length: 30 }, (_, i) => (i < 15 ? 0.4 : 0.47))
    const frames = probes.map(p => 47.5 * p)
    const result = clockStability(frames, probes)
    log('clock step mid-run', [result])
    expect(result.frameRamp).toBeLessThan(RAMP_LIMIT)
    expect(result.probeDrift).toBeGreaterThan(PROBE_DRIFT_LIMIT)
    expect(result.stable).toBe(false)
    expect(result.reasons.join()).toMatch(/clock state changed/)
  })

  it('says nothing about a run too short to split into thirds', () => {
    expect(thirdsRatio([1, 2, 3, 4, 5])).toBeNull()
    expect(clockStability([1, 2, 3, 4, 5], null).stable).toBe(true)
  })
})

describe('the page-side probe', () => {
  // Playwright serializes installClockProbe without its module. It must not
  // reach for anything outside its own body
  it('is self-contained and degrades to null without WebGPU', async () => {
    const source = installClockProbe.toString()
    const scope = {
      window: {} as {
        __clockProbe?: () => Promise<unknown>
        __clockLoad?: (groups: number) => Promise<unknown>
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('window', 'navigator', `(${source})()`)(scope.window, {})
    expect(typeof scope.window.__clockProbe).toBe('function')
    expect(await scope.window.__clockProbe!()).toBeNull()
    expect(await scope.window.__clockLoad!(16)).toBe(false)
  })
})
