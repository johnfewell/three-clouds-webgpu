import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const ROOT = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('the Three.js r187 consumer contract', () => {
  it('admits only the r187 release line and develops against its exact version', () => {
    const declared: string = pkg.peerDependencies.three
    log('three-peer-range', {
      declared,
      development: pkg.devDependencies.three
    })
    expect(declared).toBe('>=0.187.0 <0.188.0')
    expect(pkg.devDependencies.three).toBe('0.187.0')
    expect(pkg.devDependencies['@types/three']).toBe('0.187.0')
  })

  it('ships no dependency patch', () => {
    // A pnpm patch lives in pnpm-workspace.yaml, which is not published, so a
    // files entry for one would promise something no tarball contains
    const files: string[] = pkg.files
    log('three-peer-files', { files: files.join(' ') })
    expect(files.join(' ')).not.toContain('patch')
  })

  it('does not ship the vendored fork build', () => {
    // vendor/ holds a tarball the workspace installs from, not package content
    const files: string[] = pkg.files
    expect(files.filter(entry => /^!?vendor\b/.test(entry))).toEqual([])
  })

  it('keeps three a peer, not a direct dependency', () => {
    // A direct dependency would install a second three beside the consumer's
    // and break instanceof across the boundary
    expect(pkg.dependencies?.three).toBeUndefined()
    expect(pkg.peerDependencies.three).toBeDefined()
  })
})
