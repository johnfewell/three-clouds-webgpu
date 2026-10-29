// The guard that says a suite dirtied the tree. Its motivating defect: the e2e
// verdict test wrote the TRACKED parity/results/e2e-receipt.json in place, so a
// run killed mid-write left it modified. And it shipped once ALREADY DISABLED BY
// ACCIDENT: vitest calls setup() with the TestProject, a `root` parameter
// swallowed it, and the swallowed error became an empty baseline

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertTreeUnchanged,
  dirtyPaths,
  REPO_ROOT,
  setup,
  snapshot,
  teardown,
  treeDelta,
  TreeDirtiedError
} from './helpers/gitTreeGuard'

/** A real git repo, so git answers for real rather than being mocked */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'tree-guard-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'tree guard test')
  writeFileSync(join(root, 'tracked.txt'), 'committed\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return root
}

const temps: string[] = []
afterEach(() => {
  while (temps.length > 0)
    rmSync(temps.pop()!, { recursive: true, force: true })
})

describe('the delta names what moved, per side', () => {
  it('reports what appeared and what vanished, and only those', () => {
    expect(
      treeDelta(
        new Set([' M a.ts', ' D b.ts', '?? c.ts']),
        new Set([' M a.ts', '?? c.ts', '?? d.ts'])
      )
    ).toEqual(['+ ?? d.ts', '-  D b.ts'])
  })

  it('an unmoved tree is an empty delta, not a failure', () => {
    expect(treeDelta(new Set([' M a.ts']), new Set([' M a.ts']))).toEqual([])
    // A developer working on a dirty tree is not what the guard is for, so the
    // same dirt before and after must read as clean
    expect(treeDelta(new Set(), new Set())).toEqual([])
  })
})

describe('dirtyPaths reads porcelain, and only a non-checkout is silence', () => {
  it('names the modified and untracked paths of a real repo', () => {
    const root = repo()
    temps.push(root)
    expect([...dirtyPaths(root)!]).toEqual([])
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    writeFileSync(join(root, 'untracked.txt'), 'new\n')
    expect([...dirtyPaths(root)!].sort()).toEqual([
      ' M tracked.txt',
      '?? untracked.txt'
    ])
  })

  it('returns null where there is no checkout to compare against', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-guard-plain-'))
    temps.push(root)
    expect(dirtyPaths(root)).toBeNull()
  })

  // The swallow that hid the real defect: a bad `cwd` threw here and came back
  // as an empty set, which the guard then read as "a clean tree"
  it('refuses to answer when .git exists and git still failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-guard-brokengit-'))
    temps.push(root)
    mkdirSync(join(root, '.git'))
    expect(() => dirtyPaths(root)).toThrow()
  })
})

describe('assertTreeUnchanged is the whole guard', () => {
  it('throws a TreeDirtiedError naming the path that appeared', () => {
    const root = repo()
    temps.push(root)
    const before = dirtyPaths(root)!
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    let caught: unknown
    try {
      assertTreeUnchanged(before, root)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TreeDirtiedError)
    expect((caught as TreeDirtiedError).delta).toEqual(['+  M tracked.txt'])
    expect((caught as Error).message).toContain(' M tracked.txt')
  })

  it('passes a tree the suite restored, which is the point of restoring', () => {
    const root = repo()
    temps.push(root)
    const before = dirtyPaths(root)!
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    expect(() => assertTreeUnchanged(before, root)).toThrow(TreeDirtiedError)
    execFileSync('git', ['-C', root, 'checkout', '--', 'tracked.txt'])
    expect(() => assertTreeUnchanged(before, root)).not.toThrow()
  })
})

// THE regression. scripts/digest-parity.mjs runs vitest with `git checkout
// origin/main -- src` already applied, so the tree is dirty BEFORE vitest starts
describe('setup() ignores the argument vitest passes it', () => {
  it('a project-shaped argument does not become an empty baseline', () => {
    const failures: Error[] = []
    // Not the temp repo: this is the REPO_ROOT path vitest's own call takes
    setup()
    // Whatever dirt is already in this worktree is the BASELINE, not a delta
    // vitest calls teardown() with no argument at all, so the default root
    teardown(REPO_ROOT, e => failures.push(e))
    expect(failures).toEqual([])
  })

  it('reports a tree that moves AFTER the baseline, on that same path', () => {
    const root = repo()
    temps.push(root)
    const failures: Error[] = []
    snapshot(root)
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    teardown(root, e => failures.push(e))
    expect(failures).toHaveLength(1)
    expect((failures[0] as TreeDirtiedError).delta).toEqual([
      '+  M tracked.txt'
    ])
  })
})

// The load-bearing property one layer up: the teardown the config wires must
// FAIL on a dirtied tree, and it must do so through the exit code
describe('the wired teardown fails the run, and says so when it cannot', () => {
  it('calls onFailure with the delta when the tree moved', () => {
    const root = repo()
    temps.push(root)
    const failures: Error[] = []
    snapshot(root)
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    teardown(root, error => failures.push(error))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(TreeDirtiedError)
  })

  it('calls onFailure with nothing when the tree held still', () => {
    const root = repo()
    temps.push(root)
    const failures: Error[] = []
    snapshot(root)
    teardown(root, error => failures.push(error))
    expect(failures).toEqual([])
  })

  // Two projects share this module in one process, so both call teardown. A
  // moved tree is reported once, not once per project
  it('reports a moved tree once even when both projects check it', () => {
    const root = repo()
    temps.push(root)
    const failures: Error[] = []
    snapshot(root)
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    teardown(root, e => failures.push(e))
    teardown(root, e => failures.push(e))
    expect(failures).toHaveLength(1)
  })

  it('the default onFailure says what happened and sets a failing exit code', () => {
    const root = repo()
    temps.push(root)
    const before = process.exitCode
    const errors: string[] = []
    const spy = console.error
    console.error = (...args: unknown[]) => void errors.push(String(args[0]))
    try {
      snapshot(root)
      writeFileSync(join(root, 'tracked.txt'), 'edited\n')
      teardown(root)
      expect(process.exitCode, 'a dirtied tree must not exit 0').toBe(1)
    } finally {
      console.error = spy
      process.exitCode = before
    }
    // The failure has to NAME the path, or the run is red over a mystery
    expect(errors.join('\n')).toContain(' M tracked.txt')
  })

  it('a teardown with nothing to compare warns rather than passing silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-guard-nocache-'))
    temps.push(root)
    const errors: string[] = []
    const spy = console.error
    console.error = (...args: unknown[]) => void errors.push(String(args[0]))
    try {
      // A copied tree or a CI export has no .git, so there is no baseline
      snapshot(root)
      teardown(root, () => errors.push('SHOULD NOT BE CALLED'))
    } finally {
      console.error = spy
    }
    expect(errors.join('\n')).toContain('SKIPPED: no baseline snapshot')
  })
})
