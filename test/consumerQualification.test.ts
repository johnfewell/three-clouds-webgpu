import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkForkPins,
  digestFiles,
  inspectDependencyIsolation,
  pinRecipeThree,
  selectThree
} from '../scripts/release/qualify-consumer.mjs'
import { log } from './helpers/log'

describe('consumer qualification evidence guards', () => {
  const directories: string[] = []

  function fixture(): string {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'clouds-qualification-test-'))
    )
    directories.push(root)
    return root
  }

  function packageFile(root: string, directory: string, name: string): void {
    const path = join(root, directory)
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({ name, version: '1.0.0' })
    )
  }

  afterEach(() => {
    for (const root of directories.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  it('refuses empty measurements and binds every byte independently of path order', () => {
    const root = fixture()
    expect(() => digestFiles(root)).toThrow('empty artifact')
    expect(() => digestFiles(root, [])).toThrow('empty digest')
    writeFileSync(join(root, 'first'), 'one')
    writeFileSync(join(root, 'second'), 'two')
    const before = digestFiles(root)
    expect(digestFiles(root, ['second', 'first'])).toEqual(before)
    writeFileSync(join(root, 'second'), 'new')
    const after = digestFiles(root)
    log('consumer-byte-evidence', [
      {
        field: 'changed digest',
        expected: true,
        actual: before.sha256 !== after.sha256
      }
    ])
    expect(after.sha256).not.toBe(before.sha256)
    expect(after.files.first?.bytes).toBe(3)
  })

  it('refuses symlinks in measured source and output artifacts', () => {
    const root = fixture()
    writeFileSync(join(root, 'source'), 'bytes')
    symlinkSync(join(root, 'source'), join(root, 'alias'))
    expect(() => digestFiles(root)).toThrow('symlink in artifact')
    expect(() => digestFiles(root, ['alias'])).toThrow(
      'non-local regular artifact'
    )
    expect(() => digestFiles(root, ['../outside'])).toThrow(
      'non-local regular artifact'
    )
  })

  it('rejects symlinked node_modules and escaping inner dependency links', () => {
    const root = fixture()
    const external = fixture()
    packageFile(external, 'node_modules/three', 'three')
    symlinkSync(join(external, 'node_modules'), join(root, 'node_modules'))
    expect(() => inspectDependencyIsolation(root, true)).toThrow(
      'real directory'
    )
    const other = fixture()
    mkdirSync(join(other, 'node_modules'))
    symlinkSync(
      join(external, 'node_modules/three'),
      join(other, 'node_modules/three')
    )
    expect(() => inspectDependencyIsolation(other, true)).toThrow(
      'escapes fixture'
    )
  })

  it.each(['react', 'react-dom', '@react-three/fiber'])(
    'detects physically nested %s without a top-level link',
    name => {
      const root = fixture()
      packageFile(root, 'node_modules/.pnpm/hidden/node_modules/peer', name)
      expect(() => inspectDependencyIsolation(root, true)).toThrow(
        `contains optional peer: ${name}`
      )
    }
  )

  it('accepts local pnpm links and counts the physical packages inspected', () => {
    const root = fixture()
    packageFile(root, 'node_modules/.pnpm/three/node_modules/three', 'three')
    symlinkSync(
      '.pnpm/three/node_modules/three',
      join(root, 'node_modules/three')
    )
    const actual = inspectDependencyIsolation(root, true)
    log('consumer-physical-packages', [
      { field: 'count', expected: 1, actual: actual.packageNames.length }
    ])
    expect(actual).toEqual({
      packageNames: ['three'],
      optionalPeersAbsent: true
    })
  })
})

describe('the fork pin check refuses what it exists to catch', () => {
  const ATMOSPHERE =
    'https://example.test/download/takram-three-atmosphere-0.19.1%2Bfork.2.tgz'
  const GEOSPATIAL = 'file:./vendor/takram-three-geospatial-0.9.1+fork.2.tgz'
  const FORK_KEYS = [
    `@takram/three-atmosphere@${ATMOSPHERE}`,
    '@takram/three-geospatial@file:vendor/takram-three-geospatial-0.9.1+fork.2.tgz'
  ]
  const NPM_KEYS = [
    '@takram/three-atmosphere@0.19.1',
    '@takram/three-geospatial@0.9.1'
  ]

  // The shape pnpm writes: the overrides block is copied verbatim whether or
  // not anything resolves through it, and the packages block holds what did
  function lockfile(keys: string[]): string {
    const entries = keys.map(
      key => `  '${key}':\n    resolution: {integrity: sha512-x}\n`
    )
    return (
      "lockfileVersion: '9.0'\n\noverrides:\n" +
      `  '@takram/three-atmosphere': ${ATMOSPHERE}\n` +
      `  '@takram/three-geospatial': ${GEOSPATIAL}\n\n` +
      'importers:\n\n  .: {}\n\npackages:\n\n' +
      entries.join('\n') +
      '\nsnapshots:\n\n' +
      keys.map(key => `  '${key}': {}\n`).join('\n')
    )
  }

  function pins(): Record<
    string,
    { requested: string; version: string; override?: string }
  > {
    return {
      '@takram/three-atmosphere': {
        requested: '0.19.1',
        version: '0.19.1+fork.2',
        override: ATMOSPHERE
      },
      '@takram/three-geospatial': {
        requested: '0.9.1',
        version: '0.9.1+fork.2',
        override: GEOSPATIAL
      }
    }
  }

  it('accepts fork builds the lockfile resolves', () => {
    expect(() => checkForkPins(pins(), lockfile(FORK_KEYS))).not.toThrow()
  })

  it('refuses a lockfile whose overrides block names the fork but resolves npm', () => {
    let refusal = ''
    try {
      checkForkPins(pins(), lockfile(NPM_KEYS))
    } catch (error) {
      refusal = (error as Error).message
    }
    log('fork-pin-npm-resolved', [
      { field: 'refusal', expected: 'Lockfile resolves', actual: refusal }
    ])
    expect(refusal).toContain('Lockfile resolves @takram/three-atmosphere')
  })

  it('refuses an installed version that is not a fork build of the pin', () => {
    const versions = pins()
    versions['@takram/three-atmosphere']!.version = '0.20.0'
    expect(() => checkForkPins(versions, lockfile(FORK_KEYS))).toThrow(
      'is not a fork build of 0.19.1'
    )
  })

  it('names a recipe that leaves atmosphere to the peer instead of a TypeError', () => {
    const versions = pins()
    delete versions['@takram/three-atmosphere']
    expect(() => checkForkPins(versions, lockfile(FORK_KEYS))).toThrow(
      'Recipe must declare @takram/three-atmosphere'
    )
  })
})

describe('the three release a qualification runs on', () => {
  const recipe = {
    name: 'recipe',
    dependencies: { three: '0.185.1', 'three-clouds-webgpu': 'file:x.tgz' },
    devDependencies: { '@types/three': '0.185.0', typescript: '5.9.2' }
  }

  it('defaults to 0.185.1 and admits 0.186.1, each with its types', () => {
    const rows = [selectThree(), selectThree('0.186.1')]
    log('qualify-three', { releases: JSON.stringify(rows) })
    expect(rows).toEqual([
      { version: '0.185.1', types: '0.185.0' },
      { version: '0.186.1', types: '0.186.0' }
    ])
  })

  it.each(['0.184.0', '0.186', '0.187.0', 'latest'])('refuses %s', version => {
    expect(() => selectThree(version)).toThrow(
      `supports stock three 0.185.1 or 0.186.1, not ${version}`
    )
  })

  it('writes the release into the recipe copy and nothing else', () => {
    const pinned = pinRecipeThree(recipe, selectThree('0.186.1'))
    expect(pinned).toEqual({
      name: 'recipe',
      dependencies: { three: '0.186.1', 'three-clouds-webgpu': 'file:x.tgz' },
      devDependencies: { '@types/three': '0.186.0', typescript: '5.9.2' }
    })
    expect(recipe.dependencies.three, 'the source is not mutated').toBe(
      '0.185.1'
    )
  })

  it('refuses a recipe that does not pin three and its types', () => {
    const { devDependencies: _unused, ...untyped } = recipe
    expect(() => pinRecipeThree(untyped, selectThree())).toThrow(
      'Recipe must pin three and @types/three'
    )
  })
})
