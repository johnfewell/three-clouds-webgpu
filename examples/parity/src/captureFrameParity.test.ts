import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CAPTURE = resolve(import.meta.dirname, '../scripts/capture.mjs')

// Comments stripped, so a guard cannot pass by matching its own explanation
function captureCode(): string {
  return readFileSync(CAPTURE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

// The shadow history fills from zero at alpha 0.01, so extra updates add shadow
// Counted on hardware (2026-10-08): reading after the display renders gave A 66
// and B 72, enough alone to move shadow-cascades-2x512's histDist by 0.008
describe('both scored plates carry the same number of history updates', () => {
  it('side A repeats the 4-frame continuation side B gets before the still', () => {
    const code = captureCode()
    const continuation =
      /renderOnce\('B',\s*\{[^}]*warmup:\s*4,[^}]*resetHistory:\s*false[^}]*\}\)\s*await p\.renderOnce\('A',\s*\{[^}]*warmup:\s*4,[^}]*resetHistory:\s*false[^}]*\}\)/
    expect(code).toMatch(continuation)
  })

  it('the scored readback happens before either display render', () => {
    const code = captureCode()
    const readA = code.indexOf("const linearA = await p.readLinear('A')")
    const readB = code.indexOf("const linearB = await p.readLinear('B')")
    const displayA = code.indexOf('p.sideAHandle.render(0)')
    const displayB = code.indexOf('p.sideBHandle.pipeline.render()')
    for (const index of [readA, readB, displayA, displayB]) {
      expect(index).toBeGreaterThan(-1)
    }
    expect(readA).toBeLessThan(displayA)
    expect(readB).toBeLessThan(displayA)
    expect(readB).toBeLessThan(displayB)
  })

  it('the metrics are computed from that early readback', () => {
    const code = captureCode()
    expect(code).toMatch(
      /const \{ linearA, linearB, convergenceNow \} = window\.__parity_scored/
    )
  })
})
