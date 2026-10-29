// a receipt must NAME the tree it measured, and the capture refuses a
// tree off this lineage. servedIsBuilt compares digests only, blind to history.
// The 2026-09-02 defect: a relative self-link served a tree 11 commits off
// main. Real git trees and a real symlink, since a mocked resolver tests the
// mock

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  refuseUnlessServedIsAncestor,
  refuseUnlessServedIsSelf,
  servedTreeState
} from '../scripts/captureProvenance.mjs'

const PKG = 'three-clouds-webgpu'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real, self-contained git repo with one commit */
function makeRepo(label: string): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), `t8ep-${label}-`))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 't8ep@example.invalid'])
  git(root, ['config', 'user.name', 't8ep'])
  writeFileSync(join(root, 'marker.txt'), label)
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', `${label} commit`])
  return { root, head: git(root, ['rev-parse', 'HEAD']) }
}

/** An exampleRoot whose node_modules/<pkg> points at `target` */
function exampleRootLinkedTo(target: string): string {
  const example = mkdtempSync(join(tmpdir(), 't8ep-example-'))
  mkdirSync(join(example, 'node_modules'), { recursive: true })
  symlinkSync(target, join(example, 'node_modules', PKG))
  return example
}

describe('served-tree provenance', () => {
  it('names the resolved path and that tree HEAD', () => {
    const repo = makeRepo('served')
    const state = servedTreeState(exampleRootLinkedTo(repo.root), PKG)
    expect(state.error).toBeNull()
    expect(state.head).toBe(repo.head)
    // realpath, so compare by suffix rather than by string identity (/private
    // vs /var on darwin)
    expect(state.root).toContain('t8ep-served-')
  })

  it('ACCEPTS a served tree whose HEAD is an ancestor of the SHA under test', () => {
    const repo = makeRepo('ancestor')
    // Advance the project past the served commit: served is now a true ancestor
    writeFileSync(join(repo.root, 'later.txt'), 'later')
    git(repo.root, ['add', '.'])
    git(repo.root, ['commit', '-qm', 'later commit'])
    const later = git(repo.root, ['rev-parse', 'HEAD'])

    const provenance = {
      servedTree: { root: repo.root, head: repo.head, error: null }
    }
    expect(() =>
      refuseUnlessServedIsAncestor(provenance, later, repo.root)
    ).not.toThrow()
  })

  // THE RED PROOF. Reverting the ancestry check makes exactly this pass.
  it('REFUSES a served tree that is not an ancestor — the stale-link shape', () => {
    const ours = makeRepo('ours')
    // unrelated history, no common commit
    const theirs = makeRepo('theirs')

    const provenance = {
      servedTree: { root: theirs.root, head: theirs.head, error: null }
    }
    expect(() =>
      refuseUnlessServedIsAncestor(provenance, ours.head, ours.root)
    ).toThrow(/NOT an ancestor of the SHA under test/)
    // The message must name BOTH trees, or a reader cannot act on it
    expect(() =>
      refuseUnlessServedIsAncestor(provenance, ours.head, ours.root)
    ).toThrow(new RegExp(theirs.head.slice(0, 7)))
  })

  // Absence must refuse, not pass. Each of these "looks like nothing" and is
  // exactly when a silent pass is most expensive
  it('REFUSES when the link cannot be resolved at all', () => {
    const example = mkdtempSync(join(tmpdir(), 't8ep-noresolve-'))
    mkdirSync(join(example, 'node_modules'), { recursive: true })
    const state = servedTreeState(example, PKG)
    expect(state.root).toBeNull()
    expect(() =>
      refuseUnlessServedIsAncestor({ servedTree: state }, 'deadbee', example)
    ).toThrow(/cannot resolve the served package tree/)
  })

  it('REFUSES when the served path is not a git tree', () => {
    const plain = mkdtempSync(join(tmpdir(), 't8ep-plain-'))
    const state = servedTreeState(exampleRootLinkedTo(plain), PKG)
    expect(state.root).not.toBeNull()
    expect(state.head).toBeNull()
    expect(() =>
      refuseUnlessServedIsAncestor({ servedTree: state }, 'deadbee', plain)
    ).toThrow(/no .*readable git HEAD|cannot be placed in any lineage/)
  })

  it('REFUSES when no SHA under test is supplied', () => {
    const repo = makeRepo('nosha')
    const provenance = {
      servedTree: { root: repo.root, head: repo.head, error: null }
    }
    expect(() =>
      refuseUnlessServedIsAncestor(provenance, '', repo.root)
    ).toThrow(/no SHA under test/)
  })
})

