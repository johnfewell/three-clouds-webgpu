// a broken module graph in the
// consumer examples is a real defect (r3f once imported four symbols from the
// wrong module), while Node-generic errors are version skew we do not control
// `@ts-expect-error` has no code-scoped form, so the split lives here
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkProjects,
  DENY_CODES,
  preflight,
  SKEW_CODES
} from '../scripts/port-gates/example-diagnostics.mjs'

const temps: string[] = []
afterEach(() => {
  while (temps.length > 0)
    rmSync(temps.pop()!, { recursive: true, force: true })
})

/** A one-file project whose only diagnostics are the ones we plant */
function project(source: string): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'example-diag-'))
  temps.push(dir)
  writeFileSync(join(dir, 'a.ts'), 'export const present = 1\n')
  writeFileSync(join(dir, 'main.ts'), source)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler'
      },
      files: ['a.ts', 'main.ts']
    })
  )
  return { dir, config: join(dir, 'tsconfig.json') }
}

const DENY_SOURCE = "import { absent } from './a'\nexport const used = absent\n"
const SKEW_SOURCE = 'export const s: string = 1\n'

describe('the deny class is unwaivable', () => {
  it('a missing export fails even when a waiver names it exactly', () => {
    const { dir, config } = project(DENY_SOURCE)
    const waiver = [
      { file: 'main.ts', code: 2305, anchor: "import { absent } from './a'" }
    ]
    const { ok, failures, counts } = checkProjects([config], waiver, dir)
    console.table([{ deny: counts.deny, waived: counts.waived, ok }])
    expect(counts.deny).toBe(1)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('REAL DEFECT')
  })

  it('every deny code is disjoint from every skew code', () => {
    const overlap = [...DENY_CODES.keys()].filter(c => SKEW_CODES.has(c))
    expect(overlap).toEqual([])
  })
})

describe('the skew class is waivable, but only exactly', () => {
  it('passes when a waiver matches file, code and content', () => {
    const { dir, config } = project(SKEW_SOURCE)
    const waiver = [
      { file: 'main.ts', code: 2322, anchor: 'export const s: string = 1' }
    ]
    const { ok, counts } = checkProjects([config], waiver, dir)
    expect(counts.waived).toBe(1)
    expect(ok).toBe(true)
  })

  it('fails when the same error carries no waiver', () => {
    const { dir, config } = project(SKEW_SOURCE)
    const { ok, failures } = checkProjects([config], [], dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('UNWAIVED SKEW')
  })

  // TealAnchor's condition: a waiver nobody can retire is a permanent green over
  // unknown ground. When upstream ships compatible builds these stop matching.
  it('FAILS when a waived error stops occurring', () => {
    const { dir, config } = project('export const s: string = "fine"\n')
    const waiver = [
      { file: 'main.ts', code: 2322, anchor: 'export const s: string = 1' }
    ]
    const { ok, failures } = checkProjects([config], waiver, dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('STALE WAIVER')
  })
})

describe('the waiver anchor is content, not a line number', () => {
  it('still matches after unrelated lines are inserted above it', () => {
    const { dir, config } = project('// one\n// two\n// three\n' + SKEW_SOURCE)
    const waiver = [
      { file: 'main.ts', code: 2322, anchor: 'export const s: string = 1' }
    ]
    expect(checkProjects([config], waiver, dir).ok).toBe(true)
  })

  it('stops matching when the offending statement itself changes', () => {
    const { dir, config } = project('export const renamed: string = 1\n')
    const waiver = [
      { file: 'main.ts', code: 2322, anchor: 'export const s: string = 1' }
    ]
    const { ok, failures } = checkProjects([config], waiver, dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('STALE WAIVER')
  })
})

describe('an unfamiliar diagnostic is triaged, never absorbed', () => {
  it('fails on a code in neither class', () => {
    const { dir, config } = project('export const x = notDefinedAnywhere\n')
    const { ok, failures, counts } = checkProjects([config], [], dir)
    expect(counts.unclassified).toBeGreaterThan(0)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('UNCLASSIFIED')
  })
})

describe('preflight refuses rather than crying wolf', () => {
  it('refuses when the library types are absent, because every import would read as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'example-diag-pf-'))
    temps.push(dir)
    expect(preflight(dir)).toContain('pnpm build')
  })

  it('is satisfied by this repository, which is built', () => {
    expect(preflight(join(import.meta.dirname, '..'))).toBeNull()
  })
})
