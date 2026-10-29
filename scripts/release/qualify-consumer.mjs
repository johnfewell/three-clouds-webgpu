import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { workspaceOverrides } from '../port-gates/lockfile-manifests.mjs'
import { verifyArchive } from './pack-archive.mjs'
import { sha256, verifyProvenance } from './pack-provenance.mjs'

const RECIPES = ['vanilla', 'webgl-fallback', 'r3f']
const ASSETS = [
  'local_weather.png',
  'shape.bin',
  'shape_detail.bin',
  'turbulence.png'
]
const OPTIONAL_PEERS = ['react', 'react-dom', '@react-three/fiber']
// The npm builds of these fail to import on three 0.185, so every recipe pins
// the fork builds through pnpm-workspace.yaml overrides: a release URL, or a
// tarball in the recipe's vendor/ that qualification copies from the repository
const FORK_PACKAGES = ['@takram/three-atmosphere', '@takram/three-geospatial']
const FORK_SPEC = /^(?:https:\/\/\S+|file:\.\/vendor\/[^/]+)\.tgz$/
const VENDORED = /^file:\.\/vendor\/([^/]+\.tgz)$/
const REPOSITORY = resolve(import.meta.dirname, '../..')
// The stock three releases a recipe may qualify on, each with its types. The
// recipes pin the first, and --three writes another into each recipe copy
const THREE_RELEASES = { '0.185.1': '0.185.0', '0.186.1': '0.186.0' }
const DEFAULT_THREE = '0.185.1'

export function selectThree(version = DEFAULT_THREE) {
  insist(
    Object.hasOwn(THREE_RELEASES, version),
    `Qualification supports stock three ${Object.keys(THREE_RELEASES).join(' or ')}, not ${version}`
  )
  return { version, types: THREE_RELEASES[version] }
}

export function pinRecipeThree(manifest, three) {
  insist(
    manifest.dependencies?.three != null &&
      manifest.devDependencies?.['@types/three'] != null,
    'Recipe must pin three and @types/three'
  )
  return {
    ...manifest,
    dependencies: { ...manifest.dependencies, three: three.version },
    devDependencies: {
      ...manifest.devDependencies,
      '@types/three': three.types
    }
  }
}

function insist(condition, message) {
  if (!condition) throw new Error(message)
}

function inside(root, path) {
  const local = relative(root, path)
  return (
    local !== '' &&
    !isAbsolute(local) &&
    local !== '..' &&
    !local.startsWith(`..${sep}`)
  )
}

function assertStandaloneLocation(root) {
  for (let directory = dirname(root); ; directory = dirname(directory)) {
    for (const marker of ['node_modules', 'pnpm-workspace.yaml']) {
      insist(
        !existsSync(join(directory, marker)),
        `Consumer fixture inherits a workspace or dependencies: ${directory}`
      )
    }
    if (dirname(directory) === directory) break
  }
}

// Every regular file under root as sorted relative paths, shared with the
// native proof's inventory. refuse(kind, path) must throw, or the walk throws
// itself. An empty root yields [] and each caller decides what that means
export function regularFilesWithin(root, refuse) {
  const stop = (kind, path) => {
    refuse(kind, path)
    throw new Error(`REFUSING: ${kind} in artifact inventory: ${path}`)
  }
  const files = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) stop('symlink', path)
      if (entry.isDirectory()) walk(path)
      else {
        if (!entry.isFile()) stop('special', path)
        files.push(relative(root, path))
      }
    }
  }
  walk(root)
  return files.sort()
}

function filesWithin(root) {
  const files = regularFilesWithin(root, (kind, path) => {
    insist(
      false,
      kind === 'symlink'
        ? `Refusing symlink in artifact: ${path}`
        : `Refusing non-file artifact: ${path}`
    )
  })
  insist(files.length > 0, `Refusing empty artifact: ${root}`)
  return files
}

export function digestFiles(root, paths = filesWithin(root)) {
  insist(paths.length > 0, `Refusing empty digest: ${root}`)
  const files = Object.fromEntries(
    paths.toSorted().map(path => {
      const full = resolve(root, path)
      insist(
        inside(resolve(root), full) &&
          lstatSync(full).isFile() &&
          inside(realpathSync(root), realpathSync(full)),
        `Refusing non-local regular artifact: ${path}`
      )
      const bytes = readFileSync(full)
      return [path, { sha256: sha256(bytes), bytes: bytes.length }]
    })
  )
  return { sha256: sha256(JSON.stringify(files)), files }
}

