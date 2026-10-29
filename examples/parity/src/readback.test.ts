import { describe, expect, it } from 'vitest'

import { unpadRows } from './readback'

// Lay a w×h RGBA32F frame out the way WebGPU's copyTextureToBuffer does:
// rows at a 256-byte stride, the last row unpadded (three 0.185 sizes the
// buffer as (h − 1) × stride + w × 16)
function padded(width: number, height: number): Float32Array {
  const tight = width * 16
  const stride = Math.ceil(tight / 256) * 256
  const bytes = new Uint8Array((height - 1) * stride + tight)
  for (let y = 0; y < height; y++) {
    const row = new Float32Array(width * 4)
    for (let x = 0; x < width; x++) {
      row[x * 4] = y
      row[x * 4 + 1] = x
      row[x * 4 + 2] = 0.5
      row[x * 4 + 3] = 1
    }
    bytes.set(new Uint8Array(row.buffer), y * stride)
    // Poison the padding so a wrong stride reads garbage, not zeros
    if (y < height - 1) bytes.fill(0xff, y * stride + tight, (y + 1) * stride)
  }
  return new Float32Array(bytes.buffer)
}

describe('unpadRows', () => {
  it('passes a tight buffer through untouched (1280 columns = 80 × 256 B)', () => {
    const buf = new Float32Array(1280 * 3 * 4)
    expect(unpadRows(buf, 1280, 3)).toBe(buf)
  })

  it.each([1277, 1278, 1279])(
    'strips the 256-byte row stride at %i columns',
    width => {
      const height = 5
      const src = padded(width, height)
      expect(src.length).not.toBe(width * height * 4)
      const out = unpadRows(src, width, height)
      expect(out.length).toBe(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (const x of [0, 1, width - 2, width - 1]) {
          const i = (y * width + x) * 4
          expect([out[i], out[i + 1], out[i + 2], out[i + 3]]).toEqual([
            y,
            x,
            0.5,
            1
          ])
        }
      }
    }
  )

  it('refuses a buffer that is neither tight nor 256-aligned', () => {
    expect(() =>
      unpadRows(new Float32Array(1277 * 5 * 4 + 7), 1277, 5)
    ).toThrow(/neither tight/)
  })

  it('handles half-float readbacks by element size', () => {
    // 1279 × 8 B = 10232 B rows at a 10240 B stride
    const width = 1279
    const height = 3
    const tight = width * 8
    const stride = Math.ceil(tight / 256) * 256
    const bytes = new Uint8Array((height - 1) * stride + tight)
    for (let y = 0; y < height; y++) {
      const row = new Uint16Array(width * 4).fill(y + 1)
      bytes.set(new Uint8Array(row.buffer), y * stride)
    }
    const out = unpadRows(new Uint16Array(bytes.buffer), width, height)
    expect(out).toBeInstanceOf(Uint16Array)
    expect(out.length).toBe(width * height * 4)
    expect(out[(2 * width + width - 1) * 4 + 3]).toBe(3)
  })
})
