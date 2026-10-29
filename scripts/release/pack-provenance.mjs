import { createHash } from 'node:crypto'
import {
  existsSync,
  globSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'

export const PROVENANCE_PATH = 'build/package-provenance.json'

const BUILD_INPUTS = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.lib.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/dts-extensions.mjs',
  'scripts/docs/api-reference.mjs',
  'scripts/release/pack-provenance.mjs'
]

function refuse(message, remedy = 'Run pnpm build before pnpm pack') {
  throw new Error(`REFUSING: ${message}. ${remedy}`)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function fileDigest(root, paths) {
  if (paths.length === 0) refuse('cannot hash zero files')
  const files = Object.fromEntries(
    [...paths]
      .sort()
      .map(path => [path, sha256(readFileSync(join(root, path)))])
  )
  return { sha256: sha256(JSON.stringify(files)), files }
}

function walk(root, path) {
  const full = join(root, path)
  const stat = lstatSync(full)
  if (stat.isSymbolicLink()) refuse(`package input is a symlink: ${path}`)
  if (!stat.isDirectory()) return [path]
  return readdirSync(full)
    .filter(name => name !== 'node_modules' && name !== '.git')
    .flatMap(name => walk(root, join(path, name)))
}

function manifest(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

function packageContract(pkg) {
  return Object.fromEntries(
    [
      'name',
      'version',
      'type',
      'exports',
      'module',
      'types',
      'sideEffects',
      'dependencies',
      'peerDependencies',
      'peerDependenciesMeta'
    ].map(key => [key, pkg[key]])
  )
}

function packageFiles(root, pkg) {
  const excluded = pkg.files.filter(pattern => pattern.startsWith('!'))
  const included = pkg.files
    .filter(pattern => !pattern.startsWith('!'))
    .flatMap(pattern => {
      const matches = globSync(pattern, { cwd: root })
      if (matches.length === 0)
        refuse(`package input matched zero files: ${pattern}`)
      return matches
    })
    .flatMap(path => walk(root, path))
  return [...new Set([...included, 'README.md', 'LICENSE'])]
    .filter(path => path !== 'package.json' && path !== PROVENANCE_PATH)
    .filter(
      path => !excluded.some(pattern => matchesGlob(path, pattern.slice(1)))
    )
    .sort()
}

function inputs(root) {
  return fileDigest(root, [
    ...BUILD_INPUTS,
    ...globSync('patches/*', { cwd: root })
  ])
}

function summaries(root, paths) {
  return Object.fromEntries(
    ['src', 'build', 'types'].map(directory => {
      const selected = paths.filter(path => path.startsWith(`${directory}/`))
      return [
        directory,
        { count: selected.length, sha256: fileDigest(root, selected).sha256 }
      ]
    })
  )
}

function assertLocal(path) {
  if (!path.startsWith('./') || path.split('/').includes('..')) {
    refuse(`nonlocal export target ${path}`)
  }
}

function exportTargets(value) {
  if (typeof value === 'string') return [value]
  if (value == null) return []
  return Object.values(value).flatMap(exportTargets)
}

export function verifyExports(root) {
  const pkg = manifest(root)
  const targets = exportTargets(pkg.exports)
  if (targets.length === 0) refuse('package has zero export targets')
  for (const target of targets) {
    assertLocal(target)
    const files = globSync(target, { cwd: root })
    if (files.length === 0) refuse(`missing export target ${target}`)
    for (const file of files) {
      if (!lstatSync(join(root, file)).isFile())
        refuse(`export is not a file: ${file}`)
    }
  }
  return targets.length
}

function verifySourceMaps(root, paths) {
  let matched = 0
  for (const path of paths.filter(
    path => path.startsWith('build/') && path.endsWith('.js.map')
  )) {
    const map = JSON.parse(readFileSync(join(root, path), 'utf8'))
    map.sources.forEach((source, index) => {
      const full = resolve(root, dirname(path), map.sourceRoot ?? '', source)
      const local = relative(root, full)
      if (!local.startsWith('src/')) return
      if (!paths.includes(local))
        refuse(`source map names an unpacked source: ${local}`)
      if (readFileSync(full, 'utf8') !== map.sourcesContent?.[index]) {
        refuse(`source map is stale for ${local}`)
      }
      matched++
    })
  }
  if (matched === 0) refuse('source maps matched zero source files')
  return matched
}

// A build under an inherited NODE_ENV=test emits react/jsx-dev-runtime unless
// vite.config.ts pins esbuild.jsxDev false, and production React leaves that
// import undefined. Refuse it here rather than in a consumer
export function verifyProductionJsx(root, paths) {
  const scripts = paths.filter(
    path => path.startsWith('build/') && path.endsWith('.js')
  )
  if (scripts.length === 0) refuse('build output matched zero scripts')
  for (const path of scripts) {
    if (
      readFileSync(join(root, path), 'utf8').includes('react/jsx-dev-runtime')
    )
      refuse(
        `build output imports react/jsx-dev-runtime: ${path}`,
        'Keep esbuild.jsxDev false in vite.config.ts and rebuild'
      )
  }
  return scripts.length
}

export function cleanTypes(root) {
  for (const directory of ['build', 'types']) {
    const full = join(root, directory)
    if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) {
      refuse(`generated directory is a symlink: ${directory}`)
    }
  }
  rmSync(join(root, 'types'), { recursive: true, force: true })
}

export function writeProvenance(root) {
  const pkg = manifest(root)
  const paths = packageFiles(root, pkg)
  const groups = summaries(root, paths)
  const sourceMapInputs = verifySourceMaps(root, paths)
  const exportTargetCount = verifyExports(root)
  verifyProductionJsx(root, paths)
  const provenance = {
    schemaVersion: 1,
    package: packageContract(pkg),
    content: fileDigest(root, paths),
    groups,
    buildInputs: inputs(root),
    checks: { sourceMapInputs, exportTargetCount },
    qualification:
      'File integrity and export presence only; no rendering or test qualification'
  }
  writeFileSync(
    join(root, PROVENANCE_PATH),
    `${JSON.stringify(provenance, null, 2)}\n`
  )
  return provenance
}

export function verifyProvenance(root, { checkBuildInputs = false } = {}) {
  const full = join(root, PROVENANCE_PATH)
  if (!existsSync(full)) refuse(`missing ${PROVENANCE_PATH}`)
  const provenance = JSON.parse(readFileSync(full, 'utf8'))
  if (provenance.schemaVersion !== 1)
    refuse('unknown package provenance schema')
  const pkg = manifest(root)
  if (
    JSON.stringify(packageContract(pkg)) !== JSON.stringify(provenance.package)
  ) {
    refuse('package export or dependency contract changed')
  }
  const paths = packageFiles(root, pkg)
  // Before the digest comparison, so a dev build is named as one
  verifyProductionJsx(root, paths)
  const actual = fileDigest(root, paths)
  if (JSON.stringify(actual) !== JSON.stringify(provenance.content)) {
    const changed = [
      ...new Set([...paths, ...Object.keys(provenance.content.files)])
    ].filter(path => actual.files[path] !== provenance.content.files[path])
    refuse(`package content changed: ${changed.join(', ')}`)
  }
  if (
    JSON.stringify(summaries(root, paths)) !== JSON.stringify(provenance.groups)
  ) {
    refuse('source/build/declaration summaries differ')
  }
  if (
    checkBuildInputs &&
    JSON.stringify(inputs(root)) !== JSON.stringify(provenance.buildInputs)
  ) {
    refuse('build inputs changed')
  }
  verifySourceMaps(root, paths)
  verifyExports(root)
  return provenance
}

if (process.argv[1] === import.meta.filename) {
  try {
    const command = process.argv[2]
    if (
      process.argv.length !== 3 ||
      !['clean-types', 'write', 'check'].includes(command)
    ) {
      throw new Error(
        'Usage: node scripts/release/pack-provenance.mjs clean-types|write|check'
      )
    }
    const root = process.cwd()
    if (command === 'clean-types') cleanTypes(root)
    else {
      const result =
        command === 'write'
          ? writeProvenance(root)
          : verifyProvenance(root, { checkBuildInputs: true })
      console.log(
        `[pack] ${command}: ${Object.keys(result.content.files).length} files, ${result.content.sha256}`
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
