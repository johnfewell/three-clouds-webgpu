// The core's point is that it runs without three. A single import of three,
// takram or the port's src/ from a runtime file would quietly pull three back
// into every consumer, and nothing else would notice

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { log } from '../../test/helpers/log'

const CORE = resolve(import.meta.dirname, '..')
const ROOT = resolve(CORE, '..')

function runtimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return runtimeFiles(path)
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
      ? [path]
      : []
  })
}

// Every module specifier: static imports, re-exports and dynamic imports
function specifiers(source: string): string[] {
  const pattern =
    /(?:^|[\s;])(?:import|export)\b[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm
  return [...source.matchAll(pattern)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

function forbidden(file: string, specifier: string): boolean {
  if (/^(three|@takram)(\/|$)/.test(specifier)) return true
  if (!specifier.startsWith('.')) return false
  const target = resolve(file, '..', specifier)
  return relative(CORE, target).startsWith('..')
}

describe('core runtime imports nothing from three', () => {
  it('the specifier scan sees every import form', () => {
    // A positive control for the scanner itself
    const sample = [
      "import { Matrix4 } from 'three'",
      "import type { Ellipsoid } from '@takram/three-geospatial'",
      "export { x } from '../../src/x'",
      "import 'three/tsl'",
      "const m = await import('three/webgpu')"
    ].join('\n')
    expect(specifiers(sample)).toEqual([
      'three',
      '@takram/three-geospatial',
      '../../src/x',
      'three/tsl',
      'three/webgpu'
    ])
  })

  it('no runtime file under core/src reaches three, takram or src/', () => {
    const files = runtimeFiles(join(CORE, 'src'))
    // A scan over zero files would pass vacuously
    expect(files.length).toBeGreaterThan(0)
    const rows = files.map(file => {
      const found = specifiers(readFileSync(file, 'utf8'))
      return {
        file: relative(ROOT, file),
        imports: found.length,
        forbidden: found.filter(s => forbidden(file, s))
      }
    })
    log('core-imports', rows)
    expect(rows.filter(r => r.forbidden.length > 0)).toEqual([])
  })

  it('core declares no three or takram dependency', () => {
    const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'))
    expect(pkg.private).toBe(true)
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies
    })
    expect(deps.filter(d => /^(three|@takram)(\/|$)/.test(d))).toEqual([])
  })

  it('the published three package does not ship core/', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const published = JSON.stringify([pkg.files, pkg.exports])
    expect(published).not.toMatch(/core/)
  })
})
