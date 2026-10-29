import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import vitestConfig from '../vitest.config'
import { log, setCurrentSpec } from './helpers/log'

// `pnpm build` runs vite, and vite empties build/ before it writes. A reader of
// THIS tree's build/ can catch the directory empty: ENOENT on build/shared.js,
// or a scan over zero files that passes vacuously. Both have shipped

// The files that reach the real build and types directories therefore run in
// the serial group, which is exclusive. This file is the register

const ROOT = join(import.meta.dirname, '..')
const SCAN_ROOTS = ['src', 'test', 'scripts', 'examples']
const TEST_FILE = /\.(?:test\.tsx?|test\.mjs)$/

/** Repo-relative, git-tracked test files. Untracked files are not what CI runs */
function trackedTestFiles(): string[] {
  const out = execFileSync('git', ['ls-files', ...SCAN_ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return out.split('\n').filter(line => TEST_FILE.test(line))
}

/**
 * Identifiers this file derived from its own location, which is what
 * distinguishes the real tree from a tmpdir() fixture. Without this a
 * `join(root, 'build')` in a temp fixture reads as a real build access and the
 * fixtures would be dragged into the serial group for nothing.
 */
function repoRootIds(source: string): string[] {
  return [
    ...new Set(
      [
        ...source.matchAll(
          /const\s+(\w+)\s*=\s*join\(\s*import\.meta\.dirname/g
        )
      ].map(m => m[1]!)
    )
  ]
}

/**
 * The three ways a test file reaches this tree's build output. Each is one
 * regex over the repo-root identifiers, so a fixture under tmpdir() cannot
 * match. A fourth idiom will not be seen here, which is why the log table
 * names the idiom rather than just the file.
 */
function accessIdioms(source: string, ids: string[]): string[] {
  if (ids.length === 0) return []
  const alt = ids.join('|')
  const idioms: Array<[string, RegExp]> = [
    [
      'path under the repo build or types dir',
      new RegExp(String.raw`join\(\s*(?:${alt})\s*,\s*'(?:build|types)'`)
    ],
    [
      'provenance of the repo root',
      new RegExp(
        String.raw`captureProvenance\(\{[^}]*projectRoot:\s*(?:${alt})\b`
      )
    ],
    [
      'a build spawned in the repo root',
      new RegExp(String.raw`\(\s*(?:${alt})\s*,\s*'pnpm'\s*,\s*\[\s*'build'`)
    ]
  ]
  return idioms.filter(([, re]) => re.test(source)).map(([name]) => name)
}

function realBuildAccess(): Array<{ file: string; idioms: string[] }> {
  const found: Array<{ file: string; idioms: string[] }> = []
  for (const file of trackedTestFiles()) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const idioms = accessIdioms(source, repoRootIds(source))
    if (idioms.length > 0) found.push({ file, idioms })
  }
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

interface SerialProject {
  test?: { name?: string; include?: unknown }
}

function serialInclude(): string[] {
  // The declared project union is wider than this file cares about (a project
  // may be a string, a promise or a function), so narrow by shape and log it
  const projects = (vitestConfig.test?.projects ?? []) as unknown[]
  const serial = projects.find(
    p =>
      typeof p === 'object' &&
      p !== null &&
      (p as SerialProject).test?.name === 'serial'
  )
  expect(
    serial,
    'the config has a serial project to serialize against'
  ).toBeDefined()
  const include = (serial as SerialProject).test?.include
  expect(
    include == null,
    'the serial project names the files it runs'
  ).not.toBe(true)
  const entries = Array.isArray(include) ? include : [include]
  expect(
    entries.every(e => typeof e === 'string'),
    'the serial include list is plain paths'
  ).toBe(true)
  return entries as string[]
}

describe('the serial vitest group and the real build directory', () => {
  it('serializes every test file that reads or rebuilds this tree', () => {
    setCurrentSpec('real-build-serial')
    const accessors = realBuildAccess()
    const serial = serialInclude()

    // An empty derivation and a clean bill of health look identical, so refuse
    // before reading anything into the comparison below
    log('real-build-access', [
      ...accessors.map(a => ({
        file: a.file,
        idioms: a.idioms.join(', '),
        inSerialGroup: String(serial.includes(a.file))
      })),
      { file: '(scanned test files)', idioms: '', inSerialGroup: '' }
    ])
    log('scanned-test-files', {
      tracked: trackedTestFiles().length,
      touchingRealBuild: accessors.length,
      serialGroupSize: serial.length
    })
    expect(
      accessors.length,
      'no test file reads or rebuilds this tree, so the scan found nothing to check'
    ).toBeGreaterThan(0)

    const unserialized = accessors
      .filter(a => !serial.includes(a.file))
      .map(a => a.file)
    expect(
      unserialized,
      "these touch this tree's build/ or types/ and run in the parallel " +
        'group, so one can empty the directory under another'
    ).toEqual([])
  })

  it('names serial-group files that exist, so the list cannot rot silently', () => {
    setCurrentSpec('serial-group-rots')
    const serial = serialInclude()
    const tracked = new Set(trackedTestFiles())
    const rows = serial.map(file => ({
      file,
      tracked: String(tracked.has(file)),
      onDisk: String(existsSync(join(ROOT, file)))
    }))
    log('serial-group-entries', rows)
    // A serial entry that matches no file collects nothing, and vitest reports
    // a green run over a smaller suite rather than an error
    expect(rows.filter(r => r.tracked !== 'true').map(r => r.file)).toEqual([])
  })
})
