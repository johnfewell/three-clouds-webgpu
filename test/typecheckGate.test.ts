import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
}

describe('typecheck gate', () => {
  it('builds library types before checking the library and parity harness', () => {
    const pkg = readJson('package.json') as {
      scripts: { typecheck: string }
    }
    const commands = pkg.scripts.typecheck
      .split('&&')
      .map(value => value.trim())

    expect(commands).toEqual([
      'pnpm build',
      'tsc --noEmit -p tsconfig.json',
      'tsc --noEmit -p examples/parity/tsconfig.json',
      'tsc --noEmit -p core/emit/tsconfig.json',
      'pnpm typecheck:examples',
      // Three tsc invocations, one per example app. An earlier version pinned a
      // lint here and called it a typecheck, so a duplicate storybook export
      // shipped with every gate green
      'pnpm typecheck:example-apps'
    ])
  })

  it('types the parity source with its browser, test, and Node environments', () => {
    const config = readJson('examples/parity/tsconfig.json') as {
      compilerOptions: { allowJs?: boolean; types?: string[] }
      include?: string[]
    }

    expect(config.include).toContain('src')
    expect(config.compilerOptions.allowJs).toBe(true)
    expect(config.compilerOptions.types).toEqual(
      expect.arrayContaining(['vite/client', 'vitest/globals', 'node'])
    )
  })

  // E2e/ (and probes/) must be in the parity include, or their type
  // errors go unseen. Pinned as a set, so any change to the include
  // fails here and becomes a decision rather than a drift
  it('typechecks the parity e2e specs, not just src', () => {
    const tsconfig = readJson('examples/parity/tsconfig.json') as {
      include: string[]
    }
    expect(new Set(tsconfig.include)).toEqual(new Set(['src', 'e2e', 'probes']))
  })
})
