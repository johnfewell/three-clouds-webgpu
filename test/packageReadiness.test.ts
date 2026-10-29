import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from './helpers/cpuTwin'
import { log, setCurrentSpec } from './helpers/log'

const ROOT = join(import.meta.dirname, '..')

interface Pkg {
  name: string
  version: string
  files: string[]
  sideEffects: boolean
  exports: Record<string, unknown>
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  scripts: Record<string, string>
  author?: string
  license?: string
  homepage?: string
  bugs?: Record<string, string>
  repository?: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Pkg

function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTs(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(relative(ROOT, full))
    }
  }
  return out
}

const srcFiles = collectTs(join(ROOT, 'src')).filter(f => !f.includes('.test.'))

// node: builtins are not packages, and a scoped name's first two segments are
function packageNameOf(specifier: string): string {
  if (specifier.startsWith('node:')) {
    return specifier
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

// A prose `from 'x'` inside a comment is not an import, and without this the
// scan reports src/r3f/Clouds.tsx as depending on a package called
// 'explicitly false' -- a false positive nobody would think to remove
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

function bareSpecifiersIn(rel: string): string[] {
  const source = codeLines(readFileSync(join(ROOT, rel), 'utf8'))
  const out = new Set<string>()
  for (const m of source.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1]!
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      out.add(packageNameOf(spec))
    }
  }
  return [...out]
}

const declared = new Set([
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies)
])

