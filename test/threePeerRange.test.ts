// three 0.185 removed `struct().layout`, which the npm builds of
// @takram/three-atmosphere and @takram/three-geospatial read while their module
// bodies evaluate. The pinned fork builds no longer read it, so 0.185 is in
// range. 0.186 is in range on fork release 7, whose scattering-LUT kernel
// builds correctly on r186. 0.187 has not been measured.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { log } from './helpers/log'

const ROOT = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('the three peer range excludes every broken version', () => {
  it('caps three below 0.187', () => {
    const declared: string = pkg.peerDependencies.three
    log('three-peer-range', { declared })
    expect(declared).toContain('<0.187.0')
  })

  it('still admits 0.184, the oldest verified version', () => {
    expect(pkg.peerDependencies.three).toContain('>=0.184.0')
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
