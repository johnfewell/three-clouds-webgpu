import { describe, expect, it } from 'vitest'

import {
  markdown,
  markdownVsync,
  perRun,
  reduce,
  reduceVsync
} from '../core/scripts/speed/sweep-report.mjs'
import {
  armOrder,
  ARMS,
  checkRunInputs,
  median,
  parseSize,
  PROBE_FAST_MS,
  resolveArms,
  timingMode,
  validateExtra
} from '../core/scripts/speed/sweepArgs.mjs'
import { log } from './helpers/log'

// pass exclusive is in milliseconds, like the instrument reports it, and the
// probe is 0.5 ms, so a 0.2 ms pass is 0.4 of a probe, i.e. 0.16 fast ms
type Run = Parameters<typeof reduce>[0]['runs'][number]

const PASS = {
  label: 'renderPipeline_CloudsPass_0',
  exclusive: 0.2
}

function run({
  arm = 'base',
  frame = 10,
  extra = 0,
  unstable = false
}: {
  arm?: string
  frame?: number
  extra?: number
  unstable?: boolean
} = {}): Run {
  return {
    case: 'baseline-medium',
    arm,
    applied: { graphVersion: 1 },
    timed: {
      passList: [[{ ...PASS, exclusive: 0.2 + extra }]],
      probeMs: [0.5],
      gpuMs: [frame]
    },
    clock: { unitsMedian: frame, stable: !unstable }
  }
}

describe('sweep argument parsing', () => {
  it('parses a size with and without a device pixel ratio', () => {
    const retina = parseSize('2880x1800@2')
    const plain = parseSize('1280x720')
    expect(retina).toEqual({ w: 2880, h: 1800, dpr: 2 })
    expect(plain).toEqual({ w: 1280, h: 720, dpr: 1 })
    expect(() => parseSize('2880')).toThrow(/bad size/)
    expect(() => parseSize('0x1800')).toThrow(/positive/)
    log('size parsing', { retina, plain })
  })

  it('refuses a run over zero cases, arms or repetitions', () => {
    const ok = { cases: ['a'], arms: [{ id: 'base' }], reps: 1 }
    expect(checkRunInputs(ok)).toEqual({ cases: 1, arms: 1, reps: 1 })
    expect(() => checkRunInputs({ ...ok, cases: [] })).toThrow(/zero cases/)
    expect(() => checkRunInputs({ ...ok, arms: [] })).toThrow(/zero arms/)
    expect(() => checkRunInputs({ ...ok, reps: 0 })).toThrow(/zero repetitions/)
    log('input count guard', { ok })
  })

  it('resolves a built-in arm and a combination arm by id', () => {
    const extra = validateExtra([
      { id: 'c0', set: [['temporalUpscale', true]] }
    ])
    expect(resolveArms(['base', 'c0'], extra).map(a => a.id)).toEqual([
      'base',
      'c0'
    ])
    expect(() => resolveArms(['nope'], extra)).toThrow(/unknown arm/)
    expect(ARMS[0]).toEqual({ id: 'base' })
    log('arm resolution', { builtIn: ARMS.length, extra: extra.length })
  })

  it('refuses a malformed combination file rather than dropping a knob', () => {
    expect(() => validateExtra({})).toThrow(/JSON array/)
    expect(() => validateExtra([{ set: [] }])).toThrow(/string id/)
    expect(() => validateExtra([{ id: 'a' }, { id: 'a' }])).toThrow(/repeats/)
    expect(() => validateExtra([{ id: 'a', set: [['x']] }])).toThrow(
      /\[path, value\]/
    )
    expect(() => validateExtra([{ id: 'a', set: [['', 1]] }])).toThrow(
      /empty knob path/
    )
    log('combination validation', { refused: 5 })
  })

  it('times sampled frames by default and a window under vsync', () => {
    const timed = timingMode({ warmup: '40', samples: '30' })
    const vsync = timingMode({ vsync: true, warmup: '60', seconds: '8' })
    expect(timed).toEqual({ mode: 'timed', warmup: 40, samples: 30 })
    expect(vsync).toEqual({ mode: 'vsync', warmup: 60, seconds: 8 })
    expect(() => timingMode({ warmup: '40', samples: '0' })).toThrow(/samples/)
    log('timing mode', { timed, vsync })
  })

  it('rotates the arm order so an arm never keeps one neighbour', () => {
    const arms = ['a', 'b', 'c', 'd'].map(id => ({ id }))
    const first = armOrder(arms, 0, 0)
    const second = armOrder(arms, 1, 0)
    expect(new Set(first)).toEqual(new Set(arms))
    expect(first).not.toEqual(second)
    expect(armOrder(arms, 4, 0)).toEqual(first)
    expect(armOrder([], 0, 0)).toEqual([])
    log('arm rotation', { first, second })
  })

  it('median averages the middle pair of an even count', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNaN()
    log('median', { odd: median([3, 1, 2]), even: median([4, 1, 3, 2]) })
  })
})

