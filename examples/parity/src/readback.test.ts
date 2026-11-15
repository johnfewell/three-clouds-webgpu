import { describe, expect, it } from 'vitest'

import { readSliceRed, sliceRowStride, unpadRows } from './readback'

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

  it('preserves pixels for both unpadded and 256-padded buffers at width 130 (not a multiple of 64)', () => {
    const width = 130
    const height = 5
    const tight = width * 16
    const stride = Math.ceil(tight / 256) * 256
    const unpadded = new Float32Array(width * height * 4)
    const fullPaddedBytes = new Uint8Array(height * stride)
    for (let y = 0; y < height; y++) {
      const row = new Float32Array(width * 4)
      for (let x = 0; x < width; x++) {
        row[x * 4] = y
        row[x * 4 + 1] = x
        row[x * 4 + 2] = 0.25
        row[x * 4 + 3] = 1
      }
      unpadded.set(row, y * width * 4)
      fullPaddedBytes.set(new Uint8Array(row.buffer), y * stride)
      fullPaddedBytes.fill(0xff, y * stride + tight, (y + 1) * stride)
    }
    const fullPadded = new Float32Array(fullPaddedBytes.buffer)
    const tailTrimmed = padded(width, height)

    for (const candidate of [unpadded, fullPadded, tailTrimmed]) {
      const out = unpadRows(candidate, width, height)
      expect(out.length).toBe(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (const x of [0, 1, 65, width - 2, width - 1]) {
          const i = (y * width + x) * 4
          const expected = candidate === tailTrimmed ? 0.5 : 0.25
          expect([out[i], out[i + 1], out[i + 2], out[i + 3]]).toEqual([
            y,
            x,
            expected,
            1
          ])
        }
      }
    }
  })
})

describe('readSliceRed / sliceRowStride', () => {
  it.each([1, 4])(
    'reads every pixel from both unpadded and 256-padded 130x5 slices (%i B/texel)',
    bytesPerTexel => {
      const width = 130
      const height = 5
      const unpaddedStride = width * bytesPerTexel
      const paddedStride = Math.ceil(unpaddedStride / 256) * 256
      const expected = new Uint8Array(width * height)
      const unpaddedBuf = new Uint8Array(unpaddedStride * height)
      const paddedBuf = new Uint8Array(paddedStride * height).fill(0xee)

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const val = (y * 53 + x + 1) & 0xff
          expected[y * width + x] = val
          unpaddedBuf[y * unpaddedStride + x * bytesPerTexel] = val
          paddedBuf[y * paddedStride + x * bytesPerTexel] = val
        }
      }

      expect(
        sliceRowStride(unpaddedBuf.byteLength, width, height, bytesPerTexel)
      ).toBe(unpaddedStride)
      expect(
        sliceRowStride(paddedBuf.byteLength, width, height, bytesPerTexel)
      ).toBe(paddedStride)
      expect(
        Array.from(readSliceRed(unpaddedBuf, width, height, bytesPerTexel))
      ).toEqual(Array.from(expected))
      expect(
        Array.from(readSliceRed(paddedBuf, width, height, bytesPerTexel))
      ).toEqual(Array.from(expected))
    }
  )

  it('throws with both candidate byte counts when slice size matches neither', () => {
    expect(() => sliceRowStride(999, 130, 5, 1)).toThrow(/650 B.*1280 B/)
  })
})
