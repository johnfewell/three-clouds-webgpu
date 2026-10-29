import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../test/helpers/log'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts/dts-extensions.mjs')

interface Run {
  stdout: string
  stderr: string
  status: number
  // The script reports refusals on stderr and counts on stdout, so assertions
  // need both or they pass on an empty string
  output: string
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8'
    })
    return { stdout, stderr: '', status: 0, output: stdout }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    const stdout = err.stdout ?? ''
    const stderr = err.stderr ?? ''
    return {
      stdout,
      stderr,
      status: err.status ?? 1,
      output: `${stdout}\n${stderr}`
    }
  }
}

// A throwaway declaration tree: one sibling file, one directory index and one
// dangling specifier that must be reported rather than guessed at
function fixture(): {
  root: string
  count: number
  read: (rel: string) => string
} {
  const root = mkdtempSync(join(tmpdir(), 'dts-ext-'))
  mkdirSync(join(root, 'nested'), { recursive: true })
  writeFileSync(join(root, 'index.d.ts'), "export * from './sibling'\n")
  writeFileSync(join(root, 'sibling.d.ts'), 'export declare const a: 1\n')
  writeFileSync(join(root, 'nested/index.d.ts'), 'export declare const b: 1\n')
  writeFileSync(join(root, 'deep.d.ts'), "export * from './nested'\n")
  writeFileSync(join(root, 'external.d.ts'), "export * from 'three/tsl'\n")
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
  // counted, not hardcoded: a file added to the fixture must not silently
  // change what the scan reports
  const count = ['index.d.ts', 'sibling.d.ts', 'nested/index.d.ts', 'deep.d.ts']
    .concat('external.d.ts')
    .filter(rel => read(rel).length > 0).length
  return { root, count, read }
}

describe('dts-extensions', () => {
  it('rewrites a sibling, a directory and nothing else', () => {
    setCurrentSpec('dts-extensions rewrites')
    const { root, count, read } = fixture()
    try {
      const { output, status } = run([root])
      const table = [
        { file: 'index.d.ts', after: read('index.d.ts').trim() },
        { file: 'deep.d.ts', after: read('deep.d.ts').trim() },
        { file: 'external.d.ts', after: read('external.d.ts').trim() }
      ]
      log('rewritten', table)
      expect(status).toBe(0)
      expect(read('index.d.ts')).toContain("'./sibling.js'")
      expect(read('deep.d.ts')).toContain("'./nested/index.js'")
      // bare specifiers are never touched: they are another package's problem
      expect(read('external.d.ts')).toContain("'three/tsl'")
      expect(output).toContain(`declarations scanned : ${count}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is idempotent', () => {
    setCurrentSpec('dts-extensions idempotent')
    const { root, read } = fixture()
    try {
      run([root])
      const first = read('index.d.ts')
      const { output, status } = run([root])
      log('idempotent', [
        { changed: first !== read('index.d.ts'), stdout: output.trim() }
      ])
      expect(status).toBe(0)
      expect(read('index.d.ts')).toBe(first)
      expect(output).toContain('specifiers rewrote     : 0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('--check reports a dirty tree instead of rewriting it', () => {
    setCurrentSpec('dts-extensions check mode')
    const { root, read } = fixture()
    try {
      const { status } = run(['--check', root])
      log('check', [{ status, unchanged: read('index.d.ts') }])
      expect(status).toBe(1)
      expect(read('index.d.ts')).toContain("'./sibling'")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a specifier that names no declaration file', () => {
    setCurrentSpec('dts-extensions dangling specifier')
    const { root } = fixture()
    try {
      writeFileSync(join(root, 'dangling.d.ts'), "export * from './missing'\n")
      const { output, status } = run([root])
      log('dangling', [{ status, refused: output.includes('REFUSING') }])
      expect(status).toBe(1)
      expect(output).toContain('REFUSING')
      expect(output).toContain('./missing')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a missing root rather than reporting zero declarations', () => {
    setCurrentSpec('dts-extensions missing root')
    const missing = join(tmpdir(), 'dts-ext-does-not-exist')
    rmSync(missing, { recursive: true, force: true })
    const { output, status } = run([missing])
    log('missing root', [{ status, refused: output.includes('REFUSING') }])
    expect(status).toBe(1)
    expect(output).toContain('REFUSING')
  })

  it('refuses an empty root rather than reporting a clean run', () => {
    setCurrentSpec('dts-extensions empty root')
    const root = mkdtempSync(join(tmpdir(), 'dts-ext-empty-'))
    try {
      const { output, status } = run([root])
      log('empty root', [{ status, refused: output.includes('REFUSING') }])
      expect(status).toBe(1)
      expect(output).toContain('0 declaration files')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the build script runs it, so the shipped types cannot regress', () => {
    setCurrentSpec('dts-extensions wired into build')
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    log('build script', [{ build: pkg.scripts.build }])
    expect(pkg.scripts.build).toContain('pnpm build:code')
    expect(pkg.scripts['build:code']).toContain('scripts/dts-extensions.mjs')
  })

  it('lives in the directory it rewrites by default', () => {
    setCurrentSpec('dts-extensions default root')
    const { output, status } = run(['--check'])
    log('default root', [
      { status, scanned: /scanned : \d+/.exec(output)?.[0] ?? 'none' }
    ])
    // A missing types/ is a build-order problem, not a pass
    expect([0, 1]).toContain(status)
    expect(dirname(SCRIPT)).toBe(join(ROOT, 'scripts'))
  })
})
