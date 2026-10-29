// On 2026-09-03 main carried a lockfile
// entry that no manifest declared, `pnpm install --frozen-lockfile` failed at
// the first step of three CI jobs, and nobody saw it for seven hours because the
// only thing checking it lived in CI and CI could not start. This runs in
// `pnpm test`, so it runs on every branch and every machine regardless
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkLockfileManifests,
  manifestSpecifiers,
  parseImporters,
  parseOverrides,
  workspaceOverrides
} from '../scripts/port-gates/lockfile-manifests.mjs'
import { log } from './helpers/log'

const ROOT = join(import.meta.dirname, '..')
const temps: string[] = []
afterEach(() => {
  while (temps.length > 0)
    rmSync(temps.pop()!, { recursive: true, force: true })
})

/** A miniature workspace: a root manifest, one example, and a lockfile */
function fixture(opts: {
  exampleDeps: Record<string, string>
  lockedDeps: Record<string, string>
  overrides?: Record<string, string>
  workspaceOverrides?: Record<string, string>
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-gate-'))
  temps.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root' }))
  mkdirSync(join(dir, 'examples', 'demo'), { recursive: true })
  writeFileSync(
    join(dir, 'examples', 'demo', 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: opts.exampleDeps })
  )
  const locked = Object.entries(opts.lockedDeps)
    .map(
      ([n, s]) => `      ${n}:\n        specifier: ${s}\n        version: ${s}`
    )
    .join('\n')
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\n` +
      (opts.overrides == null
        ? ''
        : 'overrides:\n' +
          Object.entries(opts.overrides)
            .map(([n, s]) => `  '${n}': ${s}\n`)
            .join('') +
          '\n') +
      `importers:\n\n  .:\n\n  examples/demo:\n    dependencies:\n${locked}\n\npackages:\n`
  )
  if (opts.workspaceOverrides != null)
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - '.'\n  - 'examples/*'\noverrides:\n" +
        Object.entries(opts.workspaceOverrides)
          .map(([n, s]) => `  '${n}': ${s}\n`)
          .join('')
    )
  return dir
}

describe('the lockfile and every workspace manifest agree', () => {
  it('this repository passes', () => {
    const { ok, failures } = checkLockfileManifests(ROOT)
    console.table(failures.map((f: string) => ({ failure: f.slice(0, 90) })))
    expect(failures).toEqual([])
    expect(ok).toBe(true)
  })

  it('REJECTS the exact drift that broke main: locked but not declared', () => {
    const dir = fixture({
      exampleDeps: {},
      lockedDeps: { '3d-tiles-renderer': '0.4.28' }
    })
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('does not declare it')
  })

  it('rejects the reverse: declared but not locked', () => {
    const dir = fixture({ exampleDeps: { left: '^1.0.0' }, lockedDeps: {} })
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('the lockfile has no such entry')
  })

  it('rejects a specifier that differs between the two', () => {
    const dir = fixture({
      exampleDeps: { same: '^1.0.0' },
      lockedDeps: { same: '^2.0.0' }
    })
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('the lockfile records')
  })

  it('accepts an override in place of the declared specifier', () => {
    // pnpm records a root-relative file: override relative to the importer
    const dir = fixture({
      exampleDeps: { '@scope/a': '1.0.0', b: '2.0.0' },
      lockedDeps: {
        '@scope/a': 'https://example.test/a.tgz',
        b: 'file:../../vendor/b.tgz'
      },
      overrides: {
        '@scope/a': 'https://example.test/a.tgz',
        b: 'file:./vendor/b.tgz'
      },
      workspaceOverrides: {
        '@scope/a': 'https://example.test/a.tgz',
        b: 'file:./vendor/b.tgz'
      }
    })
    const { failures } = checkLockfileManifests(dir)
    expect(failures).toEqual([])
  })

  it('rejects a locked specifier that matches neither manifest nor override', () => {
    const dir = fixture({
      exampleDeps: { b: '2.0.0' },
      lockedDeps: { b: 'file:../vendor/b.tgz' },
      overrides: { b: 'file:./vendor/b.tgz' },
      workspaceOverrides: { b: 'file:./vendor/b.tgz' }
    })
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    // the importer's own message, since override drift also says "records"
    expect(failures).toEqual([
      'examples/demo declares b@2.0.0 but the lockfile records file:../vendor/b.tgz'
    ])
  })

  it('reads the overrides block of a recipe workspace and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'overrides-parse-'))
    temps.push(root)
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - '.'\n" +
        'overrides:\n' +
        "  '@takram/three-atmosphere': https://example.test/a.tgz\n" +
        "  '@takram/three-geospatial': 'file:./vendor/g+fork.1.tgz'\n" +
        '  three: 0.185.1\n' +
        'allowBuilds:\n  esbuild: true\n'
    )
    const actual = workspaceOverrides(root)
    log('consumer-overrides', [
      { field: 'entries', expected: 3, actual: Object.keys(actual).length }
    ])
    expect(actual).toEqual({
      '@takram/three-atmosphere': 'https://example.test/a.tgz',
      '@takram/three-geospatial': 'file:./vendor/g+fork.1.tgz',
      three: '0.185.1'
    })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
    expect(workspaceOverrides(root)).toEqual({})
  })

  it('rejects an override pnpm-workspace.yaml changed and the lockfile did not', () => {
    // a frozen install fails on exactly this, so the gate has to see it first
    const dir = fixture({
      exampleDeps: { b: '2.0.0' },
      lockedDeps: { b: 'https://example.test/b-1.tgz' },
      overrides: { b: 'https://example.test/b-1.tgz' },
      workspaceOverrides: { b: 'https://example.test/b-2.tgz' }
    })
    const { ok, failures } = checkLockfileManifests(dir)
    log('override-drift', [
      { field: 'ok', expected: false, actual: ok },
      { field: 'failures', expected: '>= 1', actual: failures.length }
    ])
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('pnpm-workspace.yaml overrides b')
  })

  it('rejects an override only one of the two files declares', () => {
    const dir = fixture({
      exampleDeps: { same: '^1.0.0' },
      lockedDeps: { same: '^1.0.0' },
      workspaceOverrides: { c: '1.0.0' }
    })
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('pnpm-workspace.yaml overrides c')
  })

  it('reads a hand-edited overrides block with comments and blank lines', () => {
    const text =
      "packages:\n  - '.'\noverrides:\n" +
      '  # pinned: the fork build, by release URL\n' +
      "  '@scope/a': https://example.test/a.tgz\n" +
      '\n' +
      '# the vendored one\n' +
      '  b: file:./vendor/b.tgz\n' +
      '\nallowBuilds:\n  esbuild: true\n'
    const actual = Object.fromEntries(parseOverrides(text))
    log('override-comments', [
      { field: 'entries', expected: 2, actual: Object.keys(actual).length }
    ])
    expect(actual).toEqual({
      '@scope/a': 'https://example.test/a.tgz',
      b: 'file:./vendor/b.tgz'
    })
  })

  it('reads an overrides block written with CRLF line endings', () => {
    const text =
      "lockfileVersion: '9.0'\r\n\r\noverrides:\r\n" +
      "  '@scope/a': https://example.test/a.tgz\r\n" +
      '  b: file:./vendor/b.tgz\r\n\r\nimporters:\r\n'
    const actual = Object.fromEntries(parseOverrides(text))
    log('override-crlf', [
      { field: 'entries', expected: 2, actual: Object.keys(actual).length }
    ])
    expect(actual).toEqual({
      '@scope/a': 'https://example.test/a.tgz',
      b: 'file:./vendor/b.tgz'
    })
  })

  it('accepts a workspace that agrees', () => {
    const dir = fixture({
      exampleDeps: { same: '^1.0.0' },
      lockedDeps: { same: '^1.0.0' }
    })
    expect(checkLockfileManifests(dir).ok).toBe(true)
  })

  // A workspace package outside examples/, listed literally in
  // pnpm-workspace.yaml, as core/ is. Before this the gate never read it
  it('rejects drift in a literal workspace entry outside examples/', () => {
    const dir = fixture({
      exampleDeps: { same: '^1.0.0' },
      lockedDeps: { same: '^1.0.0' }
    })
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - '.'\n  - 'examples/*'\n  - 'core'\n"
    )
    mkdirSync(join(dir, 'core'))
    writeFileSync(
      join(dir, 'core', 'package.json'),
      JSON.stringify({ name: 'core', dependencies: { unlocked: '^2.0.0' } })
    )
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('core/package.json has no importer')
  })

  // A parser that silently reads nothing would make this gate pass on every
  // possible drift: the vacuity failure this project has hit three times
  it('REFUSES rather than passing when the lockfile format stops parsing', () => {
    const dir = fixture({ exampleDeps: {}, lockedDeps: {} })
    writeFileSync(
      join(dir, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\npackages:\n"
    )
    const { ok, failures } = checkLockfileManifests(dir)
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('this gate is now blind')
  })

  it('keeps override drift when the importers stop parsing too', () => {
    const dir = fixture({
      exampleDeps: {},
      lockedDeps: {},
      workspaceOverrides: { b: 'https://example.test/b-2.tgz' }
    })
    writeFileSync(
      join(dir, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\noverrides:\n" +
        "  'b': https://example.test/b-1.tgz\n\npackages:\n"
    )
    const { ok, failures } = checkLockfileManifests(dir)
    log('blind-and-drift', [
      { field: 'failures', expected: 2, actual: failures.length }
    ])
    expect(ok).toBe(false)
    expect(failures.join('\n')).toContain('this gate is now blind')
    expect(failures.join('\n')).toContain('pnpm-workspace.yaml overrides b')
  })

  it('parses the real lockfile into real importers', () => {
    const importers = parseImporters(
      readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
    )
    expect(importers.size).toBeGreaterThan(1)
    expect([...importers.keys()]).toContain('.')
  })

  it('collects specifiers from all three dependency sections', () => {
    const specs = manifestSpecifiers({
      dependencies: { a: '1' },
      devDependencies: { b: '2' },
      optionalDependencies: { c: '3' }
    })
    expect([...specs.entries()]).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3']
    ])
  })
})
