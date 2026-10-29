// Does every workspace manifest agree with the lockfile about what it depends on?
//
// THE DEFECT THIS EXISTS FOR (the frozen-lockfile drift, 2026-09-03):
// a `pnpm add` run in the SHARED checkout modified pnpm-lock.yaml in the working
// tree; another agent's commit captured that lockfile change honestly, because
// their install saw it; and the package.json that justified it stayed uncommitted
// for seven hours. Main then declared a dependency in the lockfile that no
// manifest asked for, and `pnpm install --frozen-lockfile` — the FIRST STEP of
// three separate CI jobs — failed on every one of them.
//
// WHY THIS IS A PURE PARSE AND NOT AN INSTALL. Nobody saw that defect for seven
// hours because the only thing checking it lived in CI, and CI could not start
// (an Actions budget outage). One outage masked another. A gate that only exists
// in CI is a gate that did not exist that day. So this reads two files and
// compares them: no install, no network, no node_modules, no side effects, a few
// milliseconds — which means it runs in `pnpm test`, on every branch, on every
// agent's machine, whether or not Actions is available.
//
// WHAT IT DOES NOT COVER, stated so nobody cites it for more than it checks: it
// compares SPECIFIERS between manifests and the lockfile. It does not prove the
// lockfile resolves, that the versions exist, or that the store holds them. The
// real `pnpm install --frozen-lockfile` remains the stronger check and stays in
// CI. This is the early detector that is always available, not a replacement.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']

/**
 * Reads the `importers:` block of a pnpm v9 lockfile. This is an
 * indentation-scoped scan of one known-regular section, not a YAML parser — the
 * repo has no YAML dependency and adding one to run a gate would put the gate
 * behind the very lockfile it audits.
 * @returns {Map<string, Map<string, string>>} importer path -> (package -> specifier)
 */