describe('package readiness', () => {
  it('carries the fields npm shows on the package page', () => {
    setCurrentSpec('package readiness metadata')
    const table = [
      { field: 'name', value: pkg.name },
      { field: 'version', value: pkg.version },
      { field: 'author', value: pkg.author ?? '' },
      { field: 'license', value: pkg.license ?? '' },
      { field: 'homepage', value: pkg.homepage ?? '' },
      { field: 'bugs.url', value: pkg.bugs?.url ?? '' },
      { field: 'repository.url', value: pkg.repository?.url ?? '' }
    ]
    log('metadata', table)
    expect(pkg.author).toBeTruthy()
    expect(pkg.license).toBe('MIT')
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\//)
    expect(pkg.bugs?.url).toMatch(/^https:\/\/github\.com\/.+\/issues$/)
    expect(pkg.repository?.url).toMatch(/^git\+https:\/\/github\.com\/.+\.git$/)
    // every URL names the public repository exactly, with nothing appended
    // to the name
    const urls = [pkg.homepage, pkg.bugs?.url, pkg.repository?.url].filter(
      (u): u is string => typeof u === 'string'
    )
    expect(urls).toHaveLength(3)
    for (const url of urls) {
      expect(url).toMatch(
        /^(?:git\+)?https:\/\/github\.com\/johnfewell\/three-clouds-webgpu(?:\.git|\/issues|#readme)$/
      )
    }
  })

  it('version is a release, not the 0.0.x placeholder', () => {
    setCurrentSpec('package readiness version')
    log('version', [{ version: pkg.version }])
    expect(pkg.version).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
    )
    expect(pkg.version.startsWith('0.0.')).toBe(false)
  })

  it('every bare import in src has a declared dependency or peer', () => {
    setCurrentSpec('package readiness dependency coverage')
    const used = new Map<string, string[]>()
    for (const file of srcFiles) {
      for (const name of bareSpecifiersIn(file)) {
        used.set(name, [...(used.get(name) ?? []), file])
      }
    }
    const rows = [...used.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, files]) => ({
        package: name,
        declared: declared.has(name),
        importedBy: files.length
      }))
    log('import coverage', rows)
    const undeclared = rows.filter(r => !r.declared).map(r => r.package)
    // a new import with no declared dependency ships a package that cannot
    // resolve, and no bundler or linter in the tree would say so
    expect(undeclared).toEqual([])
    // a scan that found nothing is a broken scan, not a clean bill
    expect(rows.length).toBeGreaterThan(0)
  })

  it('three peer floor admits every version a consumer is proven on', () => {
    setCurrentSpec('package readiness three floor')
    // test/threeStructCompat.test.ts packs this package into real consumer
    // projects on each three version it names, so it is the evidence for the
    // floor. Read it rather than repeat its numbers here
    const compat = readFileSync(
      join(ROOT, 'test/threeStructCompat.test.ts'),
      'utf8'
    )
    const proven = [...compat.matchAll(/createConsumer\('(\d+\.\d+\.\d+)'/g)]
      .map(m => m[1]!)
      .filter(v => v !== undefined)
    const range = pkg.peerDependencies.three ?? ''
    const floor = />=\s*(\d+)\.(\d+)\.(\d+)/.exec(range)
    const asNumber = (v: string): number => {
      const [a = 0, b = 0, c = 0] = v.split('.').map(Number)
      return a * 1e6 + b * 1e3 + c
    }
    const floorValue = floor
      ? asNumber(`${floor[1]!}.${floor[2]!}.${floor[3]!}`)
      : Number.POSITIVE_INFINITY
    log('three floor', [
      { range, floor: floor?.[0] ?? '', proven: proven.join(' ') }
    ])
    expect(proven.length).toBeGreaterThan(0)
    expect(floor).not.toBeNull()
    const excluded = proven.filter(v => asNumber(v) < floorValue)
    expect(excluded).toEqual([])
  })

  it('caps the three peer range one minor past the newest qualified version', () => {
    setCurrentSpec('package readiness three ceiling')
    const range = pkg.peerDependencies.three ?? ''
    const devPin = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>
      }
    ).devDependencies.three
    const asNumber = (v: string): number => {
      const [a = 0, b = 0, c = 0] = v.split('.').map(Number)
      return a * 1e6 + b * 1e3 + c
    }
    // A packed fork-build consumer in threeStructCompat is evidence for its
    // version, like the dev pin, so the newest of them sets the cap
    const compat = readFileSync(
      join(ROOT, 'test/threeStructCompat.test.ts'),
      'utf8'
    )
    const forkConsumers = [
      ...compat.matchAll(/createConsumer\('(\d+\.\d+\.\d+)', true\)/g)
    ].map(m => m[1]!)
    const newest = [devPin ?? '0.0.0', ...forkConsumers].reduce((a, b) =>
      asNumber(b) > asNumber(a) ? b : a
    )
    const [major = 0, minor = 0] = newest.split('.').map(Number)
    const nextMinor = `${major}.${minor + 1}.0`
    const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(range)?.[1]
    log('three range', [
      {
        range,
        devPin,
        forkConsumers: forkConsumers.join(' '),
        nextMinor,
        ceiling: ceiling ?? ''
      }
    ])
    // an open-ended floor claims support for releases nobody has measured, so
    // the ceiling is what makes the range honest
    expect(devPin).toBeTruthy()
    expect(forkConsumers.length, 'fork-build consumers').toBeGreaterThan(0)
    expect(ceiling).toBeDefined()
    expect(asNumber(ceiling ?? '')).toBeLessThanOrEqual(asNumber(nextMinor))
  })

  it('files ships the LICENSE, the assets the loaders name, and no tests', () => {
    setCurrentSpec('package readiness files')
    const negations = pkg.files.filter(f => f.startsWith('!'))
    log('files', [
      {
        includes: pkg.files.filter(f => !f.startsWith('!')).join(' '),
        excludes: negations.join(' ') || '(none)'
      }
    ])
    expect(pkg.files).toContain('LICENSE')
    // src/constants.ts points DEFAULT_*_URL at assets/…, so a consumer that
    // serves those defaults needs them in the tarball
    expect(pkg.files).toContain('assets')
    expect(negations).toEqual(
      expect.arrayContaining([
        '!src/**/*.test.ts',
        '!src/**/*.test.tsx',
        '!types/**/*.test.d.ts'
      ])
    )
    // LICENSE holds the upstream copyright, which a local licence file loses
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toContain(
      'Copyright (c) 2024 Shota Matsuda'
    )
  })

  it('every exports entry has both an import and a types target', () => {
    setCurrentSpec('package readiness exports shape')
    // An asset pattern maps to a shipped file, so it has no types and no import
    // condition. Split out first, so the JS assertions below cannot be satisfied
    // by an entry that declares nothing
    const assetEntries = Object.entries(pkg.exports).filter(
      ([key, value]) => key !== './package.json' && typeof value === 'string'
    )
    const rows = Object.entries(pkg.exports)
      .filter(([key]) => key !== './package.json')
      .filter(([, value]) => typeof value !== 'string')
      .map(([key, value]) => {
        const v = value as Record<string, string>
        return {
          entry: key,
          types: v.types,
          import: v.import,
          default: v.default
        }
      })
    log('exports', rows)
    for (const row of rows) {
      expect(row.types).toMatch(/^\.\/types\/.+\.d\.ts$/)
      expect(row.import).toMatch(/^\.\/build\/.+\.js$/)
      expect(row.default).toBe(row.import)
    }

    // The asset pattern has to be here AND the files have to ship, or the entry
    // resolves to nothing a consumer can fetch
    table(
      'exports asset patterns',
      assetEntries.map(([key, target]) => ({ entry: key, target }))
    )
    expect(
      assetEntries.map(([key]) => key),
      'the tarball ships assets/, so the package has to expose them'
    ).toContain('./assets/*')
    for (const [key, target] of assetEntries) {
      expect(target, key).toBe(key)
      // The pattern is './assets/*', so the directory it names is './assets'
      // while files spells it 'assets'
      const dir = key.replace('./', '').replace('/*', '')
      expect(pkg.files, `${key} needs ${dir} in files`).toContain(dir)
    }
    const shipped = [
      'local_weather.png',
      'shape.bin',
      'shape_detail.bin',
      'turbulence.png'
    ]
    expect(existsSync(join(ROOT, 'assets'))).toBe(true)
    for (const file of shipped) {
      expect(existsSync(join(ROOT, 'assets', file)), file).toBe(true)
    }
    log(
      'assets shipped',
      shipped.map(file => ({
        field: file,
        expected: 'present',
        actual: 'present'
      }))
    )
    // Existence needs a real build. `pnpm check` builds first, so the normal
    // pipeline always gets this row and a bare `pnpm test` logs the skip
    const built = existsSync(join(ROOT, 'types'))
    const presence = rows.map(row => ({
      entry: row.entry,
      built,
      exists: built && existsSync(join(ROOT, row.types ?? ''))
    }))
    log('types target exists', presence)
    if (built) {
      for (const row of rows) {
        expect(existsSync(join(ROOT, row.types ?? '')), row.types).toBe(true)
      }
    }
    // test/exports.test.ts asserts ./webgpu carries the root's objects
    expect(Object.keys(pkg.exports)).toContain('./webgpu')
    expect(pkg.sideEffects).toBe(false)
    // Every entry is one of the two shapes, so a new one cannot slip past both
    // branches above
    expect(rows.length + assetEntries.length + 1).toBe(
      Object.keys(pkg.exports).length
    )
  })

  it('build regenerates the declarations the post-step rewrites', () => {
    setCurrentSpec('package readiness build wiring')
    log('build', [{ build: pkg.scripts.build }])
    expect(pkg.scripts.build).toContain('pnpm build:code')
    expect(pkg.scripts['build:code']).toContain('vite build')
    expect(pkg.scripts['build:code']).toContain('scripts/dts-extensions.mjs')
  })
})
