// The digest gate swaps src/ to a ref and back. A file that exists only on the
// ref must not survive the restore, staged or on disk, or the next commit on
// the branch ships another PR's file

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { restoreFromHead, swapToRef, treeStatus } from './digest-parity.mjs'

const git = (cwd: string, ...argv: string[]) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8' })

let repo = ''

// A branch one commit behind main, where main added src/mainOnly.ts
function behindMain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'digest-restore-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'test')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'shared.ts'), 'export const a = 1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'branch', 'feature')
  writeFileSync(join(dir, 'src', 'mainOnly.ts'), 'export const b = 2\n')
  writeFileSync(join(dir, 'src', 'shared.ts'), 'export const a = 3\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'main moves on')
  git(dir, 'checkout', '-q', 'feature')
  return dir
}

describe('digest-parity src/ swap', () => {
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = ''
  })

  it('leaves the checkout exactly as it found it when the ref added a file', () => {
    repo = behindMain()
    const before = treeStatus(repo)
    const refOnly = swapToRef('main', repo)
    // The swap really did bring the ref's file in, or the test proves nothing
    expect(existsSync(join(repo, 'src', 'mainOnly.ts'))).toBe(true)
    expect(refOnly).toEqual(['src/mainOnly.ts'])
    restoreFromHead(refOnly, repo)
    expect(existsSync(join(repo, 'src', 'mainOnly.ts'))).toBe(false)
    expect(treeStatus(repo)).toBe(before)
  })

  it('keeps an untracked file the user already had', () => {
    repo = behindMain()
    writeFileSync(join(repo, 'notes.txt'), 'mine\n')
    const before = treeStatus(repo)
    restoreFromHead(swapToRef('main', repo), repo)
    expect(existsSync(join(repo, 'notes.txt'))).toBe(true)
    expect(treeStatus(repo)).toBe(before)
  })
})
