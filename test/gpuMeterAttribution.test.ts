// The Storybook GPU meter charges each moment of GPU time to exactly one pass,
// and if it double counts overlapping passes the rows add up to more than the
// frame, and if it drops covered time the frame reads cheaper than it is,
// either of which misranks the clouds passes the operator is tuning
import { describe, expect, it } from 'vitest'

import {
  exclusiveTimings,
  type PassSpan
} from '../examples/storybook/src/devtools/gpuMeter/attribution'
import { log } from './helpers/log'

// Spans in ms written as ns, so the expected numbers read as ms
const span = (label: string, start: number, end: number): PassSpan => ({
  label,
  start: BigInt(start * 1e6),
  end: BigInt(end * 1e6)
})

const byLabel = (spans: PassSpan[]): Record<string, number> => {
  const out = exclusiveTimings(spans)
  const table = Object.fromEntries(
    out.rows.map(r => [r.label, Number(r.milliseconds.toFixed(6))])
  )
  log('attribution', { ...table, busy: out.busyMs, envelope: out.envelopeMs })
  return table
}

describe('exclusiveTimings', () => {
  it('gives sequential passes their own durations, gaps belong to nobody', () => {
    const out = exclusiveTimings([span('A', 0, 3), span('B', 5, 9)])
    expect(out.rows.map(r => r.milliseconds)).toEqual([3, 4])
    expect(out.busyMs).toBe(7)
    expect(out.envelopeMs).toBe(9)
  })

  it('charges a tiled overlap to the pass that finishes first', () => {
    // B starts its vertex work while A's fragments still run
    expect(byLabel([span('A', 0, 10), span('B', 8, 20)])).toEqual({
      A: 10,
      B: 10
    })
  })

  it('charges a nested pass its own time and the outer pass the rest', () => {
    expect(byLabel([span('outer', 0, 30), span('inner', 5, 10)])).toEqual({
      outer: 25,
      inner: 5
    })
  })

  it('keeps time a long pass covers between two shorter ones', () => {
    // End-order charging (the perf map's) would drop 4..6 and read busy 8
    const spans = [span('A', 0, 4), span('B', 6, 8), span('C', 2, 10)]
    expect(byLabel(spans)).toEqual({ A: 4, B: 2, C: 4 })
    expect(exclusiveTimings(spans).busyMs).toBe(10)
  })

  it('adds up to the busy time however the passes overlap', () => {
    const spans = [
      span('ShadowPass', 0, 2),
      span('ShadowPass', 1.5, 4),
      span('CloudsPass', 3, 11),
      span('CloudsResolve', 10.5, 12),
      span('RenderPipeline', 11, 16)
    ]
    const out = exclusiveTimings(spans)
    const sum = out.rows.reduce((s, r) => s + r.milliseconds, 0)
    log('attribution-sum', { sum, busy: out.busyMs, envelope: out.envelopeMs })
    expect(sum).toBeCloseTo(16, 9)
    expect(out.busyMs).toBeCloseTo(16, 9)
  })

  it('groups repeats of a label into one row with a call count', () => {
    const out = exclusiveTimings([
      span('ShadowPass', 0, 1),
      span('CloudsPass', 1, 5),
      span('ShadowPass', 5, 6),
      span('ShadowPass', 6, 7.5)
    ])
    expect(out.rows.map(r => [r.label, r.calls, r.milliseconds])).toEqual([
      ['ShadowPass', 3, 3.5],
      ['CloudsPass', 1, 4]
    ])
  })

  it('leaves out and counts a pass whose end precedes its start', () => {
    const out = exclusiveTimings([span('A', 0, 2), span('bad', 5, 4)])
    expect(out.rows.map(r => r.label)).toEqual(['A'])
    expect(out.invalid).toBe(1)
  })
})
