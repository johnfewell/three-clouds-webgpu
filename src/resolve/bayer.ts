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

// Rows of the low-res grid that a height does not use: 4*ceil(H/4) - H. The
// resolve owns row y with texel row (y + cellShift) / 4, so the partial cell
// sits at the top, as WebGL's bottom-anchored grid puts it
export function resolveCellShiftCPU(height: number): number {
  return 4 * Math.ceil(height / 4) - height
}

// Map a top-first WebGPU pixel row onto WebGL's bottom-first Bayer row. The
// cell is bottom-anchored by `shift` (resolveCellShift), so within-cell row k
// matches bottom-up sub-row 3 - ((y + shift) % 4); shift 0 is the old form
export function referenceBayerRowCPU(topDownPixelY: number, shift = 0): number {
  return 3 - ((topDownPixelY + shift) % 4)
}

export function referenceBayerRow(
  topDownPixelY: Node<'int'>,
  shift: Node<'int'>
): Node<'int'> {
  const row = topDownPixelY.add(shift)
  const cellRow = row.sub(row.div(int(4)).mul(int(4)))
  return int(3).sub(cellRow)
}
