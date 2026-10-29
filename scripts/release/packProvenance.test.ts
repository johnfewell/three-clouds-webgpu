import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { log } from '../../test/helpers/log'
import { verifyArchive } from './pack-archive.mjs'
import {
  cleanTypes,
  fileDigest,
  PROVENANCE_PATH,
  sha256,
  verifyProvenance,
  writeProvenance
} from './pack-provenance.mjs'

const ROOT = join(import.meta.dirname, '../..')
const temporaries: string[] = []
const RECIPE_ARTIFACTS = [
  'recipes/vanilla/dist/index.html',
  'recipes/r3f/.vite/cache.json',
  'recipes/vanilla/pnpm-lock.yaml',
  'recipes/r3f/package-lock.json',
  'recipes/vanilla/src/.vite/cache.ts'
]

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'clouds-pack-test-'))
  temporaries.push(directory)
  return directory
}

function put(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

function command(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      ...env,
      pnpm_config_verify_deps_before_run: 'false'
    }
  })
  if (result.error != null) throw result.error
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

function coherentArchive(root: string): string {
  const destination = temporary()
  const staged = join(destination, 'package')
  mkdirSync(staged)
  const provenance = verifyProvenance(root)
  for (const path of [
    ...Object.keys(provenance.content.files),
    'package.json',
    PROVENANCE_PATH
  ]) {
    mkdirSync(dirname(join(staged, path)), { recursive: true })
    cpSync(join(root, path), join(staged, path))
  }
  const archive = join(destination, 'coherent.tgz')
  const packed = spawnSync('tar', [
    '-czf',
    archive,
    '-C',
    destination,
    'package'
  ])
  expect(packed.status, packed.stderr?.toString()).toBe(0)
  return archive
}

afterAll(() => {
  for (const directory of temporaries)
    rmSync(directory, { recursive: true, force: true })
})

describe('package provenance refuses incomplete input', () => {
  it('refuses zero files instead of hashing an empty input', () => {
    log('empty digest', { inputFiles: 0, expected: 'refusal' })
    expect(() => fileDigest(temporary(), [])).toThrow('zero files')
  })

  it('refuses missing provenance with a rebuild remedy', () => {
    log('missing provenance', { expected: 'refusal with pnpm build remedy' })
    expect(() => verifyProvenance(temporary())).toThrow(
      'Run pnpm build before pnpm pack'
    )
  })

  it('cleans obsolete declarations and refuses generated-directory symlinks', () => {
    log('declaration cleanup', {
      expected: 'obsolete declarations removed, symlinks refused'
    })
    const root = temporary()
    put(
      root,
      'types/removed-source.d.ts',
      'export declare const obsolete: true\n'
    )
    cleanTypes(root)
    expect(existsSync(join(root, 'types'))).toBe(false)
    const shared = temporary()
    put(shared, 'sentinel', 'untouched')
    symlinkSync(shared, join(root, 'types'), 'dir')
    expect(() => cleanTypes(root)).toThrow('generated directory is a symlink')
    expect(readFileSync(join(shared, 'sentinel'), 'utf8')).toBe('untouched')
    const dangling = temporary()
    symlinkSync(
      join(dangling, 'missing-output'),
      join(dangling, 'build'),
      'dir'
    )
    expect(() => cleanTypes(dangling)).toThrow(
      'generated directory is a symlink'
    )
  })
})