export function inspectDependencyIsolation(root, withoutReact) {
  const modules = join(realpathSync(root), 'node_modules')
  insist(
    lstatSync(modules).isDirectory(),
    `node_modules must be a real directory: ${modules}`
  )
  const packageNames = new Set()
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        insist(
          inside(modules, realpathSync(path)),
          `Dependency escapes fixture: ${path}`
        )
      } else if (entry.isDirectory()) walk(path)
      else if (entry.name === 'package.json') {
        const manifest = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof manifest.name === 'string') packageNames.add(manifest.name)
      }
    }
  }
  walk(modules)
  insist(packageNames.size > 0, 'No installed package manifests were inspected')
  if (withoutReact) {
    for (const name of OPTIONAL_PEERS) {
      insist(
        !packageNames.has(name),
        `Vanilla install contains optional peer: ${name}`
      )
      for (const origin of [
        join(root, 'package.json'),
        join(modules, 'three-clouds-webgpu/package.json')
      ]) {
        let found = false
        try {
          createRequire(origin).resolve(name)
          found = true
        } catch (error) {
          if (error.code !== 'MODULE_NOT_FOUND') throw error
        }
        insist(!found, `Vanilla can resolve optional peer: ${name}`)
      }
    }
  }
  return {
    packageNames: [...packageNames].sort(),
    optionalPeersAbsent: withoutReact
  }
}

function commandEnvironment() {
  const environment = { ...process.env }
  delete environment.NODE_PATH
  delete environment.NODE_OPTIONS
  return {
    ...environment,
    pnpm_config_verify_deps_before_run: 'false',
    pnpm_config_auto_install_peers: 'false',
    pnpm_config_enable_global_virtual_store: 'false',
    pnpm_config_virtual_store_dir: 'node_modules/.pnpm'
  }
}

function execute(receipt, cwd, command, args) {
  const evidence = {
    cwd,
    command,
    args,
    exitCode: null,
    stdout: '',
    stderr: ''
  }
  receipt.commands.push(evidence)
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: commandEnvironment(),
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: 'pipe'
  })
  evidence.exitCode = result.status
  evidence.stdout = result.stdout ?? ''
  evidence.stderr = result.stderr ?? result.error?.message ?? ''
  evidence.logSha256 = sha256(evidence.stdout + '\n' + evidence.stderr)
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${evidence.stdout}\n${evidence.stderr}`,
      { cause: result.error }
    )
  }
  return evidence.stdout
}

/** The keys of a pnpm v9 lockfile's `packages:` block, which name what resolved */
function lockedPackageKeys(lockfile) {
  const lines = lockfile.split(/\r?\n/)
  const start = lines.findIndex(line => /^packages:\s*$/.test(line))
  const keys = []
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const key = /^ {2}(?! )'?(.+?)'?:\s*$/.exec(line)?.[1]
    if (key != null) keys.push(key)
  }
  return keys
}

/**
 * Whether each fork package installed as a fork build of its pinned release and
 * the lockfile resolved it through the override. The overrides block is copied
 * into every lockfile verbatim, so only the packages block is evidence
 */
export function checkForkPins(versions, lockfile) {
  const keys = lockedPackageKeys(lockfile)
  for (const name of FORK_PACKAGES) {
    const pin = versions[name]
    insist(
      pin?.override != null,
      `Recipe must declare ${name} and override it with the fork build`
    )
    const [base, build = ''] = pin.version.split('+')
    insist(
      base === pin.requested && /^fork\.\d+$/.test(build),
      `Installed ${name} ${pin.version} is not a fork build of ${pin.requested}`
    )
    const expected = `${name}@${pin.override.replace(/^file:\.\//, 'file:')}`
    const resolved = keys.filter(key => key.startsWith(`${name}@`))
    insist(
      resolved.length === 1 && resolved[0] === expected,
      `Lockfile resolves ${name} to ${resolved.join(', ') || 'nothing'}, ` +
        `not ${expected}`
    )
  }
}