export function parseImporters(lockfileText) {
  const lines = lockfileText.split('\n')
  const importers = new Map()
  let inImporters = false
  let importer = null
  let section = null
  let pkg = null

  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true
      continue
    }
    if (!inImporters) continue
    if (/^\S/.test(line)) break // a new top-level key ends the block
    if (line.trim() === '') continue

    let m = /^ {2}(?! )(.+):\s*$/.exec(line)
    if (m != null) {
      importer = m[1].replace(/^['"]|['"]$/g, '')
      importers.set(importer, new Map())
      section = null
      pkg = null
      continue
    }
    m = /^ {4}(?! )(\S+):\s*$/.exec(line)
    if (m != null) {
      section = SECTIONS.includes(m[1]) ? m[1] : null
      pkg = null
      continue
    }
    if (section == null || importer == null) continue

    m = /^ {6}(?! )(.+):\s*$/.exec(line)
    if (m != null) {
      pkg = m[1].replace(/^['"]|['"]$/g, '')
      continue
    }

    m = /^ {8}specifier:\s*(.+)\s*$/.exec(line)
    if (m != null && pkg != null) {
      importers.get(importer).set(pkg, m[1].trim().replace(/^['"]|['"]$/g, ''))
    }
  }
  return importers
}

/**
 * Reads the top-level `overrides:` block of a pnpm v9 lockfile or of a
 * pnpm-workspace.yaml, which write it the same way.
 * @returns {Map<string, string>} package -> the specifier every importer gets
 */
export function parseOverrides(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^overrides:\s*$/.test(line))
  const out = new Map()
  // A hand-edited pnpm-workspace.yaml may hold comments and blank lines inside
  // the block, so only the next top-level key ends it
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^\S/.test(line)) break
    const m = /^ {2}(?! )(.+?):\s*(.+?)\s*$/.exec(line)
    if (m != null)
      out.set(
        m[1].replace(/^['"]|['"]$/g, ''),
        m[2].replace(/^['"]|['"]$/g, '')
      )
  }
  return out
}

/** The overrides a workspace declares in its pnpm-workspace.yaml */
export function workspaceOverrides(root) {
  return Object.fromEntries(
    parseOverrides(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  )
}

// pnpm copies the workspace overrides into the lockfile when it resolves, so a
// yaml edit without a reinstall leaves them apart and a frozen install fails
function overrideDrift(declared, locked) {
  const failures = []
  for (const name of new Set([...declared.keys(), ...locked.keys()])) {
    if (declared.get(name) !== locked.get(name))
      failures.push(
        `pnpm-workspace.yaml overrides ${name} with ` +
          `${declared.get(name) ?? 'nothing'} but the lockfile records ` +
          `${locked.get(name) ?? 'nothing'} — run pnpm install and commit the lockfile`
      )
  }
  return failures
}

// An override replaces the manifest's specifier in every importer. A `file:`
// override is relative to the workspace root, and pnpm records it relative to
// each importer, so `file:./vendor/x.tgz` is `file:../../vendor/x.tgz` there
function matchesOverride(dir, override, lockedSpec) {
  if (override === lockedSpec) return true
  if (!override.startsWith('file:') || !lockedSpec.startsWith('file:'))
    return false
  return (
    normalize(override.slice(5)) === normalize(join(dir, lockedSpec.slice(5)))
  )
}

/** Every dependency specifier a manifest declares, across all three sections. */
export function manifestSpecifiers(pkgJson) {
  const out = new Map()
  for (const s of SECTIONS) {
    for (const [name, spec] of Object.entries(pkgJson[s] ?? {}))
      out.set(name, String(spec))
  }
  return out
}

/** Workspace package.json paths, discovered rather than configured. */
export function workspaceManifests(root) {
  const found = ['.']
  const examples = join(root, 'examples')
  if (existsSync(examples)) {
    for (const entry of readdirSync(examples, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(join(examples, entry.name, 'package.json'))
      ) {
        found.push(`examples/${entry.name}`)
      }
    }
  }
  // Literal entries of pnpm-workspace.yaml too, such as the private core/
  // package. Globs other than examples/* are not expanded
  const workspace = join(root, 'pnpm-workspace.yaml')
  if (existsSync(workspace)) {
    for (const match of readFileSync(workspace, 'utf8').matchAll(
      /^ {2}- ['"]?([^'"*\n]+?)['"]?\s*$/gm
    )) {
      const dir = match[1]
      if (
        dir !== '.' &&
        !found.includes(dir) &&
        existsSync(join(root, dir, 'package.json'))
      ) {
        found.push(dir)
      }
    }
  }
  return found
}

/** @returns {{ok: boolean, failures: string[]}} */
export function checkLockfileManifests(root = process.cwd()) {
  const failures = []
  const lockPath = join(root, 'pnpm-lock.yaml')
  if (!existsSync(lockPath))
    return { ok: false, failures: ['pnpm-lock.yaml is missing'] }

  const lockfileText = readFileSync(lockPath, 'utf8')
  const importers = parseImporters(lockfileText)
  const overrides = parseOverrides(lockfileText)
  const workspace = join(root, 'pnpm-workspace.yaml')
  failures.push(
    ...overrideDrift(
      existsSync(workspace)
        ? parseOverrides(readFileSync(workspace, 'utf8'))
        : new Map(),
      overrides
    )
  )
  if (importers.size === 0) {
    // the drift found above stays reported alongside
    return {
      ok: false,
      failures: [
        ...failures,
        'no importers parsed from pnpm-lock.yaml — the lockfile format changed and this gate is now blind; fix the parser rather than deleting the gate'
      ]
    }
  }

  const manifests = workspaceManifests(root)
  for (const dir of manifests) {
    const manifestPath =
      dir === '.' ? join(root, 'package.json') : join(root, dir, 'package.json')
    const declared = manifestSpecifiers(
      JSON.parse(readFileSync(manifestPath, 'utf8'))
    )
    const locked = importers.get(dir)
    if (locked == null) {
      failures.push(
        `${dir}/package.json has no importer in pnpm-lock.yaml — run pnpm install and commit the lockfile with it`
      )
      continue
    }
    for (const [name, spec] of declared) {
      if (!locked.has(name)) {
        failures.push(
          `${dir} declares ${name}@${spec} but the lockfile has no such entry — the lockfile is behind the manifest`
        )
      } else if (
        overrides.has(name)
          ? !matchesOverride(dir, overrides.get(name), locked.get(name))
          : locked.get(name) !== spec
      ) {
        failures.push(
          `${dir} declares ${name}@${spec} but the lockfile records ${locked.get(name)}`
        )
      }
    }
    for (const [name, spec] of locked) {
      if (!declared.has(name)) {
        failures.push(
          `the lockfile records ${name}@${spec} for ${dir} but ${dir}/package.json does not declare it — this is the frozen-lockfile drift shape, and pnpm install --frozen-lockfile will fail`
        )
      }
    }
  }
  for (const dir of importers.keys()) {
    if (!manifests.includes(dir)) {
      failures.push(
        `the lockfile has an importer for ${dir} but no such workspace manifest exists`
      )
    }
  }
  return { ok: failures.length === 0, failures }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, failures } = checkLockfileManifests()
  for (const f of failures) console.log(`[lockfile-manifests] ${f}`)
  console.log(
    ok
      ? '[lockfile-manifests] OK'
      : `[lockfile-manifests] FAIL — ${failures.length} problem(s)`
  )
  if (!ok) process.exit(1)
}
