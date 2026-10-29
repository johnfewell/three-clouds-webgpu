import { describe, expect, it } from 'vitest'

import {
  applyLayerSet,
  DEFAULT_ACTIVE_LAYERS,
  MAX_LAYERS,
  PARITY_LAYER_SET,
  type MutableLayer
} from './layerSet'

function slots(n = MAX_LAYERS): MutableLayer[] {
  return Array.from({ length: n }, () => ({
    channel: 'r',
    altitude: -1,
    height: -1,
    densityScale: -1,
    shapeAmount: -1,
    shapeDetailAmount: -1,
    weatherExponent: -1,
    shapeAlteringBias: -1,
    coverageFilterWidth: -1,
    shadow: true
  }))
}

const activeCount = (s: MutableLayer[]): number =>
  s.filter(l => l.height > 0).length

describe('applyLayerSet', () => {
  it('activates exactly the requested count', () => {
    for (const n of [1, 2, 3, 4]) {
      const s = slots()
      applyLayerSet(s, n)
      expect(activeCount(s), `${n} layers`).toBe(n)
    }
  })

  it('deactivates by zero HEIGHT, not zero density', () => {
    // The march skips an interval whose min and max heights coincide, so a
    // zero-height layer costs nothing. A zero-density one still walks it
    const s = slots()
    applyLayerSet(s, 2)
    expect(s[2]!.height).toBe(0)
    expect(s[3]!.height).toBe(0)
    expect(s[2]!.shadow).toBe(false)
  })

  it('reproduces CloudLayers.DEFAULT at the default count', () => {
    // The load-bearing property: three active layers must be byte-identical to
    // what the library renders untouched, or wiring this key silently changes
    // every committed capture
    const s = slots()
    applyLayerSet(s, DEFAULT_ACTIVE_LAYERS)
    expect(s[0]).toMatchObject({ channel: 'r', altitude: 750, height: 650 })
    expect(s[1]).toMatchObject({ channel: 'g', altitude: 1000, height: 1200 })
    expect(s[2]).toMatchObject({
      channel: 'b',
      altitude: 7500,
      height: 500,
      densityScale: 0.003
    })
    expect(s[3]!.height).toBe(0)
  })

  it('is idempotent and order-independent', () => {
    // applyCase runs per case load. Going 4 -> 3 must fully undo the fourth
    // layer rather than leave it half-active
    const a = slots()
    applyLayerSet(a, 4)
    applyLayerSet(a, 3)
    const b = slots()
    applyLayerSet(b, 3)
    expect(a).toEqual(b)
  })

  it('clamps out-of-range counts instead of throwing mid-capture', () => {
    const s = slots()
    applyLayerSet(s, 99)
    expect(activeCount(s)).toBe(MAX_LAYERS)
    const z = slots()
    applyLayerSet(z, 0)
    expect(activeCount(z)).toBe(0)
  })

  it('gives the fourth layer a gap above the third', () => {
    // Case 27 exercises interval skipping across a third gap. A fourth layer
    // overlapping the third would not test that
    const third = PARITY_LAYER_SET[2]!
    const fourth = PARITY_LAYER_SET[3]!
    expect(fourth.altitude).toBeGreaterThan(third.altitude + third.height)
  })
})
