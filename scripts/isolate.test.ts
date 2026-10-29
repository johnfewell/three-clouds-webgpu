// isolate.sh's refusal path, exercised. A worktree inheriting
// another tree's node_modules measures THAT tree with no symptom, via the
// relative self-link. The positive control (the correct layout exits 0 in the
// same run) is what makes a non-zero exit a refusal rather than any failure

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from '../test/helpers/cpuTwin'

const SCRIPT = join(__dirname, 'isolate.sh')

interface Run {
  status: number
  out: string
}

function runMode(mode: string, target: string): Run {
  try {
    const out = execFileSync('sh', [SCRIPT, mode, target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return {
      status: err.status ?? -1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }
}

function runVerifyLink(worktree: string): Run {
  try {
    const out = execFileSync('sh', [SCRIPT, 'verify-link', worktree], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return {
      status: err.status ?? -1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }
}

/** A worktree-shaped directory. `linkTo` null means: no self-link at all. */
function workspaceFixture(withMarker: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'isolate-ws-'))
  const wt = join(root, 'tree')
  mkdirSync(wt, { recursive: true })
  // The ANCESTOR always has one, so "no marker of its own" is exactly the
  // copied-tree shape: pnpm walks up and installs into the ancestor instead
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
  if (withMarker) {
    writeFileSync(join(wt, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
  }
  return wt
}

function fixture(linkTo: 'self' | 'elsewhere' | null): string {
  const root = mkdtempSync(join(tmpdir(), 'isolate-'))
  const wt = join(root, 'worktree')
  const modules = join(wt, 'examples', 'parity', 'node_modules')
  mkdirSync(modules, { recursive: true })

  if (linkTo === 'self') {
    // Exactly the real layout: RELATIVE, three levels up from node_modules
    symlinkSync('../../..', join(modules, 'three-clouds-webgpu'))
  } else if (linkTo === 'elsewhere') {
    // The 2026-09-02 shape: a link into a different tree entirely
    const other = join(root, 'other-tree')
    mkdirSync(other, { recursive: true })
    symlinkSync(other, join(modules, 'three-clouds-webgpu'))
  }
  return wt
}

describe('isolate.sh refuses a self-link into another tree', () => {
  it('REFUSES, non-zero and by name, when the link resolves elsewhere', () => {
    const r = runVerifyLink(fixture('elsewhere'))
    expect(
      r.status,
      `expected a non-zero exit, got ${r.status}:\n${r.out}`
    ).not.toBe(0)
    // The message matters as much as the code: it is what distinguishes this
    // refusal from every other way the script could exit non-zero
    expect(r.out).toContain(
      'REFUSE: self-link does not resolve to this worktree'
    )
  })

  it('POSITIVE CONTROL: accepts the correct relative self-link', () => {
    const r = runVerifyLink(fixture('self'))
    expect(
      r.status,
      'the correct layout must PASS — without this the refusal arm above is ' +
        `satisfied by any failure to run at all:\n${r.out}`
    ).toBe(0)
    expect(r.out).toContain('self-link OK')
    expect(r.out).not.toContain('REFUSE')
  })

  it('REFUSES a MISSING link by name, not by dying on `cd`', () => {
    // Absence must be reported, not stumbled over. Under `set -e` the original
    // cd'd straight into the path and died on the shell's own "no such file",
    // so the commonest failure produced the least legible output
    const r = runVerifyLink(fixture(null))
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('REFUSE: self-link missing')
  })

  it('WIRING: the full install path runs the same check, not a copy', () => {
    // verify-link is worthless if the real path keeps its own inline copy of
    // the comparison: the test would pass while the script drifted. Assert the
    // full path CALLS the function
    const source = readFileSync(SCRIPT, 'utf8')
    const code = source
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n')

    const installAt = code.indexOf('pnpm install --frozen-lockfile')
    expect(
      installAt,
      'anchor `pnpm install --frozen-lockfile` not found — this guard is ' +
        'stale, which is not the same as the script being correct'
    ).toBeGreaterThan(-1)

    expect(
      code.slice(installAt),
      'the post-install path must call verify_link, so verify-link mode and ' +
        'the real run cannot diverge'
    ).toMatch(/^\s*verify_link\s+\./m)
  })
})

// the 2026-09-24 install ran THROUGH node_modules symlinks the
// quarantine never covered, printing ISOLATION VERIFIED while repointing the
// SHARED checkout's example package links. Every fixture below lives in tmpdir
describe('isolate.sh detaches EVERY workspace package, not root and parity', () => {
  it('REFUSES a marker with no derivable package patterns', () => {
    // A sweep that derived an empty list would detach nothing and read as
    // "nothing was attached", which is the 2026-09-24 shape wearing a pass
    const wt = multiFixture()
    writeFileSync(
      join(wt, 'pnpm-workspace.yaml'),
      'allowBuilds:\n  esbuild: true\n'
    )
    const r = runMode('detach', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain('no workspace package patterns')
  })

  it('REFUSES while a non-parity example link is still under the worktree', () => {
    // The hole itself: examples/basic/node_modules is a symlink, so pnpm
    // installs THROUGH it into the tree it names
    const wt = multiFixture({ linkExample: 'basic' })
    const r = runMode('verify-leftovers', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain('REFUSE: node_modules symlinks remain')
    // The refusal must NAME the path, or an operator cannot act on it
    expect(r.out).toContain(join('examples', 'basic', 'node_modules'))
  })

  it('POSITIVE CONTROL: a tree with no linked node_modules passes', () => {
    // Without this the refusal arm above is satisfied by any failure to run
    const wt = multiFixture()
    const r = runMode('verify-leftovers', wt)
    expect(r.status, `the clean shape must PASS:\n${r.out}`).toBe(0)
    expect(r.out).toContain('linked node_modules     : none')
    expect(r.out).not.toContain('REFUSE')
  })

  it('a REAL node_modules directory is not a symlink and must not be refused', () => {
    // pnpm owns a real directory, only a symlink is a hole into another tree
    const wt = multiFixture({ realExample: 'r3f' })
    const r = runMode('verify-leftovers', wt)
    expect(r.status, `a real directory must PASS:\n${r.out}`).toBe(0)
    expect(r.out).toContain('none under the worktree')
  })

  it('detaches the extra example link, not just the root and parity ones', () => {
    const wt = multiFixture({ linkExample: 'storybook' })
    const r = runMode('detach', wt)
    expect(r.status, `detach must succeed on a sweepable tree:\n${r.out}`).toBe(
      0
    )
    expect(r.out).toContain('detached inherited')
    // The link is GONE from the worktree, and the target is untouched: the
    // sweep moves the LINK, never the tree it names
    expect(
      lstatSync(join(wt, 'examples', 'storybook', 'node_modules'), {
        throwIfNoEntry: false
      })
    ).toBeUndefined()
    expect(
      existsSync(join(sharedOf(wt), 'examples', 'storybook', 'sentinel'))
    ).toBe(true)
    // And the detach is followed by the independent check, which now passes
    expect(runMode('verify-leftovers', wt).status).toBe(0)
  })

  it('reports the derived package count rather than detaching in silence', () => {
    // Any derivation that can legitimately produce an empty list
    // must say so out loud
    const wt = multiFixture()
    const r = runMode('detach', wt)
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/workspace packages\s+: \d+ present, 0 detached/)
  })

  it('WIRING: detach and the leftover check run BEFORE the install', () => {
    // Both after the install would be a description of a tree pnpm had
    // already written through
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n')
    const installAt = code.indexOf('pnpm install --frozen-lockfile')
    expect(
      installAt,
      'install anchor not found — this guard is stale'
    ).toBeGreaterThan(-1)
    for (const call of ['detach_inherited .', 'verify_no_linked_modules .']) {
      const at = code.indexOf(call)
      expect(at, `install path does not call ${call}`).toBeGreaterThan(-1)
      expect(at, `${call} must run BEFORE pnpm install`).toBeLessThan(installAt)
    }
  })
})

// The same incident seen from the other side: a tree can pass every check
// scoped to itself while its links point INTO this worktree. That is what the
// 2026-09-24 install left behind, and it is what made the shared checkout red
describe('isolate.sh looks outward at sibling worktrees', () => {
  it('REFUSES when a sibling tree self-link resolves into this worktree', () => {
    const { shared, wt } = gitFixture()
    // The exact damage: shared's example self-link aimed at the worktree
    symlinkSync(
      wt,
      join(shared, 'examples', 'basic', 'node_modules', 'three-clouds-webgpu')
    )
    const r = runMode('verify-outward', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain(
      'REFUSE: links in OTHER trees resolve into this worktree'
    )
    expect(r.out).toContain(join('examples', 'basic', 'node_modules'))
  })

  it('REFUSES a NON-self dependency link into this worktree', () => {
    // The install rewrote every dependency link, not only the self-link
    const { shared, wt } = gitFixture()
    mkdirSync(join(wt, 'build'), { recursive: true })
    symlinkSync(
      join(wt, 'build'),
      join(shared, 'examples', 'r3f', 'node_modules', 'three')
    )
    const r = runMode('verify-outward', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain(
      'REFUSE: links in OTHER trees resolve into this worktree'
    )
  })

  it('REFUSES a DANGLING link that names this worktree', () => {
    // A link into a path that no longer exists resolves nowhere, so a
    // resolve-only check would pass it. The install leaves exactly this:
    // ../../../../wt-sky/build, after the worktree moved
    const { shared, wt } = gitFixture()
    symlinkSync(
      join(wt, 'gone'),
      join(shared, 'examples', 'basic', 'node_modules', 'three')
    )
    const r = runMode('verify-outward', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain(
      'REFUSE: links in OTHER trees resolve into this worktree'
    )
  })

  it('reports a path CONTAINING A SPACE intact, not split into fragments', () => {
    // The report is operator instructions. A path mangled by word splitting
    // into a bare "->" line cannot be acted on, and the failure is silent:
    // the check still refuses, just unintelligibly
    const { shared, wt } = gitFixture({ spaced: true })
    const spaced = join(shared, 'examples', 'basic', 'node_modules')
    const link = join(spaced, 'three-clouds-webgpu')
    symlinkSync(wt, link)
    const r = runMode('verify-outward', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain(link)
    // No orphaned arrow, the tell that a path was split
    expect(r.out).not.toMatch(/^\s*->\s*$/m)
  })

  it('POSITIVE CONTROL: a sibling pointing at ITSELF is fine', () => {
    // The correct layout is each tree's self-link relative to itself. Refusing
    // that would make the check useless and stop every real run
    const { shared, wt } = gitFixture()
    symlinkSync(
      '../../..',
      join(shared, 'examples', 'basic', 'node_modules', 'three-clouds-webgpu')
    )
    const r = runMode('verify-outward', wt)
    expect(r.status, `the correct layout must PASS:\n${r.out}`).toBe(0)
    expect(r.out).toContain('no sibling points here : OK')
    expect(r.out).not.toContain('REFUSE')
  })

  it('REFUSES an EMPTY derivation rather than reporting a vacuous pass', () => {
    // Not a git worktree: `git worktree list` yields nothing, so the loop
    // would check zero trees and print OK. Silence is not a pass
    const wt = multiFixture()
    const r = runMode('verify-outward', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain('outward check is EMPTY')
  })

  it('WIRING: the install path runs the outward check, not a copy of it', () => {
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n')
    const installAt = code.indexOf('pnpm install --frozen-lockfile')
    const at = code.indexOf('verify_outward .')
    expect(
      at,
      'the outward check is not wired into the install path'
    ).toBeGreaterThan(-1)
    expect(
      at,
      'the outward check must run AFTER the install it judges'
    ).toBeGreaterThan(installAt)
  })
})

/** A worktree-shaped tree: own pnpm-workspace.yaml plus four example packages */
function multiFixture(
  opts: { linkExample?: string; realExample?: string } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), 'isolate-multi-'))
  const wt = join(root, 'tree')
  mkdirSync(wt, { recursive: true })
  writeFileSync(
    join(wt, 'pnpm-workspace.yaml'),
    "packages:\n  - '.'\n  - 'examples/*'\n"
  )
  for (const ex of ['basic', 'parity', 'r3f', 'storybook']) {
    mkdirSync(join(wt, 'examples', ex), { recursive: true })
  }
  if (opts.realExample) {
    mkdirSync(join(wt, 'examples', opts.realExample, 'node_modules'), {
      recursive: true
    })
  }
  if (opts.linkExample) {
    // The leftover the 2026-09-02 recipe leaves: a link into another tree
    const target = join(root, 'other-tree')
    mkdirSync(join(target, 'examples', 'storybook'), { recursive: true })
    writeFileSync(join(target, 'examples', 'storybook', 'sentinel'), 'x')
    symlinkSync(target, join(wt, 'examples', opts.linkExample, 'node_modules'))
  }
  return wt
}

/** The tree a multiFixture's extra link points at, for the "target untouched" check */
function sharedOf(wt: string): string {
  return join(dirname(wt), 'other-tree')
}

/**
 * A real git repo with a real linked worktree, because verify_outward reads
 * `git worktree list`. The shared tree stands in for the checkout the
 * 2026-09-24 install damaged, and lives in tmpdir, not in the repo this suite
 * runs from.
 */
function gitFixture(opts: { spaced?: boolean } = {}): {
  shared: string
  wt: string
} {
  const root = mkdtempSync(join(tmpdir(), 'isolate-git-'))
  // A space in the tree name is the shape that breaks a word-splitting report
  const base = opts.spaced ? join(root, 'a shared tree') : root
  mkdirSync(base, { recursive: true })
  const shared = join(base, 'shared')
  const wt = join(base, 'tree')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', shared, ...args], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
  mkdirSync(shared, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'isolate test')
  writeFileSync(join(shared, 'README.md'), 'x')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('worktree', 'add', '-q', wt, '-b', 'bead/test')
  for (const tree of [shared, wt]) {
    writeFileSync(
      join(tree, 'pnpm-workspace.yaml'),
      "packages:\n  - '.'\n  - 'examples/*'\n"
    )
    for (const ex of ['basic', 'r3f']) {
      mkdirSync(join(tree, 'examples', ex, 'node_modules'), { recursive: true })
    }
  }
  return { shared, wt }
}

// Fallout: isolate.sh only checked the tree it was given, so a tree
// whose pnpm workspace root lies elsewhere could install into THAT tree and
// still report ISOLATION VERIFIED (main went red with TS2305 that way)
describe('isolate.sh refuses a tree whose workspace root is elsewhere', () => {
  it('REFUSES a tree with no pnpm-workspace.yaml of its own', () => {
    const r = runMode('verify-workspace', workspaceFixture(false))
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain('has no pnpm-workspace.yaml of its own')
  })

  it('POSITIVE CONTROL: accepts a tree that carries its own marker', () => {
    const r = runMode('verify-workspace', workspaceFixture(true))
    expect(
      r.status,
      'a self-contained tree must PASS — without this the refusal arm above ' +
        `is satisfied by any failure to run:\n${r.out}`
    ).toBe(0)
    expect(r.out).toContain('workspace root')
  })

  it('WIRING: the install path checks the workspace root BEFORE installing', () => {
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n')
    const guardAt = code.indexOf('verify_workspace_root .')
    const installAt = code.indexOf('pnpm install --frozen-lockfile')
    expect(guardAt, 'guard call not found in the install path').toBeGreaterThan(
      -1
    )
    expect(
      installAt,
      'install anchor not found — this guard is stale'
    ).toBeGreaterThan(-1)
    // Order matters: checking AFTER the install would report a tree the
    // install had already written to
    expect(guardAt).toBeLessThan(installAt)
  })
})

// The SECOND cause of TS2305: a stale untracked types/ behind a CORRECT link
// verify_link cannot see, so a link-only check reports OK
describe('isolate.sh names WHICH cause of TS2305 a tree has', () => {
  // The mtime ladder, oldest first. A test that adds a file stamps it ADDED, so
  // only the exclusion under test can clear a test-only edit
  const MTIME = { src: 1000, decl: 2000, libEdit: 3000, ADDED: 4000 }

  /** A self-contained tree: own marker, own src/, own types/, correct link */
  function typesFixture(
    opts: {
      staleTypes?: boolean
      unbuilt?: boolean
      foreign?: boolean
      spaced?: boolean
    } = {}
  ): string {
    const root = mkdtempSync(join(tmpdir(), 'isolate-types-'))
    // A space in the tree name is the shape that word-splits a path
    const wt = join(root, opts.spaced === true ? 'a tree' : 'tree')
    const modules = join(wt, 'examples', 'parity', 'node_modules')
    mkdirSync(modules, { recursive: true })
    writeFileSync(join(wt, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'index.ts'), 'export const a = 1\n')
    if (opts.unbuilt !== true) {
      mkdirSync(join(wt, 'types'), { recursive: true })
      writeFileSync(
        join(wt, 'types', 'index.d.ts'),
        'export declare const a = 1;\n'
      )
    }
    if (opts.foreign === true) {
      const other = join(root, 'foreign')
      mkdirSync(join(other, 'types'), { recursive: true })
      writeFileSync(join(other, 'types', 'index.d.ts'), 'export {};\n')
      symlinkSync(other, join(modules, 'three-clouds-webgpu'))
    } else {
      symlinkSync('../../..', join(modules, 'three-clouds-webgpu'))
    }
    // src older than types, so the default fixture reads FRESH. Never
    // Date.now(): `-nt` is strictly newer, so same-second files are ambiguous
    // and two arms of this suite were green vacuously for that reason alone
    if (opts.unbuilt !== true) {
      utimesSync(join(wt, 'src', 'index.ts'), MTIME.src, MTIME.src)
      utimesSync(join(wt, 'types', 'index.d.ts'), MTIME.decl, MTIME.decl)
    }
    if (opts.staleTypes === true) {
      utimesSync(join(wt, 'src', 'index.ts'), MTIME.libEdit, MTIME.libEdit)
    }
    return wt
  }

  it('REFUSES stale types behind a CORRECT link, by name', () => {
    // The case isolate.sh previously could not see at all: verify_link passes
    // here, so a link-only check says OK and the reader keeps editing source
    const r = runMode('verify-types', typesFixture({ staleTypes: true }))
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain(
      'REFUSE: types/ is STALE behind a correct self-link'
    )
    // The fix must be named, and it is NOT an edit to src/index.ts
    expect(r.out).toContain('pnpm build')
    expect(r.out).toContain('NOT a source')
  })

  it('a FOREIGN link is reported as a LINK problem, not a rebuild', () => {
    // The two causes need different fixes. Telling this reader to run
    // `pnpm build` would rebuild the right tree and change nothing
    const r = runMode('verify-types', typesFixture({ foreign: true }))
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain('self-link does not resolve to this worktree')
    expect(r.out).toContain('LINK problem, not a stale-build one')
    expect(r.out).not.toContain('STALE behind a correct self-link')
  })

  it('POSITIVE CONTROL: a fresh tree passes', () => {
    const r = runMode('verify-types', typesFixture())
    expect(
      r.status,
      `a fresh tree must PASS, or the check would be switched off:\n${r.out}`
    ).toBe(0)
    expect(r.out).toContain('fresh')
    expect(r.out).not.toContain('REFUSE')
  })

  // Absence is not staleness: a tree that has never been built has nothing to
  // be stale, and `pnpm typecheck` builds before it typechecks
  it('an UNBUILT tree is not stale, and says so', () => {
    const r = runMode('verify-types', typesFixture({ unbuilt: true }))
    expect(r.status, `expected 0, got ${r.status}:\n${r.out}`).toBe(0)
    expect(r.out).toContain('absent')
    expect(r.out).toContain('pnpm typecheck')
    expect(r.out).not.toContain('REFUSE')
  })

  // This fleet's tree paths contain spaces, and piping find into `xargs ls`
  // word-splits them, so every comparison read "unreadable" and the check
  // refused for the wrong reason on the paths it exists to inspect
  it('judges freshness in a tree path containing a SPACE', () => {
    const stale = typesFixture({ staleTypes: true, spaced: true })
    const r = runMode('verify-types', stale)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    // The STALE verdict, not the unreadable fallback, and the path printed
    // intact so the reader can act on it
    expect(r.out).toContain(
      'REFUSE: types/ is STALE behind a correct self-link'
    )
    expect(r.out).not.toContain('cannot judge freshness')
    expect(r.out).toContain('a tree')
    // Same tree, declarations refreshed: fresh, and for the right reason
    const built = typesFixture({ spaced: true })
    expect(runMode('verify-types', built).status).toBe(0)
  })

  // Finding 1 (oc_12): 75 of this tree's 144 .ts files under src/ are tests,
  // so counting them made a test edit refuse and blame a stale build for it
  it('a TEST edit is not a stale build, and says so', () => {
    const wt = typesFixture()
    const test = join(wt, 'src', 'module.test.ts')
    writeFileSync(test, 'import { a } from "./index"\n')
    utimesSync(test, MTIME.ADDED, MTIME.ADDED)
    const r = runMode('verify-types', wt)
    table('verify-types-test-edit', [
      { field: 'exit code', expected: 0, actual: r.status },
      {
        field: 'reports fresh',
        expected: true,
        actual: r.out.includes('fresh')
      },
      {
        field: 'no stale verdict',
        expected: false,
        actual: r.out.includes('STALE')
      }
    ])
    expect(
      r.status,
      `a test-only edit must NOT read as a stale build:\n${r.out}`
    ).toBe(0)
    expect(r.out).toContain('fresh')
    expect(r.out).not.toContain('STALE')
  })

  // *.dom.test.ts lives under src/ too, so the exclusion must cover it
  it('a DOM-test edit is not a stale build either', () => {
    const wt = typesFixture()
    const test = join(wt, 'src', 'thing.dom.test.ts')
    writeFileSync(test, 'it("x", () => {})\n')
    utimesSync(test, MTIME.ADDED, MTIME.ADDED)
    const r = runMode('verify-types', wt)
    expect(r.status, `expected 0, got ${r.status}:\n${r.out}`).toBe(0)
    expect(r.out).toContain('fresh')
  })

  // The exclusion must not swallow the real case: a LIBRARY edit still refuses
  it('a LIBRARY edit still refuses', () => {
    const wt = typesFixture()
    const mod = join(wt, 'src', 'module.ts')
    writeFileSync(mod, 'export const b = 2\n')
    utimesSync(mod, MTIME.ADDED, MTIME.ADDED)
    const r = runMode('verify-types', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain(
      'REFUSE: types/ is STALE behind a correct self-link'
    )
  })

  // mtime is only meaningful if BOTH sides exist. A fixture with no source
  // must not read as "fresh" by finding nothing to compare
  it('refuses to judge freshness it cannot measure', () => {
    const wt = typesFixture()
    rmSync(join(wt, 'src'), { recursive: true, force: true })
    const r = runMode('verify-types', wt)
    expect(r.status, `expected non-zero, got ${r.status}:\n${r.out}`).not.toBe(
      0
    )
    expect(r.out).toContain('cannot judge freshness')
  })
})
