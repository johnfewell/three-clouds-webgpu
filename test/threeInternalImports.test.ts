// The published `build/` and `src/` must not name a three SOURCE path
//
// three's exports map does list "./src/*", so `three/src/nodes/core/NodeUtils.js`
// resolves. That is the problem: the wildcard serves three's own tooling and no
// semver peer range covers the file behind it. The allowlist comes from the
// INSTALLED three's exports map (no `*` in a key means a fixed subpath)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from './helpers/cpuTwin'
import { log, setCurrentSpec } from './helpers/log'

const ROOT = join(import.meta.dirname, '..')

interface ThreeManifest {
  exports: Record<string, unknown>
}

const three = JSON.parse(
  readFileSync(join(ROOT, 'node_modules/three/package.json'), 'utf8')
) as ThreeManifest

// `three`, `three/webgpu`, `three/tsl`, `three/addons`: every fixed subpath the
// installed three names, plus the bare specifier its "." entry serves
const publicEntries = Object.keys(three.exports)
  .filter(key => !key.includes('*'))
  .map(key => (key === '.' ? 'three' : `three/${key.replace(/^\.\//, '')}`))
  .sort()

function collectFiles(
  dir: string,
  ext: string[],
  out: string[] = []
): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectFiles(full, ext, out)
    } else if (ext.some(e => entry.endsWith(e))) {
      out.push(full)
    }
  }
  return out
}

// A `from 'x'` inside a comment is prose, not an import
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const SPECIFIERS = {
  // the four specifier positions of a module
  all: [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ],
  // declarations only: @types/three bakes
  // `import('three/src/nodes/TSL.js')` into the identity of FnNode and Struct,
  // so an inline type argument naming a source path is three's own text
  declared: [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g]
}

function threeSpecifiers(source: string, patterns: RegExp[]): string[] {
  const code = stripComments(source)
  const out = new Set<string>()
  for (const pattern of patterns) {
    for (const m of code.matchAll(pattern)) {
      const spec = m[1]!
      // `three`, `three/webgpu`: not `three-clouds-webgpu`
      if (spec === 'three' || spec.startsWith('three/')) out.add(spec)
    }
  }
  return [...out].sort()
}

function scan(files: string[], patterns: RegExp[]) {
  return files.map(full => {
    const specs = threeSpecifiers(readFileSync(full, 'utf8'), patterns)
    return {
      file: relative(ROOT, full),
      specifiers: specs.join(' '),
      offending: specs.filter(s => !publicEntries.includes(s)).join(' ')
    }
  })
}

describe('the published output names only public three entries', () => {
  it('reads a public-entry allowlist off the installed three', () => {
    setCurrentSpec('three entry allowlist')
    log('three-public-entries', { entries: publicEntries.join(' ') })
    // A wildcard-only map would reduce the allowlist to `three` alone and
    // make every subpath an offence, so the guard needs three to name them
    expect(publicEntries.length).toBeGreaterThan(1)
    expect(publicEntries).toContain('three/webgpu')
    expect(publicEntries).toContain('three/tsl')
  })

  it('src/ imports three through a public entry', () => {
    setCurrentSpec('src three specifiers')
    // src/ ships in files, so an internal specifier here is a consumer's
    // problem. The one test that reaches a three source path does it through a
    // variable, and tests are not published
    const files = collectFiles(join(ROOT, 'src'), ['.ts', '.tsx']).filter(
      f => !f.includes('.test.')
    )
    const rows = scan(files, SPECIFIERS.all)
    table('src three specifiers', rows)
    expect(rows.length, 'the scan read no files').toBeGreaterThan(0)
    expect(
      rows
        .filter(r => r.offending !== '')
        .map(r => `${r.file}: ${r.offending}`),
      'a three source path in src/ breaks consumers on any release that moves it'
    ).toEqual([])
  })

  it('build/ imports three through a public entry', () => {
    setCurrentSpec('build three specifiers')
    const dir = join(ROOT, 'build')
    // pnpm typecheck builds first, so the pipeline always has build/. A bare
    // `pnpm test` on an unbuilt tree logs the skip instead of a pass over zero
    // files
    if (!existsSync(dir)) {
      log('build three specifiers', {
        built: false,
        filesScanned: 0,
        note: 'SKIP: pnpm build produces the output under test'
      })
      return
    }
    // a .map carries the original specifiers, so scanning it would only
    // report the same imports twice
    const rows = scan(collectFiles(dir, ['.js', '.mjs']), SPECIFIERS.all)
    table('build three specifiers', rows)
    expect(rows.length, 'the scan read no files').toBeGreaterThan(0)
    expect(
      rows
        .filter(r => r.offending !== '')
        .map(r => `${r.file}: ${r.offending}`),
      'a three source path in build/ reaches the consumer verbatim'
    ).toEqual([])
  })

  it('types/ declares three imports through a public entry', () => {
    setCurrentSpec('types three specifiers')
    const files = collectFiles(join(ROOT, 'types'), ['.d.ts'])
    const offenders = scan(files, SPECIFIERS.declared).filter(
      r => r.offending !== ''
    )
    table('types three specifiers', offenders)
    expect(
      offenders.map(r => `${r.file}: ${r.offending}`),
      'a consumer resolves a declaration specifier with their own three'
    ).toEqual([])
  })
})
