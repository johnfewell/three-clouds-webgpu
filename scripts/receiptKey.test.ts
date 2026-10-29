// the receipt-key tool refuses the two keys that lie. Real git repos,
// since a mocked git would test the mock. The load-bearing arm is the
// calibration: `keyFromCommit` must EQUAL the shared `keyCommand()` hash on a
// clean tree, or every key quoted from the commit form is wrong

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  keyFromCommit,
  keyFromWorktree,
  keyPathsDirty
} from './receipt-key.mjs'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A repo containing real KEY_PATHS files, committed */
function makeRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), '27m0-'))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', '27m0@example.invalid'])
  git(root, ['config', 'user.name', '27m0'])
  // Two different KEY_PATHS entries: a directory one and a file one, so the
  // sweep is exercised over both shapes
  for (const p of ['src/a.ts', 'examples/parity/src/b.ts']) {
    mkdirSync(join(root, dirname(p)), { recursive: true })
    writeFileSync(join(root, p), `// ${p}\n`)
  }
  writeFileSync(join(root, 'vitest.config.ts'), 'export default {}\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'fixture'])
  return { root, head: git(root, ['rev-parse', 'HEAD']) }
}

describe('receipt-key refuses the keys that lie', () => {
  it('CALIBRATION: the commit form equals the working-tree form on a clean tree', () => {
    const repo = makeRepo()
    const tree = keyFromWorktree(repo.root)
    const commit = keyFromCommit(repo.root, repo.head)
    expect(tree.count).toBeGreaterThan(0)
    expect(commit.count).toBe(tree.count)
    expect(commit.key).toBe(tree.key)
  })

  // POSITIVE CONTROL for the refusal below: a clean tree must NOT throw, or
  // "it refused" would prove only that something was broken
  it('accepts a clean tree', () => {
    const repo = makeRepo()
    expect(keyPathsDirty(repo.root)).toEqual([])
    expect(() => keyFromWorktree(repo.root)).not.toThrow()
  })

  it('REFUSES a working-tree key when a KEY_PATH is dirty, and names the file', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'src/a.ts'), '// modified\n')
    expect(keyPathsDirty(repo.root)).toHaveLength(1)
    expect(() => keyFromWorktree(repo.root)).toThrow(/Refusing/)
    expect(() => keyFromWorktree(repo.root)).toThrow(/src\/a\.ts/)
    // and it must say what to do instead, or the refusal just relocates the problem
    expect(() => keyFromWorktree(repo.root)).toThrow(/pass a commit-ish|<sha>/)
  })

  it('REFUSES for an UNTRACKED file under a KEY_PATH too', () => {
    // An untracked source file changes what the suite compiles as much as a
    // modified one, and `git ls-files` would not see it, so the key would
    // silently omit it
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'src/new.ts'), '// untracked\n')
    expect(keyPathsDirty(repo.root)).toHaveLength(1)
    expect(() => keyFromWorktree(repo.root)).toThrow(/Refusing/)
  })

  it('is NOT fooled by dirt OUTSIDE the key paths', () => {
    // The converse control: refusing on any dirt at all would make the tool
    // unusable in a normal working tree and it would be switched off
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'README.md'), '# not a key path\n')
    expect(keyPathsDirty(repo.root)).toEqual([])
    expect(() => keyFromWorktree(repo.root)).not.toThrow()
  })

  it('REFUSES a key computed over zero inputs', () => {
    // e3b0c442… is SHA-256 of the empty string and looks exactly like an answer
    const empty = mkdtempSync(join(tmpdir(), '27m0-empty-'))
    git(empty, ['init', '-q'])
    git(empty, ['config', 'user.email', '27m0@example.invalid'])
    git(empty, ['config', 'user.name', '27m0'])
    writeFileSync(join(empty, 'README.md'), 'no key paths here\n')
    git(empty, ['add', '.'])
    git(empty, ['commit', '-qm', 'no key paths'])
    expect(() => keyFromWorktree(empty)).toThrow(/0 inputs|not a measurement/)
    expect(() =>
      keyFromCommit(empty, git(empty, ['rev-parse', 'HEAD']))
    ).toThrow(/0 inputs|not a measurement/)
  })
})