function installedVersions(root, manifest, three) {
  const overrides = workspaceOverrides(root)
  for (const name of FORK_PACKAGES)
    insist(
      FORK_SPEC.test(overrides[name] ?? ''),
      `Recipe must pin the fork build of ${name}`
    )
  const versions = {}
  for (const [name, requested] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies
  })) {
    const packageRoot = realpathSync(join(root, 'node_modules', name))
    insist(
      inside(join(root, 'node_modules'), packageRoot),
      `Package resolves outside fixture: ${name}`
    )
    const installed = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8')
    )
    if (name !== 'three-clouds-webgpu') {
      insist(
        /^\d+\.\d+\.\d+$/.test(requested),
        `Recipe dependency must be pinned: ${name}`
      )
      insist(
        overrides[name] != null || installed.version === requested,
        `Installed version differs for ${name}`
      )
    }
    versions[name] = {
      requested,
      ...(overrides[name] == null ? {} : { override: overrides[name] }),
      version: installed.version,
      root: packageRoot
    }
  }
  insist(
    versions.three.version === three.version &&
      versions['@types/three'].version === three.types,
    `Qualification requires stock three ${three.version} with @types/three ${three.types}`
  )
  const minor = version => version.split('.').slice(0, 2).join('.')
  insist(
    minor(versions['@types/three'].version) === minor(versions.three.version),
    'Three runtime/types mismatch'
  )
  return versions
}

function importProbe(withReact) {
  return `
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
const require = createRequire(import.meta.url)
const imports = {}
for (const specifier of ${JSON.stringify(['three-clouds-webgpu', 'three-clouds-webgpu/webgpu', ...(withReact ? ['three-clouds-webgpu/r3f'] : [])])}) {
  const module = await import(specifier)
  const required = specifier.endsWith('/r3f') ? ['Clouds', 'CloudLayer', 'useClouds'] : ['clouds', 'createCloudsIntegration', 'inspectCloudsSetup']
  for (const name of required) if (typeof module[name] !== 'function') throw new Error(specifier + ' missing ' + name)
  imports[specifier] = { path: realpathSync(require.resolve(specifier)), exports: Object.keys(module).sort() }
}
const assets = Object.fromEntries(${JSON.stringify(ASSETS)}.map(name => [name, realpathSync(require.resolve('three-clouds-webgpu/assets/' + name))]))
console.log(JSON.stringify({ imports, assets }))
`
}

async function fetchBuildAssets(build, assets) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (!pathname.startsWith(build.base)) {
      response.writeHead(404).end()
      return
    }
    const path = resolve(build.root, pathname.slice(build.base.length))
    if (
      !inside(build.root, path) ||
      !lstatSync(path, { throwIfNoEntry: false })?.isFile()
    ) {
      response.writeHead(404).end()
      return
    }
    response.end(readFileSync(path))
  })
  await new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const javascript = Object.keys(build.files.files).filter(path =>
      path.endsWith('.js')
    )
    insist(javascript.length > 0, 'Build emitted no JavaScript')
    const source = javascript
      .map(path => readFileSync(join(build.root, path), 'utf8'))
      .join('\n')
    const fetched = []
    for (const asset of assets) {
      const candidates = Object.entries(build.files.files).filter(
        ([, info]) => info.sha256 === asset.sha256
      )
      insist(
        candidates.length === 1,
        `Expected one emitted payload for ${asset.exportPath}`
      )
      const url = build.base + candidates[0][0]
      insist(
        source.includes(JSON.stringify(url)),
        `Bundle does not reference asset URL: ${url}`
      )
      const response = await fetch(origin + url)
      const bytes = Buffer.from(await response.arrayBuffer())
      insist(
        response.ok && sha256(bytes) === asset.sha256,
        `HTTP payload differs: ${url}`
      )
      fetched.push({ ...asset, url, status: response.status })
    }
    return fetched
  } finally {
    server.closeAllConnections()
    await new Promise(resolveClosed => server.close(resolveClosed))
  }
}

