import { describe, expect, it } from 'vitest'

import { flipRowsTopFirst } from './readbackRows'

// readLinear('A') must come out
// top-first like readLinear('B'). The helper reverses row order and nothing
// else, and a size mismatch is a refusal, not a silent reshape
describe('flipRowsTopFirst', () => {
  it('reverses the row order and keeps every value', () => {
    const w = 3
    const h = 2
    const c = 4
    const data = new Float32Array(w * h * c).map((_, i) => i)
    const out = flipRowsTopFirst(data, w, h, c)
    expect(Array.from(out.subarray(0, w * c))).toEqual(
      Array.from(data.subarray(w * c, 2 * w * c))
    )
    expect(Array.from(out.subarray(w * c, 2 * w * c))).toEqual(
      Array.from(data.subarray(0, w * c))
    )
    expect(flipRowsTopFirst(out, w, h, c)).toEqual(data)
  })

  it('refuses a buffer that is not width x height x channels', () => {
    expect(() => flipRowsTopFirst(new Float32Array(10), 3, 2)).toThrow(
      /not 3x2x4/
    )
  })
})
