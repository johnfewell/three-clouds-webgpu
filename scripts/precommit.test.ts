import { accessSync, constants, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { lintableFiles, partlyStaged } from './precommit.mjs'

describe('pre-commit gate', () => {
  it('sends script and type files to eslint and every staged path to prettier', () => {
    const staged = [
      'src/a.ts',
      'scripts/b.mjs',
      'x.d.mts',
      'docs/c.md',
      'd.json',
      'e.tsx',
      'f.cjs'
    ]
    const { lint, format } = lintableFiles(staged)
    expect(lint).toEqual([
      'src/a.ts',
      'scripts/b.mjs',
      'x.d.mts',
      'e.tsx',
      'f.cjs'
    ])
    expect(format).toEqual(staged)
  })

  it('names the staged paths that also carry unstaged edits', () => {
    expect(partlyStaged(['a.ts', 'b.ts', 'c.ts'], ['b.ts', 'z.ts'])).toEqual([
      'b.ts'
    ])
    expect(partlyStaged(['a.ts'], [])).toEqual([])
  })

  it('is an executable hook that runs the gate', () => {
    const hook = new URL('hooks/pre-commit', import.meta.url)
    expect(() => accessSync(hook, constants.X_OK)).not.toThrow()
    expect(readFileSync(hook, 'utf8')).toContain('scripts/precommit.mjs')
  })

  it('is installed by pnpm install, through the prepare script', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> }
    expect(pkg.scripts.prepare).toBe('node scripts/install-hooks.mjs')
  })
})