// served tree IDENTITY, which lineage does not give: the tree that
// RUNS the capture must be the tree whose bytes are SERVED. Real fixtures,
// since the fault guarded is a resolution fault
describe('served-tree identity', () => {
  /** A linked worktree of `repo`, i.e. a real `.git` FILE, not a directory. */
  function makeWorktree(repo: string, label: string): string {
    const wt = join(mkdtempSync(join(tmpdir(), `8hpo-${label}-`)), 'wt')
    git(repo, ['worktree', 'add', '--detach', '-q', wt])
    return wt
  }

  // POSITIVE CONTROL, not optional: a refusal test asserting only "it threw"
  // passes on a typo or an absent fixture. If the correct shape does
  // not pass, the red proofs below prove nothing
  it('ACCEPTS a tree that serves itself — the correct shape', () => {
    const repo = makeRepo('self')
    const example = exampleRootLinkedTo(repo.root)
    const state = servedTreeState(example, PKG)
    expect(state.root).not.toBeNull()
    expect(() =>
      refuseUnlessServedIsSelf({ servedTree: state }, repo.root)
    ).not.toThrow()
  })

  // Second control: <tmp> is a symlink to <tmp-2> on darwin, so a guard
  // that compared raw strings would refuse EVERY correctly-linked temp worktree
  // and be switched off within a day. Assert the resolution explicitly.
  it('ACCEPTS when the two paths differ only by symlink resolution', () => {
    const repo = makeRepo('realpath')
    const state = servedTreeState(exampleRootLinkedTo(repo.root), PKG)
    const unresolved = join(repo.root, 'sub', '..')
    expect(() =>
      refuseUnlessServedIsSelf({ servedTree: state }, unresolved)
    ).not.toThrow()
  })

  // DIRECTION 1: this tree's link points INTO a foreign tree
  // The 2026-09-03 shape: an isolate run repointed the shared checkout's link
  // at its own temp worktree and left it there
  it('REFUSES direction 1 — serving a foreign tree — and names it', () => {
    const ours = makeRepo('dir1-ours')
    const foreign = makeRepo('dir1-foreign')
    const state = servedTreeState(exampleRootLinkedTo(foreign.root), PKG)

    expect(() =>
      refuseUnlessServedIsSelf({ servedTree: state }, ours.root)
    ).toThrow(/would measure bytes served from/)
    // Must name the foreign tree, or the reader cannot act on it
    expect(() =>
      refuseUnlessServedIsSelf({ servedTree: state }, ours.root)
    ).toThrow(new RegExp('dir1-foreign'))
    // and must name the fix
    expect(() =>
      refuseUnlessServedIsSelf({ servedTree: state }, ours.root)
    ).toThrow(/verify-link/)
  })

  // DIRECTION 2, THE ARM THAT MATTERS: a worktree serving the shared checkout
  // at the SAME commit. The ancestor check must PASS (the gap is real) while
  // the identity check REFUSES, asserted both ways in one test
  it('REFUSES direction 2 — a worktree serving the shared checkout — where the ancestor check PASSES', () => {
    const main = makeRepo('dir2-main')
    const wt = makeWorktree(main.root, 'dir2')
    // The worktree is at the SAME commit as the checkout it is borrowing
    const state = servedTreeState(exampleRootLinkedTo(main.root), PKG)
    expect(state.head).toBe(main.head)

    // The existing guard is satisfied: a commit is its own ancestor
    expect(() =>
      refuseUnlessServedIsAncestor({ servedTree: state }, main.head, wt)
    ).not.toThrow()

    // The new one is not
    expect(() => refuseUnlessServedIsSelf({ servedTree: state }, wt)).toThrow(
      /serving the SHARED CHECKOUT/
    )
    // and names the fix for THIS direction, which differs from direction 1's
    expect(() => refuseUnlessServedIsSelf({ servedTree: state }, wt)).toThrow(
      /isolate\.sh/
    )
  })

  it('REFUSES when the served tree cannot be resolved — absence is not a pass', () => {
    const example = mkdtempSync(join(tmpdir(), '8hpo-noresolve-'))
    mkdirSync(join(example, 'node_modules'), { recursive: true })
    const state = servedTreeState(example, PKG)
    expect(state.root).toBeNull()
    expect(() =>
      refuseUnlessServedIsSelf({ servedTree: state }, example)
    ).toThrow(/cannot resolve the served package tree/)
  })
})
