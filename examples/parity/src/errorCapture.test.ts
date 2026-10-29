// The e2e probe's console capture must be installed before ANYTHING it must
// capture (p4 e2e test 8): declared after createSideB, it missed side
// B's boot errors and six "no console errors" checks passed on a dead side B
// Asserted on the source ordering, which a unit test cannot observe

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'main.ts'), 'utf8')
const lines = source.split('\n')

function firstLineMatching(re: RegExp): number {
  const i = lines.findIndex(l => re.test(l))
  expect(
    i,
    `no line matches ${String(re)} — has main.ts been restructured?`
  ).toBeGreaterThanOrEqual(0)
  return i
}

describe('e2e console capture ordering', () => {
  it('installs the console.error hook before side B is constructed', () => {
    const hook = firstLineMatching(/^\s*console\.error = /)
    const sideB = firstLineMatching(/await createSideB\(/)
    expect(
      hook,
      `console.error capture is installed at line ${hook + 1} but side B is ` +
        `constructed at line ${sideB + 1}. A side B that fails to initialise ` +
        `would report its error before the collector exists, leaving p.errors ` +
        `empty — and every expect(errors).toEqual([]) in the suite would pass ` +
        `with no side B at all.`
    ).toBeLessThan(sideB)
  })

  it('installs it before side A too', () => {
    const hook = firstLineMatching(/^\s*console\.error = /)
    const sideA = firstLineMatching(/createSideA\(/)
    expect(hook).toBeLessThan(sideA)
  })

  it('captures warnings on the same schedule', () => {
    const warn = firstLineMatching(/^\s*console\.warn = /)
    const sideB = firstLineMatching(/await createSideB\(/)
    expect(warn).toBeLessThan(sideB)
  })

  it('the hook is still guarded by the e2e flag', () => {
    // Hoisting it must not make every ordinary page load pay for capture, nor
    // silently retain console output for a non-e2e session
    const hook = firstLineMatching(/^\s*console\.error = /)
    const guard = lines
      .slice(0, hook)
      .reverse()
      .findIndex(l => /if \(params\.e2e\)/.test(l))
    expect(
      guard,
      'the hoisted collector must stay inside an `if (params.e2e)` guard'
    ).toBeGreaterThanOrEqual(0)
  })
})
