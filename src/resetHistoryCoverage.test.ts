// resetHistory() must reset every temporal accumulator. It once left
// the shadow history warm, and an un-reset accumulator reads as a converged
// measurement

// A source test on purpose: the flags are private and GPU-only, but a new
// history flag left out of the reset is visible in the source

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, 'CloudsPassNode.ts'), 'utf8')

/** Every private "this history is stale" flag the pass declares */
function historyFlags(src: string): string[] {
  return [
    ...new Set(
      [...src.matchAll(/^\s*private (_\w*[Hh]istoryInvalid)\b/gm)].map(
        m => m[1]!
      )
    )
  ].sort()
}

function resetBody(src: string): string {
  const start = src.indexOf('private _resetHistoryImpl(): void {')
  expect(
    start,
    '_resetHistoryImpl not found — was it renamed?'
  ).toBeGreaterThan(-1)
  const end = src.indexOf('\n  }', start)
  return src.slice(start, end)
}

describe('resetHistory covers every accumulator', () => {
  it('finds the flags it is meant to police', () => {
    // Without this the suite passes vacuously if the naming convention changes
    const flags = historyFlags(SRC)
    // Two accumulators: the colour/shadow-length resolve pair shares one flag
    // since the merged resolve pass, the shadow
    // maps keep theirs. The guard below still polices every flag declared.
    expect(flags.length).toBeGreaterThanOrEqual(2)
    expect(flags).toContain('_shadowHistoryInvalid')
    expect(flags).toContain('_historyInvalid')
  })

  it('sets every history-invalid flag it declares', () => {
    const body = resetBody(SRC)
    const missed = historyFlags(SRC).filter(
      f => !new RegExp(`this\\.${f}\\s*=\\s*true`).test(body)
    )
    expect(
      missed,
      `_resetHistoryImpl does not reset: ${missed.join(', ')}. A reset that ` +
        `leaves an accumulator running reports a cold start it did not perform ` +
        `— the caller then measures a warm buffer and cannot tell.`
    ).toEqual([])
  })

  it('also clears the previous-frame camera matrices', () => {
    // Reprojection reads these, and leaving them warm reprojects the first frame
    // after a reset against a camera that no longer describes it
    expect(resetBody(SRC)).toMatch(/resetPreviousMatrices\(\)/)
  })
})
