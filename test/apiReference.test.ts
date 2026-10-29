// The optional HTML reference uses `pnpm docs:api:html` (typedoc.json)
// and is not committed. Nothing here runs typedoc, which needs the network: the
// guard is against the two silent ways that command can produce nothing, a
// mistyped entry point and a moved output directory, plus a script that stops
// invoking it

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const ROOT = resolve(import.meta.dirname, '..')
const TYPEDOC_JSON = resolve(ROOT, 'typedoc.json')
const GITIGNORE = resolve(ROOT, '.gitignore')
const PACKAGE_JSON = resolve(ROOT, 'package.json')

interface TypedocConfig {
  entryPoints?: string[]
  out?: string
  name?: string
}

/**
 * Does a .gitignore line cover `path`? Handles the three forms that appear
 * here: a bare name, a name with a trailing slash, and the same under a
 * leading double-star. A comment line, a bare star, and a negation are not
 * directory rules, so none of them counts.
 */
function ignoresPath(gitignore: string, path: string): boolean {
  return gitignore.split('\n').some(raw => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!'))
      return false
    const cleaned = line.replace(/^\*\*\//, '').replace(/\/$/, '')
    if (cleaned === '*' || cleaned === '') return false
    return path === cleaned || path.startsWith(`${cleaned}/`)
  })
}

function entryPointSizes(config: TypedocConfig) {
  return (config.entryPoints ?? []).map(entry => {
    const absolute = resolve(ROOT, entry)
    let bytes = -1
    try {
      bytes = statSync(absolute).size
    } catch {
      bytes = -1
    }
    return { entry, exists: bytes >= 0, bytes }
  })
}

describe('the generated API reference is wired up', () => {
  const config = JSON.parse(readFileSync(TYPEDOC_JSON, 'utf8')) as TypedocConfig
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    scripts?: Record<string, string>
  }
  const gitignore = readFileSync(GITIGNORE, 'utf8')

  it('every entry point exists and is not an empty file', () => {
    const sizes = entryPointSizes(config)
    log('api-reference-entry-points', {
      configured: config.entryPoints?.length ?? 0,
      resolved: sizes.filter(size => size.exists).length
    })
    log('api-reference-entry-point-sizes', sizes)

    // An entry point that does not resolve makes typedoc emit a reference with
    // nothing in it and still exit 0, which is the measurement-over-zero-inputs
    // trap this repo has already paid for four times
    expect(sizes.length, 'typedoc.json declares entry points').toBeGreaterThan(
      0
    )
    for (const size of sizes) {
      expect(size.exists, `${size.entry} exists`).toBe(true)
      expect(size.bytes, `${size.entry} is not empty`).toBeGreaterThan(0)
    }
  })

  it('the output directory is gitignored, so nothing gets committed', () => {
    const out = config.out ?? ''
    log('api-reference-out', { out, ignored: ignoresPath(gitignore, out) })

    expect(out, 'typedoc.json sets an output directory').not.toBe('')
    expect(
      ignoresPath(gitignore, out),
      `.gitignore covers ${out}/, so the generated reference stays local`
    ).toBe(true)
  })

  it('package.json runs typedoc over that config', () => {
    const script = packageJson.scripts?.['docs:api:html'] ?? ''
    log('api-reference-script', { script })
    expect(script).toContain('typedoc')
    expect(script).toContain('typedoc.json')
  })
})

// A guard is only worth its lines if it FAILS on the defect it exists for, so
// the matcher is exercised against the shapes that would each let a generated
// directory get committed
describe('the .gitignore matcher rejects what it must', () => {
  it('accepts the three directory forms and nothing loose', () => {
    log('gitignore-match-cases', [
      { line: 'api/', path: 'api', expected: true },
      { line: 'api', path: 'api', expected: true },
      { line: '**/api/', path: 'api', expected: true },
      { line: '# api/', path: 'api', expected: false },
      { line: '*', path: 'api', expected: false },
      { line: 'apiary/', path: 'api', expected: false },
      { line: 'api', path: 'apiary', expected: false },
      { line: '!api/', path: 'api', expected: false }
    ])
    for (const [line, path, expected] of [
      ['api/', 'api', true],
      ['api', 'api', true],
      ['**/api/', 'api', true],
      ['# api/', 'api', false],
      ['*', 'api', false],
      ['apiary/', 'api', false],
      ['api', 'apiary', false],
      ['!api/', 'api', false]
    ] as [string, string, boolean][]) {
      expect(
        ignoresPath(line, path),
        `${JSON.stringify(line)} against ${JSON.stringify(path)}`
      ).toBe(expected)
    }
  })
})
