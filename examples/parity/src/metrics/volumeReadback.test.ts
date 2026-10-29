import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import { byteSpread, compareVolumes, fnv1a32 } from './volumeReadback'

describe('byte-volume comparison for the procedural shape readback', () => {
  it('fnv1a32 matches the published FNV-1a 32-bit vectors', () => {
    const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0))
    const rows = [
      { input: '', expected: '811c9dc5', actual: fnv1a32([]) },
      { input: 'a', expected: 'e40c292c', actual: fnv1a32(ascii('a')) },
      {
        input: 'foobar',
        expected: 'bf9cf968',
        actual: fnv1a32(ascii('foobar'))
      }
    ]
    table('fnv1a32', rows)
    for (const r of rows) expect(r.actual).toBe(r.expected)
  })

  it('compareVolumes reports the largest byte difference and how many texels differ', () => {
    const same = compareVolumes([0, 128, 255], [0, 128, 255])
    const off = compareVolumes([0, 128, 255], [1, 128, 250])
    table('compareVolumes', [
      { case: 'identical', ...same },
      { case: 'differs', ...off }
    ])
    expect(same).toEqual({ texels: 3, maxAbs: 0, differing: 0 })
    expect(off).toEqual({ texels: 3, maxAbs: 5, differing: 2 })
    expect(() => compareVolumes([1], [1, 2])).toThrow(/sizes differ/)
    expect(() => compareVolumes([], [])).toThrow(/empty/)
  })

  it('byteSpread tells a structured volume from a blank one', () => {
    const blank = byteSpread(new Uint8Array(64))
    const structured = byteSpread([3, 200, 17, 200])
    table('byteSpread', [
      { case: 'blank', ...blank },
      { case: 'structured', ...structured }
    ])
    expect(blank).toEqual({ distinct: 1, min: 0, max: 0 })
    expect(structured).toEqual({ distinct: 3, min: 3, max: 200 })
  })
})
