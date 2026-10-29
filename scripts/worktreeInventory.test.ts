// the read-only worktree census. Two properties carry the weight and
// both are red-proved by mutation rather than by assertion: it REPORTS and
// never removes, and an EMPTY census says so instead of reading as "no trees
// are in trouble"

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ageInDays,
  defaultBase,
  inventory,
  isMergedInto,
  parseWorktreeList,
  renderInventory,
  run,
  STALE_DAYS
} from '../scripts/worktree-inventory.mjs'

const SCRIPT = join(__dirname, 'worktree-inventory.mjs')
const REPO = join(__dirname, '..')

/** A real repo with `count` linked worktrees, so git can answer for real */
function repoWithWorktrees(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-inventory-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'inventory test')
  writeFileSync(join(root, 'README.md'), 'x')
  git('add', '-A')
  git('commit', '-qm', 'init')
  for (let i = 0; i < count; i++) {
    const wt = join(root, `tree-${i}`)
    git('worktree', 'add', '-q', wt, '-b', `bead/t${i}`)
    // `worktree add` checks the branch out AT main's commit, so every tree
    // starts merged and the "NOT on base" arm would be unreachable. Give each
    // one a commit of its own
    writeFileSync(join(wt, `own-${i}.ts`), `export const a = ${i}\n`)
    git('-C', wt, 'add', '-A')
    git(
      '-C',
      wt,
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      `own work ${i}`
    )
  }
  return root
}

describe('parseWorktreeList reads porcelain, not the truncated table', () => {
  it('parses path, HEAD, branch and detached', () => {
    const rows = parseWorktreeList(
      [
        'worktree /a/main',
        'HEAD aaaa',
        'branch refs/heads/main',
        '',
        'worktree /a/wt',
        'HEAD bbbb',
        'detached',
        ''
      ].join('\n')
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      path: '/a/main',
      head: 'aaaa',
      branch: 'main',
      detached: false,
      prunable: false
    })
    // A detached tree has NO branch line at all, so branch must be null rather
    // than undefined or ''
    expect(rows[1]).toMatchObject({ branch: null, detached: true })
  })

  // `prunable` appears both bare and with a reason, and a parser that reads
  // only the valued form reports a vanished tree as healthy
  it('records a BARE prunable key, and one carrying a reason', () => {
    const rows = parseWorktreeList(
      [
        'worktree /a/gone',
        'HEAD cccc',
        'prunable gitdir file points to non-existent location',
        '',
        'worktree /a/also-gone',
        'HEAD dddd',
        'prunable',
        ''
      ].join('\n')
    )
    // Asserted present, not indexed blindly: under noUncheckedIndexedAccess an
    // index yields T | undefined, and `.prunable` on that is a compile error
    // rather than the failure this test is about
    const [first, second] = rows
    expect(first?.prunable).toBe(true)
    expect(second?.prunable).toBe(true)
  })

  it('keeps a FULL path, which the default table truncates', () => {
    const long = `/a/${'deeply-nested-directory-name/'.repeat(8)}tree`
    const rows = parseWorktreeList(`worktree ${long}\nHEAD eeee\n`)
    // A truncated path is a path nobody can act on, which is the defect the
    // porcelain format is chosen to avoid
    expect(rows[0]?.path).toBe(long)
    expect(rows[0]?.path).not.toContain('...')
  })

  // Every instance of this class in this project has been a measurement over
  // zero inputs reading as a result
  it('an EMPTY input yields an empty list, and the renderer says so', () => {
    expect(parseWorktreeList('')).toEqual([])
    const text = renderInventory([])
    expect(text).toContain('EMPTY')
    // Silence would read as "no trees are in trouble"
    expect(text).toMatch(/says nothing about the state of any tree/)
  })
})

