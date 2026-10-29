import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { workspaceOverrides } from '../scripts/port-gates/lockfile-manifests.mjs'

const ROOT = join(import.meta.dirname, '..')
const EXAMPLE = join(ROOT, 'examples/parity')

function readPkg(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function installedVersion(pkg: string, from = ROOT): string {
  return readPkg(join(from, 'node_modules', pkg)).version as string
}

const FORK_TAG = 'fork.7'
const ATMOSPHERE_URL =
  'https://github.com/johnfewell/three-geospatial/releases/download/' +
  'fork-release-7/takram-three-atmosphere-0.19.1%2Bfork.7.tgz'
const ATMOSPHERE_WEBGPU_SHA256 =
  '4c0ef92f2ef3a288196e088a6c0d49e9f0b841222632624ff1ef90ea864b124f'
const GEOSPATIAL_TARBALL = 'takram-three-geospatial-0.9.1+fork.7.tgz'
const GEOSPATIAL_TARBALL_SHA256 =
  '319ea47db67a9372e6dce58317cc702b6fd105e051964ed4c8e474bf072d9e44'
const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

// The committed lockfile carries sha512 integrity for the URL entry, but a
// resolve on a warm store writes it without one and a replaced release asset
// then installs silently. These are the bytes of fork release 7
describe('fork builds', () => {
  const overrides = workspaceOverrides(ROOT)

  it('pins the atmosphere build by its release URL and its bytes', () => {
    const dir = join(ROOT, 'node_modules/@takram/three-atmosphere')
    const actual = {
      override: overrides['@takram/three-atmosphere'],
      version: installedVersion('@takram/three-atmosphere'),
      webgpu: sha256(join(dir, 'build/webgpu.js'))
    }
    console.table([actual])
    expect(actual).toEqual({
      override: ATMOSPHERE_URL,
      version: '0.19.1+fork.7',
      webgpu: ATMOSPHERE_WEBGPU_SHA256
    })
  })

  it('pins the geospatial build to the vendored tarball', () => {
    const spec = overrides['@takram/three-geospatial']
    const file = join(ROOT, (spec ?? '').replace(/^file:/, ''))
    const actual = { spec, tarball: sha256(file) }
    console.table([actual])
    expect(actual).toEqual({
      spec: `file:./vendor/${GEOSPATIAL_TARBALL}`,
      tarball: GEOSPATIAL_TARBALL_SHA256
    })
  })
})

describe('pins', () => {
  const rootPkg = readPkg(ROOT)
  const devDeps = rootPkg.devDependencies as Record<string, string>

  // The takram devDependencies name the npm release the fork builds are cut
  // from, and pnpm-workspace.yaml overrides install the fork build of it
  const pins = [
    { name: 'three', expected: devDeps.three },
    {
      name: '@takram/three-atmosphere',
      expected: `${devDeps['@takram/three-atmosphere']}+${FORK_TAG}`
    },
    {
      name: '@takram/three-geospatial',
      expected: `${devDeps['@takram/three-geospatial']}+${FORK_TAG}`
    }
  ]

  it.each(pins)(
    'installed $name matches devDependency pin',
    ({ name, expected }) => {
      const installed = installedVersion(name)
      console.table([{ package: name, expected, installed }])
      expect(installed).toBe(expected)
    }
  )

  it('library and example resolve the same @takram/three-atmosphere copy', () => {
    const libPath = realpathSync(
      join(ROOT, 'node_modules/@takram/three-atmosphere')
    )
    const exPath = realpathSync(
      join(EXAMPLE, 'node_modules/@takram/three-atmosphere')
    )
    console.table([
      { location: 'library root', path: libPath },
      { location: 'examples/parity', path: exPath }
    ])
    expect(libPath).toBe(exPath)
  })

  it('library and example resolve the same three copy', () => {
    const libPath = realpathSync(join(ROOT, 'node_modules/three'))
    const exPath = realpathSync(join(EXAMPLE, 'node_modules/three'))
    console.table([
      { location: 'library root', path: libPath },
      { location: 'examples/parity', path: exPath }
    ])
    expect(libPath).toBe(exPath)
  })

  it('@playwright/test resolves from the example', () => {
    const dir = join(EXAMPLE, 'node_modules/@playwright/test')
    const pkg = readPkg(dir)
    console.table([
      { package: '@playwright/test', version: pkg.version, from: 'example' }
    ])
    expect(pkg.version).toBeTruthy()
  })
})
