import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { sha256 as hash } from '../../../../scripts/release/pack-provenance.mjs'
import {
  pinRecipeThree,
  regularFilesWithin
} from '../../../../scripts/release/qualify-consumer.mjs'

export function insist(condition, message) {
  if (!condition) throw new Error(`Consumer native: ${message}`)
}

export { sha256 as hash } from '../../../../scripts/release/pack-provenance.mjs'

export function contained(root, path) {
  const local = relative(realpathSync(root), realpathSync(path))
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

function inventory(root) {
  return regularFilesWithin(root, (kind, path) => {
    insist(
      false,
      kind === 'symlink'
        ? `artifact contains a symlink: ${path}`
        : `artifact contains a special file: ${path}`
    )
  })
}

export function verifyFiles(root, digest, complete = false) {
  insist(digest?.files != null, `missing file manifest: ${root}`)
  const names = Object.keys(digest.files).sort()
  insist(names.length > 0, `zero files: ${root}`)
  if (complete)
    insist(
      JSON.stringify(inventory(root)) === JSON.stringify(names),
      `file inventory changed: ${root}`
    )
  const files = Object.fromEntries(
    names.map(name => {
      insist(
        !isAbsolute(name) && !name.split(/[\\/]/).includes('..'),
        `unsafe manifest path: ${name}`
      )
      const path = resolve(root, name)
      insist(contained(root, path), `file escapes artifact: ${name}`)
      insist(lstatSync(path).isFile(), `not a regular artifact file: ${name}`)
      const bytes = readFileSync(path)
      const actual = { sha256: hash(bytes), bytes: bytes.length }
      const expected = digest.files[name]
      insist(
        actual.sha256 === expected.sha256 && actual.bytes === expected.bytes,
        `changed file: ${path}`
      )
      return [name, actual]
    })
  )
  insist(hash(JSON.stringify(files)) === digest.sha256, `bad manifest: ${root}`)
  return digest.sha256
}

export function verifyPreparedRecipe(recipe, three) {
  insist(recipe.prepared?.files != null, 'missing prepared recipe inventory')
  const sourceNames = Object.keys(recipe.sources.files).sort()
  insist(
    JSON.stringify(sourceNames) ===
      JSON.stringify(Object.keys(recipe.prepared.files).sort()),
    'prepared recipe inventory differs from archive source inventory'
  )
  const original = readFileSync(
    join(recipe.installed.root, 'recipes', recipe.name, 'package.json'),
    'utf8'
  )
  const manifest = JSON.parse(original)
  const pinned = pinRecipeThree(manifest, three)
  const expected =
    JSON.stringify(manifest) === JSON.stringify(pinned)
      ? original
      : JSON.stringify(pinned, null, 2) + '\n'
  for (const name of sourceNames) {
    const prepared = recipe.prepared.files[name]
    const source = recipe.sources.files[name]
    const expectedHash =
      name === 'package.json' ? hash(expected) : source.sha256
    const expectedBytes =
      name === 'package.json' ? Buffer.byteLength(expected) : source.bytes
    insist(
      prepared.sha256 === expectedHash && prepared.bytes === expectedBytes,
      `prepared source differs beyond the allowed Three pin: ${name}`
    )
  }
  verifyFiles(recipe.root, recipe.prepared)
}

function verifyRecipe(recipe, archive, three) {
  insist(RECIPES.includes(recipe.name), 'unknown recipe')
  insist(
    lstatSync(join(recipe.root, 'node_modules')).isDirectory(),
    'consumer node_modules must be a real install'
  )
  const resolved = realpathSync(
    join(recipe.root, 'node_modules/three-clouds-webgpu')
  )
  insist(resolved === recipe.installed.root, 'installed package root changed')
  insist(
    contained(join(recipe.root, 'node_modules'), resolved),
    'installed package escapes consumer'
  )
  verifyFiles(resolved, recipe.installed.files, true)
  insist(
    recipe.installed.contentSha256 === archive.contentSha256,
    'installed provenance differs from archive'
  )
  verifyFiles(join(resolved, 'build'), recipe.installed.build, true)
  verifyFiles(join(resolved, 'types'), recipe.installed.types, true)
  insist(
    recipe.installed.files.sha256 === archive.files.sha256,
    'installed package differs from archive'
  )
  for (const [name, source] of Object.entries(recipe.sources.files)) {
    insist(
      archive.files.files[`recipes/${recipe.name}/${name}`]?.sha256 ===
        source.sha256,
      `recipe source differs from archive: ${name}`
    )
  }
  verifyPreparedRecipe(recipe, three)
  insist(
    hash(readFileSync(join(recipe.root, 'pnpm-lock.yaml'))) ===
      recipe.lockfileSha256,
    'consumer lockfile changed'
  )
  insist(recipe.builds.length === 2, 'expected root and nested builds')
  insist(
    recipe.builds.some(build => build.base === '/'),
    'missing root build'
  )
  insist(
    recipe.builds.some(build => build.base !== '/'),
    'missing nested build'
  )
  for (const build of recipe.builds) {
    insist(/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(build.base), 'invalid build base')
    insist(contained(recipe.root, build.root), 'build escapes consumer')
    verifyFiles(build.root, build.files, true)
    insist(build.assets.length === 4, 'expected four emitted cloud assets')
    insist(
      new Set(build.assets.map(asset => asset.exportPath)).size === 4,
      'duplicate cloud assets'
    )
    for (const asset of build.assets) {
      const path = asset.url.slice(build.base.length)
      insist(asset.url.startsWith(build.base), 'asset escapes base')
      insist(
        build.files.files[path]?.sha256 === asset.sha256 &&
          build.files.files[path]?.bytes === asset.bytes,
        'asset differs from build manifest'
      )
      const archived =
        archive.files.files[
          asset.exportPath.replace(/^three-clouds-webgpu\//, '')
        ]
      insist(
        archived?.sha256 === asset.sha256 && archived.bytes === asset.bytes,
        'emitted asset differs from archive'
      )
    }
  }
  const html = readFileSync(join(recipe.root, 'index.html'), 'utf8')
  insist(html.includes('id="clouds-toggle"'), 'archive lacks cloud toggle UI')
}

// The recipes a CPU receipt may carry. The hardware matrix below covers the
// first two. The WebGL fallback recipe is qualified on the CPU here and proven
// on hardware by its own evidence, so it may be present but adds no scenario
const RECIPES = ['vanilla', 'r3f', 'webgl-fallback']
const HARDWARE_RECIPES = ['vanilla', 'r3f']

export function verifyRecipeNames(recipes) {
  const names = (recipes ?? []).map(recipe => recipe?.name)
  insist(new Set(names).size === names.length, 'duplicate recipe')
  insist(
    HARDWARE_RECIPES.every(name => names.includes(name)) &&
      names.every(name => RECIPES.includes(name)),
    'expected the vanilla and r3f recipes, with at most the webgl-fallback recipe beside them'
  )
  return names
}

export function verifyReceipt(receipt) {
  insist(receipt?.status === 'passed', 'CPU qualification did not pass')
  insist(receipt.qualification === 'cpu-only', 'not a CPU qualifier receipt')
  insist(receipt.retained === true, 'consumer projects were not retained')
  insist(
    typeof receipt.three?.version === 'string' &&
      typeof receipt.three?.types === 'string',
    'missing or invalid Three version metadata in CPU receipt'
  )
  insist(receipt.archive?.files?.files != null, 'missing archive inventory')
  const bytes = readFileSync(receipt.archive.path)
  insist(hash(bytes) === receipt.archive.sha256, 'archive digest changed')
  insist(bytes.length === receipt.archive.bytes, 'archive size changed')
  verifyRecipeNames(receipt.recipes)
  for (const recipe of receipt.recipes)
    verifyRecipe(recipe, receipt.archive, receipt.three)
  return scenarios(receipt)
}

export function scenarios(receipt) {
  const cases = receipt.recipes
    .filter(recipe => HARDWARE_RECIPES.includes(recipe.name))
    .flatMap(recipe =>
      recipe.builds.flatMap(build =>
        (recipe.name === 'vanilla' ? ['helper', 'manual'] : ['r3f']).map(
          mode => ({
            id: `${mode}-${build.base === '/' ? 'root' : 'nested'}`,
            recipe,
            build,
            mode,
            development: false
          })
        )
      )
    )
  const recipe = receipt.recipes.find(recipe => recipe.name === 'r3f')
  cases.push({
    id: 'r3f-development-strictmode',
    recipe,
    build: recipe.builds.find(build => build.base === '/'),
    mode: 'r3f',
    development: true
  })
  insist(cases.length === 7, 'expected seven native scenarios')
  return cases
}

export function assertHardware(events) {
  const devices = events.filter(event => event.type === 'device')
  insist(devices.length === 1, 'expected one observed application GPU device')
  const device = devices[0]
  const identity = [device.vendor, device.architecture, device.description]
    .filter(Boolean)
    .join(' ')
  insist(identity.length > 0, 'GPU identity is unavailable')
  insist(
    device.fallback !== true &&
      !/swiftshader|llvmpipe|lavapipe|software|\bgoogle\b/i.test(identity),
    `software/fallback GPU refused: ${identity}`
  )
  insist(
    /apple|nvidia|amd|intel|qualcomm|\barm\b|mali|adreno|radeon|geforce|0x(?:1002|10de|8086|106b|5143|13b5)/i.test(
      identity
    ),
    `unrecognized hardware identity: ${identity}`
  )
  insist(
    events.some(event => event.type === 'canvas' && event.device === device.id),
    'observed device was not configured on the application canvas'
  )
  insist(
    !events.some(event => event.type === 'gpu-error'),
    'uncaptured GPU error'
  )
  return device
}

export function assertDevelopmentReplay(events, responses, assets) {
  const replay = []
  const volumes = assets.filter(asset =>
    /\/shape(?:_detail)?\.bin$/.test(asset.exportPath)
  )
  insist(volumes.length === 2, 'incomplete development replay evidence')
  for (const asset of volumes) {
    const urls = new Set(
      responses
        .filter(
          response =>
            response.sha256 === asset.sha256 && response.bytes === asset.bytes
        )
        .map(response => response.url)
    )
    const starts = events.filter(
      event => event.type === 'fetch-start' && urls.has(event.url)
    )
    const cancelled = starts.find(start =>
      events.some(
        event => event.type === 'fetch-abort' && event.id === start.id
      )
    )
    const completed = starts.find(
      start =>
        start.id > cancelled?.id &&
        events.some(
          event =>
            event.type === 'fetch-settled' &&
            event.id === start.id &&
            event.ok === true
        )
    )
    insist(
      cancelled != null && completed != null,
      `no pre-remount development load cancellation/restart: ${asset.exportPath}`
    )
    const abortIndex = events.findIndex(
      event => event.type === 'fetch-abort' && event.id === cancelled.id
    )
    insist(
      events.indexOf(completed) > abortIndex,
      'replacement load started before cleanup'
    )
    replay.push({
      asset: asset.exportPath,
      cancelled: cancelled.id,
      completed: completed.id,
      url: completed.url
    })
  }
  insist(replay.length === 2, 'incomplete development replay evidence')
  return replay
}
