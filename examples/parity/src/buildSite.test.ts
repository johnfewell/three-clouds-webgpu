import { execSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { sitePath } from './sitePath'

const DIST_DIR = join(import.meta.dirname, '..', 'dist')
const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..')
const NESTED_SITE = 'https://example.test/three-clouds-webgpu/'

function readBuiltJavaScript(): string {
  const assetsDir = join(DIST_DIR, 'assets')
  return readdirSync(assetsDir)
    .filter(f => f.endsWith('.js'))
    .map(f => readFileSync(join(assetsDir, f), 'utf8'))
    .join('')
}

// Shells out to `pnpm --filter parity build`, which cannot run in a worktree
// borrowing another checkout's node_modules. It skips HERE, loudly and by name,
// not via a CLI exclusion, which would hide it (a skip is not a pass)
function usesBorrowedInstall(): boolean {
  const installDirs = [
    join(PROJECT_ROOT, 'node_modules'),
    join(PROJECT_ROOT, 'examples', 'parity', 'node_modules')
  ]
  return installDirs.some(
    path => existsSync(path) && lstatSync(path).isSymbolicLink()
  )
}

const USES_BORROWED_INSTALL = usesBorrowedInstall()
if (USES_BORROWED_INSTALL) {
  console.warn(
    '[buildSite] SKIPPED: borrowed node_modules detected. `pnpm --filter parity build` ' +
      'cannot run against a symlinked node_modules, so this suite is skipped — ' +
      'NOT passed. The full suite is therefore incomplete by exactly these ' +
      'tests; give the worktree a real install before relying on the result.'
  )
}

describe.skipIf(USES_BORROWED_INSTALL)('static site build', () => {
  beforeAll(() => {
    // describe.skipIf marks the TESTS skipped but still runs this hook, so the
    // build would shell out anyway and fail the suite (measured). The hook
    // needs its own guard
    if (USES_BORROWED_INSTALL) return
    execSync('pnpm --filter parity build', {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      timeout: 60_000
    })
  }, 90_000)

  it('produces dist/index.html', () => {
    expect(existsSync(join(DIST_DIR, 'index.html'))).toBe(true)
  })

  it('resolves emitted entry assets under a nested project path', () => {
    const html = readFileSync(join(DIST_DIR, 'index.html'), 'utf8')
    const entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1]

    expect(entry).toMatch(/^\.\/assets\//)
    expect(html).not.toMatch(/(?:src|href)="\/assets\//)
    expect(new URL(entry!, NESTED_SITE).pathname).toMatch(
      /^\/three-clouds-webgpu\/assets\//
    )
  })

  it('resolves emitted public-file references under a nested project path', () => {
    const jsContent = readBuiltJavaScript()
    const emittedPaths = [
      'api/grid-data.json',
      'api/capture',
      'assets/local_weather.png',
      'assets/turbulence.png',
      'assets/shape.bin',
      'assets/shape_detail.bin',
      'results/'
    ]

    for (const path of emittedPaths) {
      expect(jsContent, `${path} was not emitted`).toContain(path)
      const rootRelativeForms = [`"/${path}`, `'/${path}`, `\`/${path}`]
      for (const rootRelative of rootRelativeForms) {
        expect(jsContent, `${path} was emitted root-relative`).not.toContain(
          rootRelative
        )
      }
      expect(new URL(sitePath(path, './'), NESTED_SITE).pathname).toBe(
        `/three-clouds-webgpu/${path}`
      )
    }
  })

  it('produces dist/assets/ with a JS bundle', () => {
    const assetsDir = join(DIST_DIR, 'assets')
    expect(existsSync(assetsDir)).toBe(true)
    const files = readdirSync(assetsDir)
    expect(files.some(f => f.endsWith('.js'))).toBe(true)
  })

  it('copies results into dist/results/', () => {
    const resultsDir = join(DIST_DIR, 'results')
    expect(existsSync(resultsDir)).toBe(true)
    const phase0 = join(resultsDir, '0')
    expect(existsSync(phase0)).toBe(true)
    const cases = readdirSync(phase0).filter(e =>
      statSync(join(phase0, e)).isDirectory()
    )
    expect(cases.length).toBeGreaterThan(0)
  })

  it('generates dist/api/grid-data.json with metrics', () => {
    const gridDataPath = join(DIST_DIR, 'api', 'grid-data.json')
    expect(existsSync(gridDataPath)).toBe(true)
    const data = JSON.parse(readFileSync(gridDataPath, 'utf8')) as {
      metrics: unknown[]
      currentPhase: number
    }
    expect(data.currentPhase).toBeTypeOf('number')
    expect(Array.isArray(data.metrics)).toBe(true)
  })

  it('generates dist/api/gates.json with summary', () => {
    const gatesPath = join(DIST_DIR, 'api', 'gates.json')
    expect(existsSync(gatesPath)).toBe(true)
    const data = JSON.parse(readFileSync(gatesPath, 'utf8')) as {
      summary: string
      gates: { name: string; summary: string; ok: boolean }[]
    }
    expect(data.summary).toBeTypeOf('string')
    expect(data.summary.length).toBeGreaterThan(0)
    expect(data.gates.length).toBe(3)
  })

  it('injects gate numbers into the JS bundle', () => {
    const jsContent = readBuiltJavaScript()
    expect(jsContent).toContain('citations')
    expect(jsContent).toContain('Histogram')
  })
})