describe('sweep report reduction', () => {
  it('reads a frame and its passes in fast-clock milliseconds', () => {
    const row = perRun(run({ frame: 10 }))
    expect(row.frame).toBeCloseTo(10 * PROBE_FAST_MS)
    expect(row.passes.CloudsPass).toBeCloseTo(0.4 * PROBE_FAST_MS)
    log('per-run reduction', row)
  })

  it('charges an arm the base frame minus its own, and names the passes', () => {
    const reduced = reduce({
      runs: [
        run({ frame: 10 }),
        // a pass 0.4 ms shorter is 0.8 of a probe, i.e. 0.32 fast ms saved
        run({ arm: 'temporal', frame: 4, extra: -0.4 })
      ]
    })
    const rows = reduced.result['baseline-medium'] ?? []
    const temporal = rows.find(r => r.arm === 'temporal')
    expect(rows[0]?.arm).toBe('temporal')
    expect(temporal?.saved).toBeCloseTo(6 * PROBE_FAST_MS)
    expect(temporal?.savedShare).toBeCloseTo(0.6)
    expect(Object.keys(temporal?.passDelta ?? {})).toContain('CloudsPass')
    expect(markdown(reduced)).toContain('| temporal |')
    log('report reduction', {
      saved: temporal?.saved,
      savedShare: temporal?.savedShare
    })
  })

  it('excludes a failed arm and counts it', () => {
    const failed = { ...run({ arm: 'bad' }), failed: 'timeout' }
    const reduced = reduce({ runs: [run(), failed] })
    expect(reduced.bad).toBe(1)
    expect((reduced.result['baseline-medium'] ?? []).map(r => r.arm)).toEqual([
      'base'
    ])
    expect(markdown(reduced)).toContain('1 arm runs failed')
    log('failed arm exclusion', { bad: reduced.bad })
  })
})

describe('vsync report reduction', () => {
  const loop = (arm: string, fps: number, dropped: number): Run => ({
    case: 'shafts-low-sun',
    arm,
    vsync: {
      refreshMs: 1000 / 60,
      displayHz: 60,
      frames: Math.round(fps * 8),
      intervals: 480,
      fps,
      dropped,
      droppedShare: dropped / 480,
      longestMs: fps >= 60 ? 18.7 : 85.2
    }
  })

  it('ranks arms by measured fps and reports dropped frames', () => {
    const reduced = reduceVsync({
      runs: [loop('base', 14.6, 360), loop('c3', 60, 0)]
    })
    const rows = reduced.result['shafts-low-sun'] ?? []
    expect(rows[0]?.arm).toBe('c3')
    expect(rows[0]?.dropped).toBe(0)
    expect(rows[1]?.fps).toBeCloseTo(14.6)
    expect(markdownVsync(reduced)).toContain('| c3 | 60.0 |')
    log('vsync reduction', rows)
  })

  it('counts a timed run without a loop as unusable, not as 0 fps', () => {
    const reduced = reduceVsync({ runs: [run()] })
    expect(reduced.bad).toBe(1)
    expect(reduced.result['baseline-medium']).toBeUndefined()
    log('vsync without a loop', { scenes: Object.keys(reduced.result) })
  })
})
