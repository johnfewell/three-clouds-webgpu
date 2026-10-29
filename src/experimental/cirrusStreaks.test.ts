// The cirrus deck's default texture. What matters is that it reads as cirrus on
// a repeating sheet: no seam where the tile wraps, strands rather than blobs,
// patchy rather than empty or overcast, and a mip chain the GPU can trust

import { RepeatWrapping } from 'three'
import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import {
  CIRRUS_STREAKS_SIZE,
  cirrusStreakMips,
  cirrusStreakValue,
  createCirrusStreaksTexture,
  generateCirrusStreaks
} from './cirrusStreaks'

const SIZE = 128
const tile = generateCirrusStreaks(SIZE, 1)
const at = (x: number, y: number) => tile[y * SIZE + x]!

// Mean absolute step between neighbours along one axis, excluding the wrap
function meanStep(axis: 'x' | 'y'): number {
  let sum = 0
  let count = 0
  for (let y = 0; y < SIZE - 1; ++y) {
    for (let x = 0; x < SIZE - 1; ++x) {
      const next = axis === 'x' ? at(x + 1, y) : at(x, y + 1)
      sum += Math.abs(next - at(x, y))
      ++count
    }
  }
  return sum / count
}

describe('cirrus streak texture', () => {
  it('wraps with no seam, so a repeated tile shows no grid', () => {
    // The step across each wrap edge against every step between neighbouring
    // rows or columns inside the tile. One row pair is a few correlated strands,
    // not N samples, so the bar is the interior's own worst step, not its mean
    const wrapped = (data: Uint8Array) => {
      const get = (x: number, y: number) =>
        data[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]!
      const step = (i: number, axis: 'x' | 'y') => {
        let sum = 0
        for (let j = 0; j < SIZE; ++j) {
          sum +=
            axis === 'y'
              ? Math.abs(get(j, i + 1) - get(j, i))
              : Math.abs(get(i + 1, j) - get(i, j))
        }
        return sum / SIZE
      }
      const worst = (axis: 'x' | 'y') =>
        Math.max(...Array.from({ length: SIZE - 1 }, (_, i) => step(i, axis)))
      return {
        x: step(SIZE - 1, 'x') / worst('x'),
        y: step(SIZE - 1, 'y') / worst('y')
      }
    }
    // The positive control: a crop of the same field that does not span one
    // period, which must fail the same bar or the bar measures nothing
    const crop = new Uint8Array(SIZE * SIZE)
    for (let y = 0; y < SIZE; ++y) {
      for (let x = 0; x < SIZE; ++x) {
        const u = (x / SIZE) * 0.83 + 0.1
        const v = (y / SIZE) * 0.83 + 0.1
        crop[y * SIZE + x] = Math.round(cirrusStreakValue(u, v, 1) * 255)
      }
    }
    const tileSeam = wrapped(tile)
    const cropSeam = wrapped(crop)
    table('cirrus-seams', [
      {
        field: 'tile seam x / worst inside',
        expected: '<=1',
        actual: tileSeam.x
      },
      {
        field: 'tile seam y / worst inside',
        expected: '<=1',
        actual: tileSeam.y
      },
      {
        field: 'crop seam x / worst inside',
        expected: '>1',
        actual: cropSeam.x
      },
      {
        field: 'crop seam y / worst inside',
        expected: '>1',
        actual: cropSeam.y
      }
    ])
    expect(tileSeam.x).toBeLessThanOrEqual(1)
    expect(tileSeam.y).toBeLessThanOrEqual(1)
    expect(cropSeam.x).toBeGreaterThan(1)
    expect(cropSeam.y).toBeGreaterThan(1)
  })

  it('is fibrous: it changes much faster across the strands than along them', () => {
    const ratio = meanStep('y') / meanStep('x')
    table('cirrus-anisotropy', [
      { field: 'step across / step along', expected: '>3', actual: ratio }
    ])
    expect(ratio).toBeGreaterThan(3)
  })

  it('is patchy: some sky clear, some strands near opaque', () => {
    let covered = 0
    let max = 0
    for (const value of tile) {
      if (value > 25) ++covered
      max = Math.max(max, value)
    }
    const fraction = covered / tile.length
    table('cirrus-coverage', [
      { field: 'texels above 0.1', expected: '0.15..0.7', actual: fraction },
      { field: 'max opacity / 255', expected: '>0.8', actual: max / 255 }
    ])
    expect(fraction).toBeGreaterThan(0.15)
    expect(fraction).toBeLessThan(0.7)
    expect(max / 255).toBeGreaterThan(0.8)
  })

  it('is a pure function of its seed', () => {
    const again = generateCirrusStreaks(SIZE, 1)
    const other = generateCirrusStreaks(SIZE, 2)
    let changed = 0
    for (let i = 0; i < tile.length; ++i) if (other[i] !== tile[i]) ++changed
    expect(Buffer.from(again).equals(Buffer.from(tile))).toBe(true)
    expect(changed / tile.length).toBeGreaterThan(0.3)
  })

  it('carries a full mip chain whose last level is the tile mean', () => {
    const mips = cirrusStreakMips(tile, SIZE)
    const mean = tile.reduce((a, b) => a + b, 0) / tile.length
    const last = mips[mips.length - 1]!
    table('cirrus-mips', [
      { field: 'levels', expected: Math.log2(SIZE) + 1, actual: mips.length },
      { field: 'last size', expected: 1, actual: last.width },
      { field: 'last value', expected: mean, actual: last.data[0]! }
    ])
    expect(mips.length).toBe(Math.log2(SIZE) + 1)
    expect(last.width).toBe(1)
    // One rounding per level, so the error is at most half a step per level
    expect(Math.abs(last.data[0]! - mean)).toBeLessThan(mips.length * 0.5)
  })

  it('builds a repeating, mipmapped single-channel texture', () => {
    const texture = createCirrusStreaksTexture(16)
    expect(texture.image.width).toBe(16)
    expect(texture.mipmaps.length).toBe(5)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.wrapS).toBe(RepeatWrapping)
    expect(texture.wrapT).toBe(RepeatWrapping)
    texture.dispose()
    expect(CIRRUS_STREAKS_SIZE).toBe(512)
  })
})
