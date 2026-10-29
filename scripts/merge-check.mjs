#!/usr/bin/env node
// Typechecks the merge of a PR head onto CURRENT origin/main, in a temporary
// worktree it creates and removes. mergeable=MERGEABLE is a statement about
// text, not types. Usage: node scripts/merge-check.mjs <PR#>
// It also parses every changed .mjs/.js: tsc reads no plain script, so an
// unclosed comment block in one passed this gate on a merged PR
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// --no-digest-parity skips the digest gate, for a typecheck-only answer
const digestParity = !process.argv.includes('--no-digest-parity')

/** The extensions `node --check` parses and tsc never reads here */
export const PARSED_EXTENSIONS = ['.mjs', '.cjs', '.js']

/** Whether a changed path is one this gate parses */
export function isPlainScript(file) {
  return PARSED_EXTENSIONS.some(ext => file.endsWith(ext))
}

const stderrOf = err =>
  err instanceof Error && 'stderr' in err && err.stderr
    ? err.stderr.toString()
    : String(err)

/**
 * Plain scripts that differ between two commits, deletions excluded: a removed
 * file cannot be parsed, and a rename is reported under its new path
 *
 * @param {string} root
 * @param {string} base an ancestor of head, typically the recorded origin/main
 * @param {string} head the merge commit in `root`
 * @param {{ exec?: typeof execFileSync }} [deps]
 * @returns {string[]} repo-relative paths, possibly empty
 */
export function changedScripts(root, base, head, deps = {}) {
  const exec = deps.exec ?? execFileSync
  const listing = exec(
    'git',
    ['diff', '--name-only', '--diff-filter=d', base, head],
    { cwd: root, encoding: 'utf8' }
  )
  return listing.split('\n').filter(name => name !== '' && isPlainScript(name))
}

/**
 * Parse each file with `node --check`, which compiles it and reports syntax
 * errors without executing it
 *
 * @param {string} root
 * @param {readonly string[]} files repo-relative paths under root
 * @param {{ exec?: typeof execFileSync }} [deps]
 * @returns {{ checked: number, failures: { file: string, output: string }[] }}
 */
export function parseCheck(root, files, deps = {}) {
  const exec = deps.exec ?? execFileSync
  const failures = []
  for (const file of files) {
    if (!existsSync(join(root, file))) continue
    try {
      exec('node', ['--check', join(root, file)], { cwd: root, stdio: 'pipe' })
    } catch (err) {
      failures.push({ file, output: stderrOf(err) })
    }
  }
  return { checked: files.length, failures }
}

/**
 * Report the parse gate. ZERO changed scripts says so: an empty list is a real
 * answer here, and printing nothing would read as "everything parsed"
 *
 * @param {string} root
 * @param {readonly string[]} files
 * @param {{ exec?: typeof execFileSync }} [deps]
 * @returns {number} 0 when every listed script parses, else 1
 */
export function reportParse(root, files, deps = {}) {
  const { checked, failures } = parseCheck(root, files, deps)
  if (checked === 0) {
    console.log('merge-check: no changed .mjs/.js to parse')
    return 0
  }
  for (const { file, output } of failures) {
    console.error(`merge-check: ${file} does not parse\n${output}`)
  }
  if (failures.length > 0) return 1
  console.log(`merge-check: parsed ${checked} changed script(s)`)
  return 0
}

function check(pr) {
  const run = (cmd, args, cwd) =>
    execFileSync(cmd, args, { stdio: 'inherit', cwd })
  const out = args => execFileSync('git', args, { encoding: 'utf8' }).trim()

  const ref = `refs/merge-check/${pr}`
  const wt = mkdtempSync(join(tmpdir(), `merge-check-${pr}-`))
  let created = false
  let code = 0
  try {
    run('git', [
      'fetch',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
      `+refs/pull/${pr}/head:${ref}`
    ])
    const base = out(['rev-parse', 'origin/main'])
    console.log(
      `merge-check: PR #${pr} ${out(['rev-parse', '--short', ref])} onto origin/main ${out(['rev-parse', '--short', 'origin/main'])}`
    )
    run('git', ['worktree', 'add', '--detach', wt, 'origin/main'])
    created = true
    run('git', ['-C', wt, 'merge', '--no-edit', '--no-ff', ref])
    // Before the expensive install: a syntax error is the cheapest failure
    code = reportParse(wt, changedScripts(wt, base, 'HEAD'))
    if (code !== 0) {
      console.error(
        `merge-check: FAIL — PR #${pr} changed scripts do not parse`
      )
      return 1
    }
    // Its own install: a symlinked node_modules would resolve the library to
    // another checkout and typecheck the wrong bytes
    run('pnpm', ['install', '--frozen-lockfile'], wt)
    run('pnpm', ['typecheck'], wt)
    // typecheck cannot see a pinned main-digest main has moved past,
    // and a PR's own CI ran against its OLD main, so staleness surfaced on main
    // after merge. On the MERGED tree it is true either way
    if (digestParity) {
      run('node', ['scripts/digest-parity.mjs', '--ref', 'origin/main'], wt)
      console.log(
        `merge-check: PASS — PR #${pr} merged onto origin/main typechecks,` +
          ' and its pinned main-digests match that main'
      )
    } else {
      console.log(
        `merge-check: PASS — PR #${pr} merged onto origin/main typechecks`
      )
    }
    return 0
  } catch {
    console.error(`merge-check: FAIL — PR #${pr} merged onto origin/main`)
    return 1
  } finally {
    // Removes only what this run created: its own worktree (or empty temp dir)
    // and its own ref.
    if (created) run('git', ['worktree', 'remove', '--force', wt])
    else rmSync(wt, { recursive: true, force: true })
    try {
      run('git', ['update-ref', '-d', ref])
    } catch {
      console.error(`merge-check: could not delete ${ref}`)
    }
  }
}

if (
  process.argv[1] != null &&
  import.meta.url.endsWith(basename(process.argv[1]))
) {
  const pr = process.argv[2]
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('Usage: node scripts/merge-check.mjs <PR#>')
    process.exit(2)
  }
  process.exit(check(pr))
}
