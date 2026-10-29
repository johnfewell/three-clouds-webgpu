// A test that writes a TRACKED file cannot report that it did: the write lands,
// the assertions pass, and the next test to snapshot `git status` inherits the
// dirt. setup/teardown below compare the tree before the pool starts with the
// tree after it drains, and fail the run on any difference. That comparison is a
// set of PATHS, not a cleanliness claim, so a developer mid-edit is not a failure

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '..', '..')

/**
 * `git status --porcelain` lines. Null where this is not a checkout at all
 *
 * The null is narrow on purpose. An earlier version returned an empty set for
 * ANY git failure, and a swallowed argument error therefore handed the guard an
 * empty baseline, which reports every pre-existing dirty path as new dirt. Only
 * "there is no .git here" may pass silently, because only that is a legitimate
 * zero.
 */
export function dirtyPaths(root: string = REPO_ROOT): Set<string> | null {
  try {
    return new Set(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .split('\n')
        .filter(line => line.length > 0)
    )
  } catch (error) {
    // A packed tarball, a CI export, a copied tree: nothing to compare
    if (!existsSync(join(root, '.git'))) return null
    throw error
  }
}

/** Paths in exactly one of the two snapshots, each side labelled */
export function treeDelta(before: Set<string>, after: Set<string>): string[] {
  return [
    ...[...after].filter(p => !before.has(p)).map(p => `+ ${p}`),
    ...[...before].filter(p => !after.has(p)).map(p => `- ${p}`)
  ].sort()
}

/** Thrown on a difference, so a caller can decide how loudly to fail */
export class TreeDirtiedError extends Error {
  constructor(readonly delta: string[]) {
    super(
      'the suite changed the working tree:\n' +
        delta.join('\n') +
        '\nA test wrote, removed or restored a tracked path. A suite must ' +
        'leave `git status --porcelain` exactly as it found it.'
    )
    this.name = 'TreeDirtiedError'
  }
}

/** Throws when the tree at `root` no longer matches `before` */
export function assertTreeUnchanged(
  before: Set<string>,
  root: string = REPO_ROOT
): void {
  const delta = treeDelta(before, dirtyPaths(root) ?? new Set())
  if (delta.length > 0) throw new TreeDirtiedError(delta)
}

// globalSetup, not a worker: a snapshot taken inside a worker races the very
// writes it exists to catch, and the clean-tree assertion this guards against
// was itself the thing that went red
let baseline: Set<string> | null | undefined
let reported = false

/**
 * vitest calls this with the TestProject as its first argument. So it takes NO
 * parameters and names the root itself: a `root` parameter here silently became
 * that project, node rejected it as `options.cwd`, and the guard compared every
 * run against an empty baseline
 */
export function setup(): void {
  baseline = dirtyPaths()
  reported = false
}

/** Snapshot a named tree instead, for the guard's own tests */
export function snapshot(root: string): void {
  baseline = dirtyPaths(root)
  reported = false
}

// vitest CATCHES a throwing globalSetup teardown, logs it and exits 0 anyway,
// so failing the run means setting the exit code directly. `onFailure` is the
// seam that lets a test observe that call without failing its own worker
export function teardown(
  root: string = REPO_ROOT,
  onFailure: (error: Error) => void = failRun
): void {
  // Undefined means setup never ran, and null means the tree is not a
  // checkout. Both are "nothing to compare", and silence there would read as a
  // passing guard that never looked
  if (baseline == null) {
    console.error(
      '[git tree guard] SKIPPED: no baseline snapshot, so the suite was not ' +
        'watched for tracked-path writes'
    )
    return
  }
  // Two projects share this module in one process, so both call setup and both
  // call teardown. Report a moved tree once, not once per project
  if (reported) return
  try {
    assertTreeUnchanged(baseline, root)
  } catch (error) {
    reported = true
    onFailure(error as Error)
  }
}

function failRun(error: Error): void {
  console.error(`[git tree guard] ${error.message}`)
  process.exitCode = 1
}
