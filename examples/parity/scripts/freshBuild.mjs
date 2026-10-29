// The harness serves build/, never src/, so every run rebuilds
// (~2.4 s) rather than refusing on mtimes, which cried wolf after every
// checkout. It typechecks first (vite build does not, and a red tree
// captures a plausible table). PARITY_SKIP_TYPECHECK=1 skips the check loudly,
// PARITY_SKIP_BUILD=1 skips both

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { keyCommand } from '../e2e/keyPaths.mjs'
import { SOURCE_KEY_FILE } from './buildDigest.mjs'

export const BUILD_COMMAND = 'pnpm build'
// build → tsc (library) → tsc (parity); order pinned by test/typecheckGate.test.ts
export const TYPECHECK_COMMAND = 'pnpm typecheck'

// The runners have different working directories, so neither can hardcode a
// path to the repo root
export function findRepoRoot(startDir) {
  let dir = resolve(startDir)
  for (let i = 0; i < 10; i++) {
    // pnpm-workspace.yaml, NOT src/ + package.json: examples/parity has both,
    // so the old marker returned the EXAMPLE and ran `pnpm build` there,
    // silently not rebuilding the library on every e2e run (found by this check)
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// The e2e receipt: has the suite passed on THIS tree? A red e2e
// once refused nothing while a red typecheck refused everything. Playwright's
// .last-run.json is not keyed to the code, so it cannot answer that
export const E2E_RECEIPT_PATH = join('parity', 'results', 'e2e-receipt.json')

/**
 * Test titles, for a verdict a reader can act on. Capped, because a filtered
 * whole-suite run would otherwise put 128 titles into a log line
 */
function nameTests(tests, limit = 3) {
  const titles = tests.map(t => t.title)
  if (titles.length <= limit) return titles.join('; ')
  return `${titles.slice(0, limit).join('; ')} (+${titles.length - limit} more)`
}

/**
 * Decide whether a receipt proves that its served bytes came from its inputs.
 *
 * @param {{ builtRoot: string, servedRoot: string | null, builtSharedSha256: string, servedSharedSha256: string | null, servedIsBuilt: boolean, builtFromKey?: string | null, error: string | null } | undefined} build
 * @param {string} receiptKey
 * @returns {{ status: 'stale', detail: string } | null}
 */
function buildProvenanceVerdict(build, receiptKey) {
  if (build == null) {
    return {
      status: 'stale',
      detail:
        'receipt carries no build provenance, so the bytes the suite ran are unknown'
    }
  }
  if (build.servedIsBuilt !== true) {
    return {
      status: 'stale',
      detail:
        `the dev server did NOT serve this tree's build: built ${String(build.builtSharedSha256).slice(0, 12)} ` +
        `at ${build.builtRoot}, served ${String(build.servedSharedSha256 ?? 'nothing').slice(0, 12)} ` +
        `at ${build.servedRoot ?? 'unresolved'}` +
        (build.error == null ? '' : ` (${build.error})`)
    }
  }
  // matching built/served digests establish WHICH bytes ran, not
  // which inputs produced them. In one checkout they match over any old build.
  if (build.builtFromKey == null) {
    return {
      status: 'stale',
      detail:
        'the served build carries no source stamp, so which inputs produced ' +
        'the bytes is unproven'
    }
  }
  if (build.builtFromKey !== receiptKey) {
    return {
      status: 'stale',
      detail:
        `the served build was compiled from inputs ${String(build.builtFromKey).slice(0, 12)}, ` +
        `but the receipt is keyed to ${receiptKey.slice(0, 12)} — STALE BYTES`
    }
  }
  return null
}

/**
 * The receipt is PER-TEST, so the verdict can distinguish states a boolean
 * cannot: a skip is not a pass, and a filtered run is not a whole
 * one. Only an unfiltered, clean run with no failures is green.
 *
 * @param {{ key: string, filtered?: boolean, dirty?: boolean, tests?: Array<{ spec: string, title: string, status: string }>, build?: { builtRoot: string, servedRoot: string | null, builtSharedSha256: string, servedSharedSha256: string | null, servedIsBuilt: boolean, builtFromKey?: string | null, error: string | null } } | null} receipt
 * @param {string | null} key
 * @returns {{ status: 'green' | 'red' | 'stale' | 'missing' | 'dirty' | 'partial', detail: string }}
 */
export function e2eReceiptVerdict(receipt, key) {
  if (receipt == null) {
    return { status: 'missing', detail: 'no e2e receipt on this machine' }
  }
  if (key == null) {
    return { status: 'missing', detail: 'could not hash the e2e inputs' }
  }
  if (receipt.key !== key) {
    // A receipt for other inputs is UNKNOWN, not green. Reading it as a pass is
    // exactly the vacuity this gate exists to remove
    return {
      status: 'stale',
      detail: `receipt is for inputs ${String(receipt.key).slice(0, 12)}, this tree hashes ${key.slice(0, 12)}`
    }
  }
  const tests = receipt.tests ?? []
  const failed = tests.filter(t => t.status === 'failed')
  // Failures come FIRST: a red test is a stronger statement than a dirty tree
  // or a partial run, and must not be masked by them
  if (failed.length > 0) {
    return {
      status: 'red',
      detail: `e2e FAILED: ${failed.map(t => `${t.spec} › ${t.title}`).join('; ')}`
    }
  }
  // did the suite exercise THIS tree's bytes? The key
  // cannot cover the gitignored build/, so missing proof must not read as a
  // pass. Checked after failures: a red test outranks unprovable provenance
  const provenanceVerdict = buildProvenanceVerdict(receipt.build, receipt.key)
  if (provenanceVerdict != null) return provenanceVerdict
  if (receipt.dirty === true) {
    return {
      status: 'dirty',
      detail:
        'receipt was recorded on a tree with uncommitted or untracked changes'
    }
  }
  if (receipt.filtered === true) {
    return {
      status: 'partial',
      // WHICH tests ran is the whole admissibility question: a capture that
      // names them can be checked against the gate it was meant to satisfy
      detail: `receipt covers a FILTERED run of ${tests.length} test(s), the rest did not run: ${nameTests(tests)}`
    }
  }
  if (tests.length === 0) {
    return { status: 'partial', detail: 'receipt records no tests at all' }
  }
  const skipped = tests.filter(t => t.status === 'skipped')
  // Skips are reported, not refused: some are structural, and refusing on them
  // would fire every run until the gate was switched off. They are named so a
  // reader sees WHICH evidence is absent
  const detail =
    skipped.length > 0
      ? `e2e passed (${tests.length - skipped.length} passed, ${skipped.length} SKIPPED — skipped is not passed: ${skipped.map(t => t.title).join('; ')})`
      : `e2e passed, all ${tests.length} tests`
  return { status: 'green', detail }
}

/**
 * @param {string} root
 * @param {(path: string) => string} [read]
 * @returns {{ key: string, filtered?: boolean, dirty?: boolean, tests?: Array<{ spec: string, title: string, status: string }> } | null}
 */
export function readE2eReceipt(root, read = p => readFileSync(p, 'utf8')) {
  try {
    return JSON.parse(read(join(root, E2E_RECEIPT_PATH)))
  } catch {
    return null
  }
}

/**
 * The e2e receipt's KEY: a hash of the working-tree contents of the inputs an
 * e2e run depends on (Amendment 5). Keyed by inputs, not commit, because the
 * receipt is committed WITH the results it backs, so a commit key would name a
 * commit that does not exist yet.
 *
 * Exported so the CI reporter and ensureFreshBuild share ONE definition rather
 * than mirrored copies (the boundary this audited).
 *
 * @param {string} root repo root
 * @returns {string | null} null when git cannot answer (not a green)
 */
export function e2eInputsKey(root) {
  try {
    // The command comes from the SAME module the writer stamps its key with
    //. This function once hardcoded the path list inline: a second
    // copy of the rule, under a docstring about mirrored rules
    return execSync(keyCommand(), {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    }).trim()
  } catch {
    return null
  }
}

/**
 * Stamp the key only after a successful build has produced the bytes.
 *
 * Failure is represented by an absent stamp, which the receipt reads as
 * unproven. The caller deliberately invokes this below every skip/failure
 * return so those paths cannot certify bytes they did not build.
 *
 * @param {string} root repo root
 * @param {(root: string) => string | null} inputsKey
 */
function stampSourceKey(root, inputsKey) {
  try {
    const key = inputsKey(root)
    if (key == null) return
    writeFileSync(join(root, 'build', SOURCE_KEY_FILE), `${key}\n`)
  } catch {
    // The verdict treats an absent stamp as stale, so provenance fails closed
  }
}

/**
 * Remove the previous certification before a command can mutate build/.
 *
 * A failed rebuild may leave partially-written output behind. Keeping an older
 * matching stamp beside those bytes would be worse than having no stamp, so
 * failure must leave this file absent.
 *
 * @param {string} root repo root
 */
function invalidateSourceKey(root) {
  rmSync(join(root, 'build', SOURCE_KEY_FILE), { force: true })
}

/**
 * Typechecks the tree and rebuilds the library so the harness serves current,
 * type-correct code.
 *
 * `run` and `log` are injectable so the decision is testable without building.
 * The options carry JSDoc types because, under `allowJs`, defaults would type
 * the injectable callbacks as `undefined`.
 *
 * `requireGreenE2e` is OPT-IN: the e2e runner calls this too, and a receipt
 * check there would deadlock a red suite. Captures opt in.
 *
 * @param {string} label
 * @param {{ startDir?: string, run?: (command: string, options: { cwd: string }) => unknown,
 *   log?: (message: string) => void, env?: Record<string, string | undefined>,
 *   requireGreenE2e?: boolean,
 *   readReceipt?: (root: string) => ({ key: string, filtered?: boolean, dirty?: boolean, tests?: Array<{ spec: string, title: string, status: string }> } | null),
 *   inputsKey?: (root: string) => (string | null) }} [options]
 * @returns {{ built: boolean, typechecked: boolean, reason: string, root?: string }}
 */
export function ensureFreshBuild(
  label,
  {
    startDir = process.cwd(),
    run = undefined,
    log = console.log,
    env = process.env,
    requireGreenE2e = false,
    readReceipt = readE2eReceipt,
    inputsKey = e2eInputsKey
  } = {}
) {
  if (env.PARITY_SKIP_BUILD === '1') {
    log(
      `[${label}] PARITY_SKIP_BUILD=1 — serving build/ as-is, which may be stale and unchecked`
    )
    return { built: false, typechecked: false, reason: 'skipped' }
  }
  const root = findRepoRoot(startDir)
  if (root == null) {
    log(`[${label}] could not locate the repo root; skipping the rebuild`)
    return { built: false, typechecked: false, reason: 'no-root' }
  }
  // `cwd` is PASSED to `run`, not closed over, so a test double can assert it:
  // the wrong-root defect lived entirely in the cwd, which the old seam never
  // showed the double
  const exec =
    run ?? ((cmd, options) => execSync(cmd, { ...options, stdio: 'inherit' }))
  const t0 = Date.now()
  if (env.PARITY_SKIP_TYPECHECK === '1') {
    log(
      `[${label}] PARITY_SKIP_TYPECHECK=1 — building without the typecheck; a red tree still captures a plausible table`
    )
    invalidateSourceKey(root)
    exec(BUILD_COMMAND, { cwd: root })
    log(
      `[${label}] rebuilt the library in ${Date.now() - t0}ms — the harness serves build/, not src/`
    )
    stampSourceKey(root, inputsKey)
    return { built: true, typechecked: false, reason: 'unchecked', root }
  }
  if (requireGreenE2e && env.PARITY_SKIP_E2E_RECEIPT === '1') {
    log(
      `[${label}] PARITY_SKIP_E2E_RECEIPT=1 — capturing WITHOUT a passing e2e suite for this tree. Whatever this run produces is not backed by the suite.`
    )
  }
  if (requireGreenE2e && env.PARITY_SKIP_E2E_RECEIPT !== '1') {
    const verdict = e2eReceiptVerdict(readReceipt(root), inputsKey(root))
    if (verdict.status === 'red') {
      log(
        `[${label}] REFUSING to run: ${verdict.detail}. A capture on a tree whose e2e is failing produces a complete, plausible results table that measures broken code. Fix the failures, or set PARITY_SKIP_E2E_RECEIPT=1 to capture anyway, loudly.`
      )
      throw new Error(`e2e receipt is red: ${verdict.detail}`)
    }
    // Anything that is not a clean green is reported but does NOT refuse: an
    // unknown must not masquerade as either verdict, and refusing on a missing
    // receipt would block a fresh clone that has never run e2e
    if (verdict.status !== 'green') {
      log(
        `[${label}] e2e receipt ${verdict.status}: ${verdict.detail} — proceeding, but this capture is NOT backed by a passing suite on this commit`
      )
    }
  }
  invalidateSourceKey(root)
  try {
    exec(TYPECHECK_COMMAND, { cwd: root })
  } catch (error) {
    log(
      `[${label}] REFUSING to run: \`${TYPECHECK_COMMAND}\` failed. vite build does not typecheck, so a red tree would still capture a plausible table. Fix the errors above, or set PARITY_SKIP_TYPECHECK=1 to build without the check.`
    )
    throw error
  }
  log(
    `[${label}] typechecked and rebuilt the library in ${Date.now() - t0}ms — the harness serves build/, not src/`
  )
  stampSourceKey(root, inputsKey)
  return { built: true, typechecked: true, reason: 'ok', root }
}