async function qualifyRecipe(receipt, extracted, name) {
  const root = join(receipt.workRoot, name)
  const sourceRoot = join(extracted, 'recipes', name)
  const sources = digestFiles(sourceRoot)
  cpSync(sourceRoot, root, { recursive: true, errorOnExist: true })
  mkdirSync(join(root, 'vendor'))
  copyFileSync(
    receipt.archive.path,
    join(root, 'vendor/three-clouds-webgpu.tgz')
  )
  for (const spec of Object.values(workspaceOverrides(root))) {
    const file = VENDORED.exec(spec)?.[1]
    if (file != null)
      copyFileSync(join(REPOSITORY, 'vendor', file), join(root, 'vendor', file))
  }
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const manifest = pinRecipeThree(source, receipt.three)
  if (JSON.stringify(manifest) !== JSON.stringify(source))
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    )
  // The archive's recipe with the --three pin applied, which nothing may change
  const prepared = digestFiles(root, Object.keys(sources.files))
  const manager = execute(receipt, root, 'pnpm', ['--version']).trim()
  insist(
    manifest.packageManager === `pnpm@${manager}`,
    'Recipe package manager differs from runner'
  )
  execute(receipt, root, 'pnpm', [
    'install',
    '--prefer-offline',
    '--no-frozen-lockfile',
    '--config.package-import-method=copy'
  ])
  const isolation = inspectDependencyIsolation(root, name !== 'r3f')
  const versions = installedVersions(root, manifest, receipt.three)
  const installedRoot = versions['three-clouds-webgpu'].root
  const provenance = verifyProvenance(installedRoot)
  insist(
    provenance.content.sha256 === receipt.archive.contentSha256,
    'Installed content differs from archive'
  )
  const installed = {
    root: installedRoot,
    contentSha256: provenance.content.sha256,
    files: digestFiles(installedRoot, Object.keys(receipt.archive.files.files)),
    build: digestFiles(join(installedRoot, 'build')),
    types: digestFiles(join(installedRoot, 'types'))
  }
  insist(
    installed.files.sha256 === receipt.archive.files.sha256,
    'Installed files differ from archive'
  )
  const runtime = JSON.parse(
    execute(receipt, root, process.execPath, [
      '--input-type=module',
      '-e',
      importProbe(name === 'r3f')
    ])
  )
  for (const entry of Object.values(runtime.imports))
    insist(
      inside(installedRoot, entry.path),
      'Runtime import escaped installed package'
    )
  const assets = ASSETS.map(name => {
    const path = runtime.assets[name]
    insist(
      inside(installedRoot, path),
      `Asset escaped installed package: ${name}`
    )
    const bytes = readFileSync(path)
    insist(bytes.length > 0, `Empty exported asset: ${name}`)
    return {
      exportPath: `three-clouds-webgpu/assets/${name}`,
      sha256: sha256(bytes),
      bytes: bytes.length
    }
  })
  const compilerInputs = execute(receipt, root, 'pnpm', [
    'exec',
    'tsc',
    '--noEmit',
    '--listFilesOnly'
  ])
    .trim()
    .split('\n')
    .map(path => resolve(path.trim()))
  const sourceFiles = Object.keys(sources.files).filter(path =>
    /\.(ts|tsx)$/.test(path)
  )
  insist(sourceFiles.length > 0, 'Recipe has no TypeScript sources')
  for (const path of sourceFiles)
    insist(
      compilerInputs.includes(join(root, path)),
      `Recipe source not compiled: ${path}`
    )
  const builds = []
  for (const [base, directory] of [
    ['/', 'dist'],
    ['/clouds-qualification/', 'dist-nested']
  ]) {
    if (base === '/') execute(receipt, root, 'pnpm', ['build'])
    else
      execute(receipt, root, 'pnpm', [
        'exec',
        'vite',
        'build',
        '--base',
        base,
        '--outDir',
        directory
      ])
    const buildRoot = join(root, directory)
    const build = { base, root: buildRoot, files: digestFiles(buildRoot) }
    builds.push({ ...build, assets: await fetchBuildAssets(build, assets) })
  }
  insist(
    digestFiles(root, Object.keys(sources.files)).sha256 === prepared.sha256,
    'Recipe source/config changed during qualification'
  )
  const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  insist(
    !lockfile.includes('patchedDependencies:'),
    'Qualification must not patch dependencies'
  )
  checkForkPins(versions, lockfile)
  insist(
    verifyProvenance(installedRoot).content.sha256 === installed.contentSha256,
    'Installed content changed during qualification'
  )
  insist(
    digestFiles(installedRoot, Object.keys(installed.files.files)).sha256 ===
      installed.files.sha256,
    'Installed archive files changed during qualification'
  )
  for (const [directory, before] of [
    ['build', installed.build],
    ['types', installed.types]
  ]) {
    insist(
      digestFiles(join(installedRoot, directory)).sha256 === before.sha256,
      `Installed ${directory} changed during qualification`
    )
  }
  inspectDependencyIsolation(root, name !== 'r3f')
  return {
    name,
    root,
    sources,
    prepared,
    installed,
    versions,
    isolation,
    runtime,
    compilerInputs,
    compilerOptions: JSON.parse(
      readFileSync(join(root, 'tsconfig.json'), 'utf8')
    ).compilerOptions,
    lockfileSha256: sha256(lockfile),
    builds
  }
}

