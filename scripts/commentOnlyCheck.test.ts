// the comment cleanup must not change code. The guard is only worth
// something if a real code change turns it red, including changes that hide
// inside strings, templates and JSX, which a naive comment regex would miss

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { log } from '../test/helpers/log'
import {
  checkCommentOnly,
  firstCodeDifference,
  tokenStream
} from './comment-only-check.mjs'

const BEFORE = `// Returns the scaled value.
export function scale(x: number): number {
  const url = 'https://example.com/a // not a comment'
  /** the factor — a JSDoc block */
  return x * 2 // doubles it
}
const t = \`a \${1 + 2} // b\`
`

describe('firstCodeDifference', () => {
  it('sees the code: a real file yields its tokens, not an empty stream', () => {
    // An empty stream compares equal to anything, which is how a first
    // draft of this guard passed every code change
    const tokens = tokenStream(BEFORE, 'a.ts')
    log('comment-only-tokens', { count: tokens.length })
    expect(tokens).toContain(`${ts.SyntaxKind.AsteriskToken}:*`)
    expect(tokens.length).toBeGreaterThan(20)
  })

  it('is null when only comments and whitespace change', () => {
    const after = `// Returns the scaled value
export function scale(x: number): number {
  const url = 'https://example.com/a // not a comment'

  /**
   * the factor, a JSDoc block
   */
  // doubles it
  return x * 2
}
const t = \`a \${1 + 2} // b\`
`
    expect(firstCodeDifference(BEFORE, after, 'a.ts')).toBeNull()
  })

  it.each([
    ['an operator', 'return x * 2', 'return x * 3'],
    ['text inside a string', 'not a comment', 'not a  comment'],
    ['text inside a template', '// b`', '//b`'],
    [
      'a removed statement',
      "  const url = 'https://example.com/a // not a comment'\n",
      ''
    ]
  ])('reports %s', (_name, from, to) => {
    const after = BEFORE.replace(from, to)
    expect(after, 'the mutation must apply').not.toBe(BEFORE)
    const diff = firstCodeDifference(BEFORE, after, 'a.ts')
    log('comment-only-red', { mutation: _name, diff: JSON.stringify(diff) })
    expect(diff).not.toBeNull()
  })

  it('reports a JSX text change in .tsx', () => {
    const a = 'export const A = () => <p>{/* note */}hello</p>\n'
    expect(
      firstCodeDifference(a, a.replace('/* note */', ''), 'a.tsx')
    ).toBeNull()
    expect(
      firstCodeDifference(a, a.replace('hello', 'hullo'), 'a.tsx')
    ).not.toBeNull()
  })
})

describe('checkCommentOnly against a git base', () => {
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'z55n-'))
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'z55n@example.invalid')
    git('config', 'user.name', 'z55n')
    writeFileSync(join(root, 'a.ts'), BEFORE)
    writeFileSync(join(root, 'b.mjs'), 'export const b = 1 // one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    return root
  }

  it('passes a comment-only edit and fails a code edit', () => {
    const root = repo()
    writeFileSync(join(root, 'b.mjs'), '// one\nexport const b = 1\n')
    expect(checkCommentOnly(root, 'HEAD')).toEqual({ checked: 1, failures: [] })

    writeFileSync(join(root, 'a.ts'), BEFORE.replace('x * 2', 'x * 3'))
    const result = checkCommentOnly(root, 'HEAD')
    log('comment-only-git', {
      checked: result.checked,
      failed: result.failures.map(f => f.path).join(',')
    })
    expect(result.checked).toBe(2)
    expect(result.failures.map(f => f.path)).toEqual(['a.ts'])
  })

  it('fails a new code file unless it is allowed', () => {
    const root = repo()
    writeFileSync(join(root, 'c.ts'), '// only a comment\n')
    execFileSync('git', ['add', 'c.ts'], { cwd: root })
    expect(checkCommentOnly(root, 'HEAD').failures).toHaveLength(1)
    expect(checkCommentOnly(root, 'HEAD', ['c.ts'])).toEqual({
      checked: 0,
      failures: []
    })
  })
})
