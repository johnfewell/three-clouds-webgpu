// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: bayer.ts, cloudsResolve.frag:42–47

import { Vector2 } from 'three'
import { int } from 'three/tsl'
import type { Node } from 'three/webgpu'

// prettier-ignore
export const bayerIndices: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5
]

export const bayerOffsets: readonly Vector2[] =
  /*#__PURE__*/ bayerIndices.reduce<Vector2[]>((result, _, index) => {
    const offset = new Vector2()
    for (let i = 0; i < 16; ++i) {
      if (bayerIndices[i] === index) {
        offset.set(((i % 4) + 0.5) / 4, (Math.floor(i / 4) + 0.5) / 4)
        break
      }
    }
    return [...result, offset]
  }, [])

export function bayerIndex2D(x: number, y: number): number {
  return bayerIndices[(y % 4) * 4 + (x % 4)]!
}

// Map a top-first WebGPU pixel row onto WebGL's bottom-first Bayer row. Cells
// are top-aligned (the march texel is read at `y / 4`) and the jitter shifts
// rays up, so within-cell row k matches bottom-up sub-row 3 - k

// Mirroring the absolute row instead matched only at heights divisible by 4 and
// streaked real windows. `height` is kept
// so call sites and the CPU twin read alike, and it no longer matters
export function referenceBayerRowCPU(
  topDownPixelY: number,
  _height: number
): number {
  return 3 - (topDownPixelY % 4)
}

export function referenceBayerRow(
  topDownPixelY: Node<'int'>,
  _height: Node<'float'>
): Node<'int'> {
  const cellRow = topDownPixelY.sub(topDownPixelY.div(int(4)).mul(int(4)))
  return int(3).sub(cellRow)
}
