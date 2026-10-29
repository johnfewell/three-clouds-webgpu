// Adapted from dgreenheck/threejs-fire-pro src/engine/GpuProfiler.ts @ c284f0b
// (MIT, Copyright (c) 2026 Daniel Greenheck). exclusiveTimings, with spans as
// objects, no categories, and the frame's busy and envelope times returned

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * MIT License
 *
 * Copyright (c) 2026 Daniel Greenheck
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* eslint-enable no-comment-slop/max-comment-lines */

export interface PassSpan {
  label: string
  start: bigint
  end: bigint
}

export interface PassRow {
  label: string
  milliseconds: number
  calls: number
}

export interface Attribution {
  // Rows in first-seen order, one per label, repeats counted in calls
  rows: PassRow[]
  invalid: number
  // Labels of the passes counted in invalid
  invalidLabels: string[]
  // Time any pass was running, which is the sum of the rows
  busyMs: number
  // First start to last end, idle gaps included
  envelopeMs: number
}

const ms = (ns: bigint): number => Number(ns) / 1e6

// Pass timestamps overlap: on a tiled GPU the next pass starts before the last
// one's fragments finish. Each moment goes to the running pass that finishes
// first, so the rows add up to the time the GPU was busy
export function exclusiveTimings(spans: readonly PassSpan[]): Attribution {
  const rows = new Map<string, PassRow>()
  const valid: { row: PassRow; start: bigint; end: bigint }[] = []
  const invalidLabels: string[] = []
  for (const { label, start, end } of spans) {
    if (end < start) {
      invalidLabels.push(label)
      continue
    }
    const row = rows.get(label) ?? { label, milliseconds: 0, calls: 0 }
    row.calls++
    rows.set(label, row)
    valid.push({ row, start, end })
  }
  const moments = [...new Set(valid.flatMap(s => [s.start, s.end]))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  )
  let busy = 0n
  let from: bigint | undefined
  for (const to of moments) {
    let owner: (typeof valid)[number] | undefined
    for (const span of valid) {
      if (from != null && span.start <= from && span.end >= to) {
        if (owner == null || span.end < owner.end) owner = span
      }
    }
    if (owner != null && from != null) {
      owner.row.milliseconds += ms(to - from)
      busy += to - from
    }
    from = to
  }
  const first = moments.at(0)
  const last = moments.at(-1)
  return {
    rows: [...rows.values()],
    invalid: invalidLabels.length,
    invalidLabels,
    busyMs: ms(busy),
    envelopeMs: first != null && last != null ? ms(last - first) : 0
  }
}
