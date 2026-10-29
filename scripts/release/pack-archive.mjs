import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { sha256, verifyProvenance } from './pack-provenance.mjs'
import { verifyPackageNavigation } from './package-navigation.mjs'

const CONSUMER_FILES = [
  'README.md',
  'INTEGRATION.md',
  'WEBGPU.md',
  'docs/API.md',
  'docs/CONSUMER_CONTRACT.md',
  'docs/MIGRATION.md',
  'docs/EXPERIMENTAL.md',
  ...['vanilla', 'webgl-fallback', 'r3f'].flatMap(recipe =>
    ['README.md', 'package.json', 'tsconfig.json', 'index.html'].map(
      file => `recipes/${recipe}/${file}`
    )
  )
]

const RECIPE_ROOT_FILES = new Set([
  'README.md',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'index.html'
])

function recipeSource(path) {
  const [, recipe, directory, file, ...rest] = path.split('/')
  if (recipe == null || rest.length !== 0) return false
  if (file == null) return RECIPE_ROOT_FILES.has(directory)
  return directory === 'src' && /^[^.][^/]*\.tsx?$/.test(file)
}

function verifyConsumerFiles(root, paths) {
  const missing = CONSUMER_FILES.filter(path => !paths.includes(path))
  if (missing.length > 0)
    throw new Error(
      `REFUSING: required consumer files are missing: ${missing.join(', ')}`
    )
  const forbidden = paths.filter(path =>
    path
      .split('/')
      .some(part =>
        [
          'AGENTS.md',
          '.beads',
          '.git',
          '.ntm',
          '.opencode',
          'node_modules',
          'test-results',
          'vendor'
        ].includes(part)
      )
  )
  if (forbidden.length > 0)
    throw new Error(
      `REFUSING: private or generated consumer files: ${forbidden.join(', ')}`
    )
  const unexpectedRecipes = paths.filter(
    path => path.startsWith('recipes/') && !recipeSource(path)
  )
  if (unexpectedRecipes.length > 0)
    throw new Error(
      `REFUSING: unapproved recipe files: ${unexpectedRecipes.join(', ')}`
    )
  for (const path of paths.filter(path => path.endsWith('.md'))) {
    const prose = readFileSync(join(root, path), 'utf8')
    if (
      /\b(?:cw|br|p[0-4])-[a-z0-9][a-z0-9.-]*|\bAGENTS\.md\b|\/Users\//i.test(
        prose
      )
    )
      throw new Error(
        `REFUSING: private maintenance details in consumer documentation ${path}`
      )
  }
  return {
    ...verifyPackageNavigation(root),
    requiredFiles: CONSUMER_FILES.length
  }
}

export function verifyArchive(tarball) {
  const archive = resolve(tarball)
  const runTar = args =>
    execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const entries = runTar(['-tzf', archive]).trim().split('\n')
  if (
    entries.length === 0 ||
    entries.some(
      path => !path.startsWith('package/') || path.split('/').includes('..')
    )
  ) {
    throw new Error('REFUSING: archive contains unsafe or empty paths')
  }
  const listing = runTar(['-tvzf', archive]).trim().split('\n')
  if (listing.some(line => !['-', 'd'].includes(line[0]))) {
    throw new Error('REFUSING: archive contains links or special files')
  }
  const temporary = mkdtempSync(join(tmpdir(), 'clouds-pack-verify-'))
  try {
    runTar(['-xzf', archive, '-C', temporary])
    const provenance = verifyProvenance(join(temporary, 'package'))
    const expected = [
      ...Object.keys(provenance.content.files),
      'package.json',
      'build/package-provenance.json'
    ]
      .map(path => `package/${path}`)
      .sort()
    const actual = entries.filter(path => !path.endsWith('/')).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error('REFUSING: archive file list differs from its provenance')
    }
    const navigation = verifyConsumerFiles(
      join(temporary, 'package'),
      Object.keys(provenance.content.files)
    )
    const receipt = {
      schemaVersion: 1,
      archive: basename(archive),
      archiveSha256: sha256(readFileSync(archive)),
      package: {
        name: provenance.package.name,
        version: provenance.package.version
      },
      contentSha256: provenance.content.sha256,
      groups: provenance.groups,
      navigation,
      qualification: provenance.qualification
    }
    writeFileSync(
      `${archive}.receipt.json`,
      `${JSON.stringify(receipt, null, 2)}\n`
    )
    return receipt
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
      throw new Error(
        'Usage: pnpm pack:verify /path/to/three-clouds-webgpu-version.tgz'
      )
    }
    console.log(JSON.stringify(verifyArchive(process.argv[2]), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