export async function qualifyConsumerArchive(tarball, options = {}) {
  insist(
    process.versions.node.split('.')[0] === '24',
    'Consumer qualification requires Node 24'
  )
  const three = selectThree(options.three)
  const archive = resolve(tarball)
  const workRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'clouds-consumer-qualification-'))
  )
  const receiptPath = resolve(
    options.receiptPath ?? 'test-results/consumer-qualification.json'
  )
  const receipt = {
    schemaVersion: 1,
    qualification: 'cpu-only',
    status: 'running',
    graph: 'unobserved',
    frame: 'unobserved',
    node: process.version,
    runnerSha256: sha256(readFileSync(import.meta.filename)),
    platform: process.platform,
    arch: process.arch,
    three,
    workRoot,
    retained: options.keepProjects === true,
    commands: [],
    recipes: []
  }
  try {
    assertStandaloneLocation(workRoot)
    const snapshot = join(workRoot, 'three-clouds-webgpu.tgz')
    copyFileSync(archive, snapshot)
    const verified = verifyArchive(snapshot)
    receipt.archive = {
      path: snapshot,
      originalPath: archive,
      sha256: verified.archiveSha256,
      contentSha256: verified.contentSha256,
      bytes: readFileSync(snapshot).length
    }
    receipt.navigation = verified.navigation
    const extracted = join(workRoot, 'extracted')
    mkdirSync(extracted)
    execute(receipt, workRoot, 'tar', ['-xzf', snapshot, '-C', extracted])
    receipt.archive.files = digestFiles(join(extracted, 'package'))
    for (const name of RECIPES)
      receipt.recipes.push(
        await qualifyRecipe(receipt, join(extracted, 'package'), name)
      )
    insist(
      receipt.recipes.length === RECIPES.length,
      'Incomplete recipe qualification'
    )
    insist(
      sha256(readFileSync(snapshot)) === receipt.archive.sha256,
      'Archive changed during qualification'
    )
    receipt.status = 'passed'
    return receipt
  } catch (error) {
    receipt.status = 'failed'
    receipt.error = error.message
    throw error
  } finally {
    mkdirSync(dirname(receiptPath), { recursive: true })
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    if (!receipt.retained) rmSync(workRoot, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2)
  const options = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--keep-projects') options.keepProjects = true
    else if (
      args[index] === '--receipt' &&
      args[index + 1] &&
      !args[index + 1].startsWith('-')
    )
      options.receiptPath = args[++index]
    else if (
      args[index] === '--three' &&
      args[index + 1] &&
      !args[index + 1].startsWith('-')
    )
      options.three = args[++index]
    else positional.push(args[index])
  }
  if (positional.length !== 1 || positional[0].startsWith('-')) {
    console.error(
      'Usage: pnpm pack:qualify archive.tgz [--three 0.185.1|0.186.1] [--receipt path.json] [--keep-projects]'
    )
    process.exitCode = 1
  } else {
    try {
      const receipt = await qualifyConsumerArchive(positional[0], options)
      console.log(
        JSON.stringify({
          status: receipt.status,
          qualification: receipt.qualification,
          three: receipt.three,
          archiveSha256: receipt.archive.sha256,
          workRoot: receipt.workRoot,
          retained: receipt.retained
        })
      )
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
