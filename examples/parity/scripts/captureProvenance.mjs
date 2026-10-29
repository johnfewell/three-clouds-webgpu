// Every capture carries its provenance: commit, tree key, e2e verdict
// and SERVED build. Without it a number has no chain of custody: run 3 (mail
// #1360) measured a stale shared build, voided only because the receipt named
// the served digest. Plain .mjs + .d.mts, like buildDigest/freshBuild
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { buildProvenance, resolvedPackageRoot } from './buildDigest.mjs'
import {
  e2eInputsKey,
  e2eReceiptVerdict,
  readE2eReceipt
} from './freshBuild.mjs'

// SHA-256 of the empty string: a key computed over a file list that matched
// nothing (the key-hash trap, twice hit in the fleet). Never a receipt.
export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

export function gitState(root) {
  return {
    commit: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: git(root, ['status', '--porcelain'])
      .split('\n')
      .filter(line => line.length > 0).length
  }
}

// The e2e receipt's state for THIS tree, plus whether the per-run override
// (PARITY_SKIP_E2E_RECEIPT=1) was armed. `deps` lets the unit suite reach the
// key-of-nothing refusal without corrupting a real tree
export function receiptState(root, env = process.env, deps = {}) {
  const inputsKey = deps.inputsKey ?? e2eInputsKey
  const readReceipt = deps.readReceipt ?? readE2eReceipt
  const verdictOf = deps.verdict ?? e2eReceiptVerdict
  const key = inputsKey(root)
  if (key == null || key === EMPTY_SHA256) {
    throw new Error(
      `Refusing to stamp a capture with a key of nothing (${key ?? 'null'}): the key's file list matched no files, so this is a failed measurement, not a key`
    )
  }
  const verdict = verdictOf(readReceipt(root), key)
  return {
    inputsKey: key,
    verdict: verdict.status,
    detail: verdict.detail,
    overrideArmed: env.PARITY_SKIP_E2E_RECEIPT === '1'
  }
}

// WHICH TREE served the bytes, and is it OUR lineage? Digests are
// blind to lineage and location. On 2026-09-02 the self-link resolved to a tree
// 11 commits off main, so this records the served path and HEAD and refuses
export function servedTreeState(exampleRoot, packageName) {
  let root = null
  try {
    root = resolvedPackageRoot(exampleRoot, packageName)
  } catch (e) {
    return {
      root: null,
      head: null,
      error: e instanceof Error ? e.message : String(e)
    }
  }
  try {
    return { root, head: git(root, ['rev-parse', 'HEAD']), error: null }
  } catch (e) {
    // A resolved path that is not a git tree cannot be placed in any lineage
    // Recorded as an error, never as an absent-and-therefore-fine
    return {
      root,
      head: null,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/**
 * Refuse unless the SERVED tree's HEAD is an ancestor of the SHA under test.
 *
 * Every failure mode refuses, including the ones that look like nothing:
 * unresolvable link, non-git tree, unreadable HEAD. An absent answer here is
 * indistinguishable from a clean one exactly when it matters most, so absence
 * is a refusal (EMPTY_SHA256's lesson, one layer out).
 *
 * Exported for reuse: dispatch runners get the same check rather than their own.
 */
export function refuseUnlessServedIsAncestor(
  provenance,
  shaUnderTest,
  projectRoot
) {
  const served = provenance.servedTree
  if (served == null || served.root == null) {
    throw new Error(
      `Refusing hardware evidence: cannot resolve the served package tree` +
        `${served?.error == null ? '' : ` — ${served.error}`}`
    )
  }
  if (served.head == null) {
    throw new Error(
      `Refusing hardware evidence: the served tree at ${served.root} has no ` +
        `readable git HEAD, so the bytes cannot be placed in any lineage` +
        `${served.error == null ? '' : ` — ${served.error}`}`
    )
  }
  if (typeof shaUnderTest !== 'string' || shaUnderTest.length === 0) {
    throw new Error(
      'Refusing hardware evidence: no SHA under test was supplied to compare ' +
        'the served tree against'
    )
  }
  let isAncestor
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', served.head, shaUnderTest],
      { cwd: projectRoot, stdio: 'ignore' }
    )
    isAncestor = true
  } catch {
    isAncestor = false
  }
  if (!isAncestor) {
    throw new Error(
      `Refusing hardware evidence: the served package resolves to ` +
        `${served.root} at ${served.head.slice(0, 7)}, which is NOT an ` +
        `ancestor of the SHA under test ${shaUnderTest.slice(0, 7)}. The ` +
        `capture would measure a tree off this lineage and read as normal.`
    )
  }
}

/**
 * Refuse unless the served package tree IS this tree.
 *
 * `isolate.sh verify-link` already checks this, but nobody called it,
 * and a detector nobody calls is a guard that cannot fail. This is that check
 * at a call site.
 *
 * servedIsBuilt compares digests (blind to WHERE), and the ancestor refusal
 * compares LINEAGE: a commit is its own ancestor, so the common bench shape
 * (a worktree at main serving the shared checkout) passes it.
 *
 * Both directions refuse and name themselves, since the fixes differ:
 *   (1) THIS tree's link points into a foreign tree (a repointed link).
 *   (2) THIS worktree's link points at the SHARED checkout (no own install).
 *
 * @param {{ servedTree?: { root: string|null, head: string|null, error: string|null }|null }} provenance
 * @param {string} projectRoot the tree that is running this capture
 * @returns {void}
 */
export function refuseUnlessServedIsSelf(provenance, projectRoot) {
  const served = provenance.servedTree
  if (served == null || served.root == null) {
    throw new Error(
      `Refusing hardware evidence: cannot resolve the served package tree` +
        `${served?.error == null ? '' : ` — ${served.error}`}`
    )
  }
  // BOTH sides through realpath: on darwin <tmp> is <tmp-2> once resolved,
  // so a string compare would refuse every correctly linked temp worktree and
  // the guard would be turned off within a day
  const servedRoot = realpathOrSelf(served.root)
  const running = realpathOrSelf(projectRoot)
  if (servedRoot === running) return

  const main = mainCheckoutOf(running)
  const direction =
    main != null && servedRoot === main && running !== main
      ? `This worktree is serving the SHARED CHECKOUT at ${servedRoot}. It ` +
        `inherited that link instead of owning its modules — run ` +
        `\`scripts/isolate.sh ${running}\` and re-capture.`
      : `This tree's package link points into ${servedRoot}, which is not it. ` +
        `The link was repointed (an isolate run that left it behind is the ` +
        `usual cause) — run \`sh scripts/isolate.sh verify-link ${running}\` ` +
        `and repoint it at the workspace root.`
  throw new Error(
    `Refusing hardware evidence: the capture running in ${running} would ` +
      `measure bytes served from ${servedRoot}. ${direction} Note the receipt ` +
      `cannot show you this: \`dirty\` describes ${running}, not the served ` +
      `tree, and the ancestor check passes whenever the served HEAD is an ` +
      `ancestor of the SHA under test — including the same SHA.`
  )
}

/** realpath, or the input when it cannot be resolved (absence refuses later) */
function realpathOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * The main checkout backing `root`, via git's common dir: `.git` for the main
 * checkout, `<main>/.git` for a linked worktree. Null when `root` is not a git
 * tree, and the caller then reports the direction-agnostic message rather than
 * guessing, since a wrong direction sends the reader to the wrong fix.
 */
function mainCheckoutOf(root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const abs = isAbsolute(common) ? common : join(root, common)
    return realpathOrSelf(dirname(abs))
  } catch {
    return null
  }
}