describe('ordinary pnpm packing uses actual isolated build output', () => {
  let fixture: string

  beforeAll(() => {
    fixture = temporary()
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8')
    ) as { files: string[] }
    const inputs = [
      ...packageJson.files
        .filter(
          path => !path.startsWith('!') && !['build', 'types'].includes(path)
        )
        .flatMap(pattern => {
          const matches = globSync(pattern, { cwd: ROOT })
          expect(matches.length, `package input ${pattern}`).toBeGreaterThan(0)
          return matches
        }),
      'package.json',
      'vite.config.ts',
      'tsconfig.json',
      'tsconfig.lib.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/dts-extensions.mjs',
      'scripts/docs/api-reference.mjs',
      'scripts/install-hooks.mjs',
      'scripts/release/pack-provenance.mjs'
    ]
    for (const path of new Set(inputs)) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true })
      cpSync(join(ROOT, path), join(fixture, path), {
        recursive: true,
        filter: candidate => !candidate.split('/').includes('node_modules')
      })
    }
    symlinkSync(
      join(ROOT, 'node_modules'),
      join(fixture, 'node_modules'),
      'dir'
    )
    for (const path of RECIPE_ARTIFACTS) put(fixture, path, 'local artifact')
    const result = command(fixture, ['build'], { NODE_ENV: 'test' })
    expect(result.status, result.output).toBe(0)
  }, 180_000)

  it('builds with stale documentation but refuses to check or pack it without rewriting', () => {
    const path = join(fixture, 'docs/API.md')
    const current = readFileSync(path, 'utf8')
    const stale = `${current}\nStale generated reference\n`
    writeFileSync(path, stale)
    try {
      const build = command(fixture, ['build'], { NODE_ENV: 'test' })
      expect(build.status, build.output).toBe(0)
      const result = command(fixture, ['docs:api:check'])
      expect(result.status, result.output).not.toBe(0)
      expect(result.output).toContain('pnpm docs:api and commit the result')
      const destination = temporary()
      const packed = command(fixture, [
        'pack',
        '--pack-destination',
        destination
      ])
      expect(packed.status, packed.output).not.toBe(0)
      expect(packed.output).toContain('pnpm docs:api and commit the result')
      expect(readdirSync(destination)).toEqual([])
      expect(readFileSync(path, 'utf8')).toBe(stale)
      log('committed API freshness', {
        localBuild: 'passed',
        staleCheckAndPack: 'refused',
        rewritten: false
      })
    } finally {
      writeFileSync(path, current)
      writeProvenance(fixture)
    }
  }, 180_000)

  it('uses production JSX without local paths even under NODE_ENV=test', () => {
    const files = readdirSync(join(fixture, 'build')).filter(name =>
      name.endsWith('.js')
    )
    expect(files.length).toBeGreaterThan(0)
    const output = new Map(
      files.map(name => [
        name,
        readFileSync(join(fixture, 'build', name), 'utf8')
      ])
    )
    expect(output.get('r3f.js')).toContain('react/jsx-runtime')
    for (const contents of output.values()) {
      expect(contents).not.toContain('react/jsx-dev-runtime')
      expect(contents).not.toContain(fixture)
      expect(contents).not.toContain(realpathSync(fixture))
      expect(contents).not.toContain(ROOT)
    }
    const production = command(fixture, ['build'], { NODE_ENV: 'production' })
    expect(production.status, production.output).toBe(0)
    for (const [name, contents] of output) {
      expect(readFileSync(join(fixture, 'build', name), 'utf8')).toBe(contents)
    }
    log('library JSX build', {
      inheritedNodeEnv: 'test',
      runtime: 'react/jsx-runtime',
      emittedJavaScriptFiles: files.length,
      matchesProduction: true
    })
  }, 180_000)

  it('refuses build output that imports the React dev JSX runtime', () => {
    const path = join(fixture, 'build', 'r3f.js')
    const clean = readFileSync(path, 'utf8')
    try {
      appendFileSync(
        path,
        '\nimport { jsxDEV } from "react/jsx-dev-runtime";\n'
      )
      expect(() => writeProvenance(fixture)).toThrow(/jsx-dev-runtime/)
      expect(() => verifyProvenance(fixture)).toThrow(/jsx-dev-runtime/)
      log('dev JSX guard', {
        tampered: 'build/r3f.js',
        write: 'refused',
        check: 'refused'
      })
    } finally {
      writeFileSync(path, clean)
      writeProvenance(fixture)
    }
  })

  it('refuses stale source, rebuilds without orphan types, and verifies actual archive bytes', () => {
    const previous = verifyProvenance(fixture, { checkBuildInputs: true })
    const staleDestination = temporary()
    appendFileSync(
      join(fixture, 'src/constants.ts'),
      '\nexport const packFixtureMarker = 42\n'
    )
    const stale = command(fixture, [
      'pack',
      '--pack-destination',
      staleDestination
    ])
    log('stale pack', {
      status: stale.status,
      refused: stale.output.includes('Run pnpm build')
    })
    expect(stale.status, stale.output).not.toBe(0)
    expect(stale.output).toContain('src/constants.ts')
    expect(stale.output).toContain('Run pnpm build')
    expect(readdirSync(staleDestination)).toEqual([])
    expect(() => writeProvenance(fixture)).toThrow('source map is stale')
    put(
      fixture,
      'types/removed-source.d.ts',
      'export declare const obsolete: true\n'
    )
    const rebuilt = command(fixture, ['build'])
    expect(rebuilt.status, rebuilt.output).toBe(0)
    expect(existsSync(join(fixture, 'types/removed-source.d.ts'))).toBe(false)
    expect(
      readFileSync(join(fixture, 'types/constants.d.ts'), 'utf8')
    ).toContain('packFixtureMarker = 42')
    const current = verifyProvenance(fixture, { checkBuildInputs: true })
    expect(current.content.sha256).not.toBe(previous.content.sha256)
    const destination = temporary()
    const packed = command(fixture, ['pack', '--pack-destination', destination])
    expect(packed.status, packed.output).toBe(0)
    const archives = readdirSync(destination).filter(name =>
      name.endsWith('.tgz')
    )
    expect(archives).toHaveLength(1)
    const archive = join(destination, archives[0]!)
    const receipt = verifyArchive(archive)
    for (const path of RECIPE_ARTIFACTS) {
      expect(Object.keys(current.content.files)).not.toContain(path)
      expect(existsSync(join(fixture, path))).toBe(true)
    }
    expect(receipt.archiveSha256).toBe(sha256(readFileSync(archive)))
    expect(receipt.contentSha256).toBe(current.content.sha256)
    expect(receipt.groups).toEqual(current.groups)
    expect(receipt.navigation.documents).toBeGreaterThan(0)
    expect(receipt.navigation.localLinks).toBeGreaterThan(0)
    expect(receipt.navigation.requiredFiles).toBeGreaterThan(0)
    expect(receipt.qualification).toContain(
      'no rendering or test qualification'
    )
    expect(existsSync(`${archive}.receipt.json`)).toBe(true)
    const manifest = spawnSync(
      'tar',
      ['-xOf', archive, 'package/package.json'],
      { encoding: 'utf8' }
    )
    expect(manifest.status, manifest.stderr).toBe(0)
    const installed = JSON.parse(manifest.stdout) as {
      scripts: Record<string, string>
      packageManager?: string
    }
    expect(installed.scripts.prepack).toBeUndefined()
    expect(installed.scripts.prepare).toBeUndefined()
    expect(installed.packageManager).toBeUndefined()
    const unpacked = temporary()
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', unpacked])
    expect(extracted.status).toBe(0)
    const declaration = join(unpacked, 'package/types/index.d.ts')
    const original = readFileSync(declaration, 'utf8')
    appendFileSync(declaration, '\n')
    const tampered = join(destination, 'tampered.tgz')
    expect(
      spawnSync('tar', ['-czf', tampered, '-C', unpacked, 'package']).status
    ).toBe(0)
    expect(() => verifyArchive(tampered)).toThrow('types/index.d.ts')
    expect(existsSync(`${tampered}.receipt.json`)).toBe(false)
    writeFileSync(declaration, original)
    put(unpacked, 'package/unlisted.txt', 'not in the declared payload')
    const extra = join(destination, 'extra.tgz')
    expect(
      spawnSync('tar', ['-czf', extra, '-C', unpacked, 'package']).status
    ).toBe(0)
    expect(() => verifyArchive(extra)).toThrow('archive file list differs')
    log('packed provenance', {
      archiveSha256: receipt.archiveSha256,
      sourceFiles: receipt.groups.src?.count,
      declarationFiles: receipt.groups.types?.count,
      contentSha256: receipt.contentSha256
    })
  }, 180_000)

  it.each([
    ['broken link', 'Broken package navigation'],
    ['private prose', 'private maintenance details'],
    ['missing guide', 'required consumer files are missing'],
    ['private file', 'private or generated consumer files'],
    [
      'vendor/takram-three-geospatial.tgz',
      'private or generated consumer files'
    ],
    ...RECIPE_ARTIFACTS.map(path => [path, 'unapproved recipe files'])
  ])(
    'refuses an integrity-consistent archive with %s',
    (scenario, reason) => {
      const root = temporary()
      cpSync(fixture, root, {
        recursive: true,
        filter: path => !path.split('/').includes('node_modules')
      })
      const manifestPath = join(root, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        files: string[]
      }
      if (scenario === 'broken link') {
        appendFileSync(
          join(root, 'README.md'),
          '\n[Required guide](missing.md)\n'
        )
      } else if (scenario === 'private prose') {
        appendFileSync(
          join(root, 'README.md'),
          `\n${['cw', 'private-task'].join('-')}\n`
        )
      } else if (scenario === 'missing guide') {
        manifest.files = manifest.files.filter(
          path => path !== 'INTEGRATION.md'
        )
        rmSync(join(root, 'INTEGRATION.md'))
      } else if (scenario === 'private file') {
        put(root, 'AGENTS.md', 'Private operating instructions\n')
        manifest.files.push('AGENTS.md')
      } else {
        put(root, scenario, 'local artifact')
        manifest.files.push(scenario)
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      writeProvenance(root)
      const archive = coherentArchive(root)
      expect(() => verifyArchive(archive)).toThrow(reason)
      expect(existsSync(`${archive}.receipt.json`)).toBe(false)
      log('archive consumer contract', {
        scenario,
        integrity: 'coherent',
        expected: reason
      })
    },
    180_000
  )

  it('allows ordinary prose and keeps historical annotations in byte-matched source', () => {
    const root = temporary()
    cpSync(fixture, root, {
      recursive: true,
      filter: path => !path.split('/').includes('node_modules')
    })
    appendFileSync(
      join(root, 'README.md'),
      '\nA task of water is ordinary prose.\n'
    )
    put(
      root,
      'src/archive-policy-fixture.ts',
      `// Historical ${['cw', 'archive-test'].join('-')}\nexport const marker = 1\n`
    )
    const provenance = writeProvenance(root)
    const sources = Object.keys(provenance.content.files).filter(path =>
      path.startsWith('src/')
    )
    expect(sources.length).toBeGreaterThan(0)
    const annotated = sources.filter(path =>
      new RegExp(`\\b${['cw', '[a-z0-9]'].join('-')}`).test(
        readFileSync(join(root, path), 'utf8')
      )
    )
    expect(annotated.length).toBeGreaterThan(0)
    const archive = coherentArchive(root)
    expect(verifyArchive(archive).contentSha256).toBe(provenance.content.sha256)
    log('archive documentation policy', {
      ordinaryWordAllowed: true,
      annotatedSources: annotated.length,
      sourceMapBytes: 'unchanged'
    })
  })

  it('refuses a required package input matching zero files', () => {
    const root = temporary()
    cpSync(fixture, root, {
      recursive: true,
      filter: path => !path.split('/').includes('node_modules')
    })
    rmSync(join(root, 'INTEGRATION.md'))
    expect(() => writeProvenance(root)).toThrow(
      'package input matched zero files: INTEGRATION.md'
    )
    log('missing package input', {
      path: 'INTEGRATION.md',
      expected: 'refusal'
    })
  })

  it.each(['tsconfig.lib.json', 'scripts/docs/api-reference.mjs'])(
    'refuses changed build input %s before packing',
    path => {
      const root = temporary()
      cpSync(fixture, root, {
        recursive: true,
        filter: candidate => !candidate.split('/').includes('node_modules')
      })
      appendFileSync(join(root, path), '\n')
      log('changed build input', { path, expected: 'refusal' })
      expect(() => verifyProvenance(root, { checkBuildInputs: true })).toThrow(
        'build inputs changed'
      )
    }
  )

  it.each(['build/shared.js', 'types/index.d.ts', 'src/index.ts'])(
    'refuses independently changed %s',
    path => {
      const root = temporary()
      cpSync(fixture, root, {
        recursive: true,
        filter: candidate => !candidate.split('/').includes('node_modules')
      })
      const addition =
        path === 'src/index.ts'
          ? '\nexport type PackTypeOnly = { changed: true }\n'
          : '\n'
      appendFileSync(join(root, path), addition)
      log('changed package input', {
        path,
        expected: 'refusal naming the path'
      })
      expect(() => verifyProvenance(root, { checkBuildInputs: true })).toThrow(
        path
      )
    }
  )

  it('refuses missing declarations and zero-source maps', () => {
    log('missing generated input', {
      declarations: 'removed',
      mapInputs: 0,
      expected: 'refusal'
    })
    const root = temporary()
    cpSync(fixture, root, {
      recursive: true,
      filter: path => !path.split('/').includes('node_modules')
    })
    rmSync(join(root, 'types'), { recursive: true })
    expect(() => verifyProvenance(root)).toThrow(
      'package input matched zero files: types'
    )
    cpSync(join(fixture, 'types'), join(root, 'types'), { recursive: true })
    for (const name of readdirSync(join(root, 'build')).filter(name =>
      name.endsWith('.js.map')
    )) {
      put(
        root,
        `build/${name}`,
        JSON.stringify({ sources: [], sourcesContent: [] })
      )
    }
    expect(() => writeProvenance(root)).toThrow('source maps matched zero')
  })

  it('does not put local paths or an inferred Git revision in provenance', () => {
    const text = readFileSync(join(fixture, PROVENANCE_PATH), 'utf8')
    log('provenance privacy', {
      containsFixture: text.includes(fixture),
      expected: false
    })
    expect(text).not.toContain(fixture)
    expect(text).not.toContain(ROOT)
    expect(text).not.toContain('revision')
  })
})
