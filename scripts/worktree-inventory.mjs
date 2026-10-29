// A READ-ONLY census of this repo's registered worktrees
//
// 42 trees once accumulated as borrow targets and were not pruned, because
// they may hold uncopied evidence. Right instinct, wrong place to stop: the
// hazard is INVISIBILITY. So this REPORTS what a removal would cost and never
// says a tree is safe to delete. It removes nothing, and no code path writes.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** Days after which a HEAD is called out as possibly abandoned */
export const STALE_DAYS = 7

/**
 * @param {string} root
 * @param {{ cwd?: string }} [deps]
 * @returns {string}
 */
function git(root, args, deps) {
  return execFileSync('git', args, {
    cwd: deps?.cwd ?? root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/**
 * Parse `git worktree list --porcelain` into records.
 *
 * Porcelain, not the default table: the default TRUNCATES long paths with
 * `...`, and a truncated path is a path nobody can remove by hand. It also
 * collapses the fields we need into one aligned line, which is why the
 * porcelain block is parsed key by key.
 *
 * `prunable` is a bare key with no value, recorded as its own boolean rather
 * than a string, since `prunable` and `prunable <why>` both occur
 *
 * @param {string} text output of `git worktree list --porcelain`
 * @returns {Array<{ path: string, head: string | null, branch: string | null, detached: boolean, prunable: boolean }>}
 */
export function parseWorktreeList(text) {
  const out = []
  let cur = null
  const flush = () => {
    if (cur != null && cur.path !== '') out.push(cur)
    cur = null
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush()
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const value = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      flush()
      cur = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        prunable: false
      }
      continue
    }
    if (cur == null) continue
    if (key === 'HEAD') cur.head = value
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') cur.detached = true
    else if (key === 'prunable') cur.prunable = true
  }
  flush()
  return out
}

/**
 * Does a porcelain status entry name this worktree?
 *
 * TWO differences, and both had to be fixed for the count to be right:
 * the path is RELATIVE to the tree being asked (`?? tree-0/`, not the absolute
 * path git's worktree list prints), and an untracked DIRECTORY carries a
 * trailing slash. A plain compare missed every worktree on both counts and left
 * main's dirt total equal to the number of worktrees.
 *
 * @param {string} statusPath the path column of a porcelain status line
 * @param {string} treeRoot the tree the status was read in
 * @param {string} worktreePath an absolute registered worktree path
 * @returns {boolean}
 */
function namesWorktree(statusPath, treeRoot, worktreePath) {
  const trim = p => resolve(treeRoot, p).replace(/\/$/, '')
  return trim(statusPath) === trim(worktreePath)
}

/**
 * Days since a commit, or null when git cannot say (an unreachable or absent
 * object reads as unknown, never as "recent").
 *
 * @param {string} root
 * @param {string | null} sha
 * @param {{ cwd?: string }} [deps]
 * @returns {number | null}
 */
export function ageInDays(root, sha, deps) {
  if (sha == null || sha === '') return null
  try {
    const out = git(root, ['log', '-1', '--format=%ct', sha], deps).trim()
    if (out === '') return null
    const secs = Number(out)
    if (!Number.isFinite(secs)) return null
    return Math.floor((Date.now() / 1000 - secs) / 86400)
  } catch {
    return null
  }
}

/**
 * Is this tree's HEAD reachable from `base`? True means every commit in it is
 * already on the base branch, so a removal loses no commit.
 *
 * @param {string} root
 * @param {string | null} head
 * @param {string} base
 * @param {{ cwd?: string }} [deps]
 * @returns {boolean | null} null when undecidable, which is NOT a yes
 */
export function isMergedInto(root, head, base, deps) {
  if (head == null || head === '') return null
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, base], {
      cwd: deps?.cwd ?? root,
      stdio: 'ignore'
    })
    return true
  } catch (err) {
    // Exit 1 is a clean "not an ancestor". Anything else (missing object, no
    // git) is undecidable and must not read as merged
    return err?.status === 1 ? false : null
  }
}

/**
 * The ref a tree is graded against: `origin/main`, not the local branch, which
 * trails it by whatever landed since that agent's fetch. Grading
 * against local main flagged 7 of 23 live trees NOT on base that were merged.
 * Falls back to `main` when no remote ref exists
 *
 * @param {string} root
 * @param {{ cwd?: string }} [deps]
 * @returns {string}
 */
export function defaultBase(root, deps) {
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: deps?.cwd ?? root,
        stdio: 'ignore'
      })
      return ref
    } catch {
      // try the next
    }
  }
  return 'main'
}

