// merge-check reported PASS on a PR whose head left
// scripts/verify-results.mjs with an unclosed /** block, because pnpm typecheck
// reads no plain .mjs outside the TS projects
// Red-proved by mutation: an unparseable changed script is a FAILURE, and an
// EMPTY changed set says so out loud

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  changedScripts,
  isPlainScript,
  parseCheck,
  reportParse
} from './merge-check.mjs'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const write = (root: string, name: string, body: string) => {
  mkdirSync(join(root, name, '..'), { recursive: true })
  writeFileSync(join(root, name), body)
}

/** A throwaway directory holding scripts written by the test */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'merge-check-'))
  dirs.push(root)
  for (const [name, body] of Object.entries(files)) write(root, name, body)
  return root
}

/** A real repo, so `git diff` names files the way it does in the gate */
function repo(commits: { name: string; body: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'merge-check-repo-'))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'merge check test')
  for (const { name, body } of commits) {
    write(root, name, body)
    git('add', '-A')
    git('commit', '-qm', `commit ${name}`)
  }
  return root
}

const GOOD = "import { readFileSync } from 'node:fs'\nexport const a = 1\n"
// The regression: a JSDoc block opened and never terminated
const UNCLOSED = 'export const a = 1\n/**\n * never closed\n'

describe('merge-check parse gate', () => {
  it('names every plain script extension and nothing else', () => {
    expect(isPlainScript('scripts/verify-results.mjs')).toBe(true)
    expect(isPlainScript('scripts/legacy.cjs')).toBe(true)
    expect(isPlainScript('scripts/legacy.js')).toBe(true)
    // tsc already covers these, and a .json is not a program
    expect(isPlainScript('src/CloudsContext.ts')).toBe(false)
    expect(isPlainScript('package.json')).toBe(false)
  })

  it('FAILs on a changed script with an unclosed comment block', () => {
    const root = fixture({ 'scripts/verify-results.mjs': UNCLOSED })
    const { checked, failures } = parseCheck(root, [
      'scripts/verify-results.mjs'
    ])
    expect(checked).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.file).toBe('scripts/verify-results.mjs')
    expect(failures[0]?.output).toMatch(/SyntaxError/)
  })

  it('reports PASS on a changed script that parses', () => {
    const root = fixture({ 'scripts/fine.mjs': GOOD })
    expect(parseCheck(root, ['scripts/fine.mjs']).failures).toEqual([])
    expect(reportParse(root, ['scripts/fine.mjs'])).toBe(0)
  })

  it('fails the gate on the unclosed block, which is the reported defect', () => {
    const root = fixture({ 'scripts/verify-results.mjs': UNCLOSED })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reportParse(root, ['scripts/verify-results.mjs'])).toBe(1)
    // The offending PATH and node's own diagnostic, so the reader does not
    // have to re-run node to learn which file broke
    expect(error.mock.calls.flat().join('\n')).toContain(
      'scripts/verify-results.mjs'
    )
    expect(error.mock.calls.flat().join('\n')).toMatch(/SyntaxError/)
  })

  it('says so out loud when the changed set is empty', () => {
    const root = fixture({ 'src/index.ts': 'export const a = 1\n' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // A PR that touched no script is a legitimate PASS, and it is also what a
    // derivation that silently produced nothing looks like. Silence would be
    // indistinguishable from "everything parsed"
    expect(reportParse(root, [])).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toMatch(/no changed/i)
  })

  it('names the changed scripts git reports, and skips the rest', () => {
    const root = repo([
      { name: 'keep.mjs', body: GOOD },
      { name: 'keep.ts', body: 'export const a = 1\n' }
    ])
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD~1'], {
      encoding: 'utf8'
    }).trim()
    write(root, 'scripts/new.mjs', GOOD)
    write(root, 'src/new.ts', 'export const b = 2\n')
    execFileSync('git', ['-C', root, 'add', '-A'])
    execFileSync('git', ['-C', root, 'commit', '-qm', 'scripts'])
    expect(changedScripts(root, base, 'HEAD')).toEqual(['scripts/new.mjs'])
  })

  it('excludes a DELETED script, which cannot be parsed', () => {
    const root = repo([
      { name: 'scripts/gone.mjs', body: GOOD },
      { name: 'scripts/kept.mjs', body: GOOD }
    ])
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
    rmSync(join(root, 'scripts/gone.mjs'))
    execFileSync('git', ['-C', root, 'rm', '-q', 'scripts/gone.mjs'])
    execFileSync('git', ['-C', root, 'commit', '-qm', 'drop one'])
    expect(changedScripts(root, base, 'HEAD')).toEqual([])
  })

  it('skips a listed path that is not on disk rather than reporting it', () => {
    const root = fixture({})
    // checked counts the LIST, so a caller can still see what it was asked to
    // cover, while a stale entry neither passes nor fails as a parse error
    expect(parseCheck(root, ['scripts/absent.mjs'])).toEqual({
      checked: 1,
      failures: []
    })
  })
})