describe('lineage and age read as UNKNOWN rather than as yes/ recent', () => {
  it('isMergedInto is true only when git says so', () => {
    const root = repoWithWorktrees(1)
    try {
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'main'], {
        encoding: 'utf8'
      }).trim()
      expect(isMergedInto(root, head, 'main')).toBe(true)
      // A HEAD that is not on main is a clean no, not an unknown
      const wtHead = execFileSync('git', ['-C', root, 'rev-parse', 'bead/t0'], {
        encoding: 'utf8'
      }).trim()
      expect(isMergedInto(root, wtHead, 'main')).toBe(false)
      // Absent SHA cannot be placed in any lineage
      expect(isMergedInto(root, null, 'main')).toBeNull()
      expect(isMergedInto(root, '', 'main')).toBeNull()
      // An object git cannot resolve is UNDECIDABLE, and exit 1 is the only
      // shape allowed to mean "no"
      expect(isMergedInto(root, 'f'.repeat(40), 'main')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ageInDays is null when there is no date to read', () => {
    const root = repoWithWorktrees(0)
    try {
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8'
      }).trim()
      const age = ageInDays(root, head)
      expect(age).not.toBeNull()
      expect(age).toBeGreaterThanOrEqual(0)
      expect(ageInDays(root, null)).toBeNull()
      expect(ageInDays(root, '')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Finding 2 (oc_12): the shipped default was the LOCAL main, which trails
// origin/main, so 7 of 23 live trees were falsely flagged NOT on base. It
// over-reports, so it is a usefulness defect and not a safety one
describe('the census is graded against origin/main, not a stale local ref', () => {
  it('prefers origin/main, and falls back when there is no remote', () => {
    const root = repoWithWorktrees(0)
    try {
      // A bare fixture repo has no remote ref at all
      expect(defaultBase(root)).toBe('main')
      // Give it one that is AHEAD of the local branch, as origin/main is
      execFileSync(
        'git',
        ['-C', root, 'update-ref', 'refs/remotes/origin/main', 'HEAD'],
        {
          stdio: 'pipe'
        }
      )
      expect(defaultBase(root)).toBe('origin/main')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a tree merged into origin/main but not into local main reads as on base', () => {
    const root = repoWithWorktrees(0)
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', root, ...args], {
          encoding: 'utf8',
          stdio: 'pipe'
        })
      // The fleet shape: main is behind, origin/main has the merge
      const tip = git('rev-parse', 'HEAD').trim()
      git('update-ref', 'refs/remotes/origin/main', tip)
      git('worktree', 'add', '-q', join(root, 'tree-0'), '-b', 'bead/t0')
      writeFileSync(join(root, 'tree-0', 'own.ts'), 'export const a = 1\n')
      git('-C', join(root, 'tree-0'), 'add', '-A')
      git(
        '-C',
        join(root, 'tree-0'),
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'own work'
      )
      // Land it on origin/main only, leaving local main where it was
      git(
        'update-ref',
        'refs/remotes/origin/main',
        git('-C', join(root, 'tree-0'), 'rev-parse', 'HEAD').trim()
      )

      const row = inventory(root).find(r => r.name === 'tree-0')
      // Graded against the SHIPPED default, which must be origin/main
      expect(row?.mergedIntoBase).toBe(true)
      // And the report names the ref it used, so a reader knows the lineage
      expect(renderInventory([row!], 'origin/main')).toContain(
        'graded against origin/main'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the census reports what a removal would COST', () => {
  it('lists every worktree with its branch, age and outstanding state', () => {
    const root = repoWithWorktrees(2)
    try {
      const rows = inventory(root, { base: 'main' })
      // main plus two linked
      expect(rows).toHaveLength(3)
      // main's own name is the mkdtemp basename, which is not knowable here
      expect(rows.map(r => r.name)).toContain('tree-0')
      expect(rows.map(r => r.name)).toContain('tree-1')
      const mainRow = rows.find(r => r.branch === 'main')
      expect(rows.filter(r => r.branch === 'main')).toHaveLength(1)
      // The two linked trees live INSIDE main, so a naive `git status` there
      // reports them as untracked and main's count reads as a dirt total that
      // has nothing to do with uncommitted work
      expect(mainRow?.dirty).toBe(0)
      const main = rows.find(r => r.branch === 'main')
      expect(main?.mergedIntoBase).toBe(true)
      // A linked worktree sitting ON main's commit is genuinely on base, so
      // the fixture gives one a commit of its own: otherwise the NOT-on-base
      // arm below would be satisfied by every tree reading true
      expect(rows.filter(r => r.mergedIntoBase === true)).toHaveLength(1)
      const unmerged = rows.filter(r => r.mergedIntoBase === false)
      expect(unmerged.map(r => r.name).sort()).toEqual(['tree-0', 'tree-1'])
      // Unmerged work is the finding that matters, so it must be on the row
      const text = renderInventory(rows)
      expect(text).toContain('NOT on base')
      expect(text).toMatch(/3 worktree\(s\), 2 with something outstanding/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts uncommitted work, since that is lost first', () => {
    const root = repoWithWorktrees(1)
    try {
      writeFileSync(join(root, 'tree-0', 'scratch.ts'), 'export const a = 1\n')
      const row = inventory(root, { base: 'main' }).find(
        r => r.name === 'tree-0'
      )
      expect(row?.dirty).toBe(1)
      expect(renderInventory([row!])).toContain('dirty 1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A vanished directory is the cheapest case to remove and the easiest to get
  // wrong: asking git to describe it yields an error string where the honest
  // answer is "already gone"
  it('a tree whose directory is gone is PRUNABLE, not an error', () => {
    const root = repoWithWorktrees(1)
    try {
      rmSync(join(root, 'tree-0'), { recursive: true, force: true })
      const row = inventory(root, { base: 'main' }).find(
        r => r.name === 'tree-0'
      )
      expect(row?.prunable).toBe(true)
      // No per-tree query is attempted, so there is no error field to leak
      expect(row?.dirty).toBeNull()
      expect(renderInventory([row!])).toContain('PRUNABLE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an old HEAD is called out, and the threshold is named once', () => {
    const now = Math.floor(Date.now() / 1000)
    const stale = {
      path: '/a/old',
      name: 'old',
      head: 'a'.repeat(40),
      branch: 'bead/old',
      detached: false,
      prunable: false,
      dirty: 0,
      ageDays: STALE_DAYS + 1,
      mergedIntoBase: true
    }
    expect(renderInventory([stale])).toContain(`HEAD ${STALE_DAYS + 1}d old`)
    // Merged AND clean, and it still does not say "safe to delete": the
    // untracked parity output is invisible to every field here
    const text = renderInventory([stale])
    expect(text).not.toMatch(/safe to (delete|remove)/)
    expect(text).toContain('READ-ONLY')
    expect(text).toContain('copied OUT of it')
    expect(now).toBeGreaterThan(0)
  })
})

describe('the script REMOVES nothing', () => {
  // The structural check, not a behavioural one: a behaviour test would pass
  // today and still allow a --remove added later
  it('the source contains no removal command or flag', () => {
    const source = readFileSync(SCRIPT, 'utf8')
    // BOTH comment styles: isolate.sh uses #, this script uses //, and a filter
    // that handled only one would read the header's own "no --remove" as a
    // violation of the rule the header states
    const code = source
      .split('\n')
      .filter(l => !/^\s*(\/\/|#)/.test(l))
      .join('\n')
    for (const forbidden of [
      'worktree remove',
      'worktree prune',
      'rmSync',
      'rm -rf',
      'unlinkSync',
      'rmdirSync',
      // `rm(dir, { recursive: true })` is the ordinary spelling of "delete
      // this worktree" and passed the list above
      'rm(',
      '--remove',
      '--prune',
      '--force'
    ]) {
      expect(
        code,
        `worktree-inventory.mjs must not contain ${forbidden}: removal needs ` +
          'separate approval, and evidence may live only inside a tree'
      ).not.toContain(forbidden)
    }
    // node:fs is needed for existsSync, which only READS. The write side of
    // that module is what must not appear
    expect(source).toContain("from 'node:fs'")
    for (const writer of [
      'writeFileSync',
      'mkdirSync',
      'appendFileSync',
      'cpSync'
    ]) {
      expect(
        code,
        `${writer} would let the census modify a tree`
      ).not.toContain(writer)
    }
  })

  // A census pointed at a real repo must not disturb it
  it('running it against this repo changes nothing', () => {
    const before = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], {
      encoding: 'utf8'
    })
    const listed = execFileSync('git', ['-C', REPO, 'worktree', 'list'], {
      encoding: 'utf8'
    })
    expect(run(REPO, { base: 'main' })).toBe(0)
    expect(
      execFileSync('git', ['-C', REPO, 'status', '--porcelain'], {
        encoding: 'utf8'
      })
    ).toBe(before)
    expect(
      execFileSync('git', ['-C', REPO, 'worktree', 'list'], {
        encoding: 'utf8'
      })
    ).toBe(listed)
  })

  // The shared checkout's own links are the tree everyone typechecks through,
  // so an inventory run must not repoint one
  it('leaves every workspace self-link resolving to its own tree', () => {
    const own = execFileSync('sh', ['-c', 'cd "$1" && pwd -P', 'sh', REPO], {
      encoding: 'utf8'
    }).trim()
    for (const pkg of ['basic', 'parity', 'r3f']) {
      const link = join(
        REPO,
        'examples',
        pkg,
        'node_modules',
        'three-clouds-webgpu'
      )
      const resolved = execFileSync(
        'sh',
        ['-c', `cd "$1" && pwd -P`, 'sh', link],
        { encoding: 'utf8' }
      ).trim()
      expect(
        resolved,
        [
          `examples/${pkg} self-link resolves to ${resolved}, not to this repo (${own}).`,
          `Its target is "${readlinkSync(link)}", and a RELATIVE target is read`,
          'against the directory the link physically sits in. So this worktree is',
          "borrowing another checkout's node_modules, and the library it resolves,",
          'typechecks and measures is that other tree.',
          'examples/parity/src/buildSite.test.ts SKIPS itself for the same reason.',
          'Fix: give this worktree its own install (scripts/isolate.sh <worktree>).'
        ].join('\n')
      ).toBe(own)
    }
  })
})

// A scratchpad copy of a real tree, to prove the symlink-shape fixture still
// reads as a tree rather than as a special case
describe('a tree reached through a symlink is still inventoried', () => {
  it('reports the resolved path git names', () => {
    const root = repoWithWorktrees(0)
    try {
      const alias = join(dirname(root), `alias-${Date.now()}`)
      symlinkSync(root, alias)
      const rows = inventory(alias, { base: 'main' })
      expect(rows.length).toBeGreaterThan(0)
      // git names the PHYSICAL root, so on darwin the tmpdir alias resolves to
      // /private/var. Comparing raw strings would fail on that, not on a defect
      expect(rows[0]?.path).toBe(realpathSync(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