/**
 * The per-run SKIPS, as booleans, so a capture can be TOLD it skipped them.
 *
 * PARITY_SKIP_BUILD and
 * PARITY_SKIP_TYPECHECK were warned about at runtime and stamped nowhere, so a
 * committed metrics.json could not be said to have skipped either. The e2e skip
 * was already recorded (as e2e.overrideArmed); this generalises the shape
 * rather than inventing a second one.
 *
 * Booleans, not a list of names: the reader is verify-results.mjs, which tests
 * each by name and prints its own sentence, so a string here would duplicate
 * that vocabulary in a place that cannot afford to drift from it.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ build: boolean, typecheck: boolean }}
 */
export function skipState(env = process.env) {
  return {
    build: env.PARITY_SKIP_BUILD === '1',
    typecheck: env.PARITY_SKIP_TYPECHECK === '1'
  }
}

export function captureProvenance({
  projectRoot,
  exampleRoot,
  packageName,
  env = process.env,
  deps
}) {
  return {
    git: gitState(projectRoot),
    e2e: receiptState(projectRoot, env, deps),
    build: buildProvenance(projectRoot, exampleRoot, packageName),
    // the build skips travel with the
    // receipt rather than only in the log line
    skips: skipState(env),
    // the receipt must be able to NAME the tree it measured
    servedTree: servedTreeState(exampleRoot, packageName)
  }
}

// Term (c): the bytes under measurement are whatever the dev server resolves
// for the package through examples/parity/node_modules, which is not
// necessarily the tree that was just rebuilt. Refuse rather than record.
export function refuseUnlessServedIsBuilt(provenance, packageName) {
  const { built, served, error, servedIsBuilt } = provenance.build
  if (servedIsBuilt === true) return
  throw new Error(
    `Refusing hardware evidence: the dev server resolves ${packageName} to ${served?.root ?? 'nothing'} (build ${served?.digest.slice(0, 12) ?? 'unresolved'}), not the build just produced at ${built.root} (${built.digest.slice(0, 12)})${error == null ? '' : ` — ${error}`}`
  )
}

export function provenanceLine(prefix, provenance) {
  const { git: g, e2e, build, skips } = provenance
  const skipStr =
    skips == null
      ? ''
      : ` skips(build=${skips.build === true} typecheck=${skips.typecheck === true})`
  return (
    `${prefix} commit ${g.commit.slice(0, 7)} branch ${g.branch} dirty ${g.dirty} ` +
    `key ${e2e.inputsKey.slice(0, 12)} e2e ${e2e.verdict}` +
    (e2e.overrideArmed ? ' OVERRIDE(PARITY_SKIP_E2E_RECEIPT=1)' : '') +
    skipStr +
    ` served ${build.served?.digest.slice(0, 12) ?? 'unresolved'} built ${build.built.digest.slice(0, 12)} servedIsBuilt ${String(build.servedIsBuilt)}` +
    ` servedTree ${provenance.servedTree?.root ?? 'unresolved'}@${provenance.servedTree?.head?.slice(0, 7) ?? 'no-head'}`
  )
}
