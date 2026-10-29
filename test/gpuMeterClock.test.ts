// The meter's fast-clock ms must use the same correction as the perf map
// (frame / probe x 0.40 ms) with the same probe, or its numbers cannot be
// compared with the map's, and a light frame on the M4 reads too expensive
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  clockCorrected,
  FAST_PROBE_MS,
  PROBE_WGSL
} from '../examples/storybook/src/devtools/gpuMeter/clock'
import { MeterHistory } from '../examples/storybook/src/devtools/gpuMeter/history'
import { log } from './helpers/log'

describe('clockCorrected', () => {
  it('scales raw ms by the fast probe time over this frame probe', () => {
    // A frame at half clock: the probe takes twice its fast time
    const out = clockCorrected(10, 0.8)
    log('clock', { raw: 10, probe: 0.8, fast: FAST_PROBE_MS, corrected: out })
    expect(out).toBeCloseTo(5, 12)
    expect(clockCorrected(10, FAST_PROBE_MS)).toBeCloseTo(10, 12)
  })

  it('refuses to correct without a usable probe', () => {
    expect(clockCorrected(10, null)).toBeNull()
    expect(clockCorrected(10, 0)).toBeNull()
    expect(clockCorrected(10, Number.NaN)).toBeNull()
  })

  it('times the perf map probe, character for character', () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        '../examples/parity/scripts/benchmarks/clock.mjs'
      ),
      'utf8'
    )
    const shader = /code: `([\s\S]*?)`/.exec(source)?.[1]
    expect(shader).toBeDefined()
    expect(PROBE_WGSL).toBe(shader)
  })
})

describe('MeterHistory', () => {
  const sample = (rows: [string, number][], probeMs: number | null) => ({
    rows: rows.map(([label, milliseconds]) => ({
      label,
      milliseconds,
      calls: 1
    })),
    busyMs: rows.reduce((s, [, ms]) => s + ms, 0),
    probeMs
  })

  it('corrects each sample by its own probe before averaging', () => {
    const history = new MeterHistory(2)
    history.add(sample([['CloudsPass', 4]], 0.4))
    history.add(sample([['CloudsPass', 8]], 1.6))
    const row = history.snapshot().rows[0]!
    log('history-fast', { raw: row.rawMs, fast: row.fastMs })
    // (4 x 1 + 8 x 0.25) / 2, not mean raw 6 over mean probe 1.0
    expect(row.rawMs).toBe(6)
    expect(row.fastMs).toBeCloseTo(3, 12)
  })

  it('counts a pass missing from a sample as zero, as an update interval does', () => {
    const history = new MeterHistory(2)
    history.add(sample([['ShadowPass', 6]], 0.4))
    history.add(sample([['CloudsPass', 1]], 0.4))
    const rows = history.snapshot().rows
    expect(rows.map(r => [r.label, r.rawMs])).toEqual([
      ['ShadowPass', 3],
      ['CloudsPass', 1]
    ])
  })

  it('shows no fast ms while any averaged sample lacks a probe', () => {
    const history = new MeterHistory(2)
    history.add(sample([['CloudsPass', 4]], null))
    history.add(sample([['CloudsPass', 4]], 0.4))
    expect(history.snapshot().frame.fastMs).toBeNull()
  })
})
