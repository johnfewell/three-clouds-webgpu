import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { log } from '../../test/helpers/log'
import { verifyPackageNavigation } from './package-navigation.mjs'

const roots: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'clouds-package-links-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

describe('unpacked package navigation', () => {
  it('checks nested guides, reference links, images and duplicate heading IDs', () => {
    const root = fixture({
      'README.md':
        '[Start](docs/guide.md#start)\n[API][api]\n[api]: docs/api.md#size-1',
      'docs/guide.md': '# Start\n[Home](../README.md)\n![Diagram](diagram.svg)',
      'docs/api.md': '# Size\n# Size\n[Start](guide.md#start)',
      'docs/diagram.svg': '<svg/>',
      'docs/code.md': '```md\n[Not a real link](missing.md)\n```'
    })
    const actual = verifyPackageNavigation(root)
    log('archive navigation', actual)
    expect(actual).toEqual({ documents: 4, localLinks: 5 })
  })

  it.each([
    ['missing.md', 'target is not a shipped file'],
    ['docs', 'target is not a shipped file'],
    ['docs/guide.md#missing', 'heading does not exist'],
    ['../outside.md', 'escapes the package root'],
    ['/private/guide.md', 'escapes the package root'],
    ['file:///private/guide.md', 'unsupported URL scheme'],
    ['javascript:void', 'unsupported URL scheme'],
    ['%ZZ', 'malformed destination']
  ])('refuses %s with a source and remedy context', (target, reason) => {
    const root = fixture({
      'README.md': `[Guide](${target})`,
      'docs/guide.md': '# Start'
    })
    expect(() => verifyPackageNavigation(root)).toThrow(
      `README.md -> ${target}: ${reason}`
    )
    log('invalid navigation', { target, reason })
  })

  it('refuses empty documentation and empty local link sets', () => {
    expect(() => verifyPackageNavigation(fixture({}))).toThrow(
      'zero Markdown files'
    )
    expect(() =>
      verifyPackageNavigation(
        fixture({ 'README.md': '[External](https://example.org/guide)' })
      )
    ).toThrow('zero local navigation links')
    log('empty navigation', { documents: 'refused', localLinks: 'refused' })
  })
})