/**
 * The census. Read-only by construction: every git call below is a query.
 *
 * @param {string} root repo root
 * @param {{ base?: string, deps?: { cwd?: string } }} [options]
 * @returns {Array<object>}
 */
export function inventory(root, options = {}) {
  const deps = options.deps
  const base = options.base ?? defaultBase(root, deps)
  const listed = parseWorktreeList(
    git(root, ['worktree', 'list', '--porcelain'], deps)
  )
  return listed.map(wt => {
    const exists = existsSync(wt.path)
    // A gone directory is PRUNABLE, not an error, so no query runs for it
    // Registered worktrees are subtracted from the dirt count too, since they
    // live INSIDE main and `git status` counts each as untracked
    const others = listed.map(o => o.path).filter(p => p !== wt.path)
    const dirty = exists
      ? Number(
          git(root, ['status', '--porcelain'], { ...deps, cwd: wt.path })
            .split('\n')
            .filter(l => l.length > 0)
            .filter(
              l => !others.some(p => namesWorktree(l.slice(3), wt.path, p))
            ).length || 0
        )
      : null
    return {
      path: wt.path,
      name: basename(wt.path),
      head: wt.head,
      branch: wt.branch,
      detached: wt.detached,
      prunable: wt.prunable || !exists,
      dirty,
      ageDays: ageInDays(root, wt.head, deps),
      mergedIntoBase: isMergedInto(root, wt.head, base, deps)
    }
  })
}

/**
 * Render the census. Reports what a removal would COST, and never says a tree
 * is safe to delete: `merged` and `clean` together are a strong hint, and the
 * untracked parity output that motivates the whole exercise is invisible to
 * both.
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
export function renderInventory(rows, base = 'the base ref') {
  const lines = []
  // An empty census must SAY SO. A silent empty table reads as "nothing to
  // report", which is the reading that let 42 trees accumulate unnoticed
  if (rows.length === 0) {
    return (
      'worktree inventory is EMPTY — git reported no worktrees, so this\n' +
      'report says nothing about the state of any tree'
    )
  }
  for (const r of rows) {
    const flags = []
    if (r.prunable) flags.push('PRUNABLE')
    if (r.dirty > 0) flags.push(`dirty ${r.dirty}`)
    if (r.mergedIntoBase === false) flags.push('NOT on base')
    if (r.mergedIntoBase === null) flags.push('lineage unknown')
    if (r.ageDays != null && r.ageDays >= STALE_DAYS) {
      flags.push(`HEAD ${r.ageDays}d old`)
    }
    lines.push(
      `${r.name}\n  ${r.path}\n` +
        `  ${r.branch ?? (r.detached ? 'detached' : 'no branch')} @ ` +
        `${r.head?.slice(0, 7) ?? 'no-head'}` +
        (r.ageDays == null ? ', age unknown' : `, ${r.ageDays}d`) +
        (flags.length > 0
          ? `\n  ${flags.join(' | ')}`
          : '\n  nothing outstanding') +
        '\n'
    )
  }
  const flagged = rows.filter(
    r =>
      r.prunable ||
      r.dirty > 0 ||
      r.mergedIntoBase !== true ||
      (r.ageDays != null && r.ageDays >= STALE_DAYS)
  ).length
  lines.push(
    `${rows.length} worktree(s), ${flagged} with something outstanding\n` +
      `graded against ${base}\n` +
      'This report is READ-ONLY. Nothing was removed. Before removing any tree,\n' +
      'confirm its parity output and receipts were copied OUT of it: both are\n' +
      'untracked, so neither `git` nor this census can see whether they exist\n' +
      '.'
  )
  return lines.join('\n')
}

/**
 * @param {string} root
 * @param {{ base?: string }} [options]
 * @returns {number} process exit code
 */
export function run(root, options = {}) {
  let rows
  try {
    rows = inventory(root, options)
  } catch (err) {
    console.error(
      `[inventory] could not read the worktree list: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return 2
  }
  console.log(renderInventory(rows, options.base ?? defaultBase(root)))
  return 0
}

if (
  process.argv[1] != null &&
  import.meta.url.endsWith(basename(process.argv[1]))
) {
  const baseArg = process.argv.indexOf('--base')
  // A valueless --base would otherwise fall through to the default and grade
  // the whole fleet against a ref the caller did not ask for, silently
  const base = baseArg === -1 ? undefined : (process.argv[baseArg + 1] ?? null)
  if (base === null) {
    console.error('usage: worktree-inventory.mjs [--base <ref>]')
    process.exit(2)
  }
  process.exit(run(process.cwd(), base == null ? {} : { base }))
}
