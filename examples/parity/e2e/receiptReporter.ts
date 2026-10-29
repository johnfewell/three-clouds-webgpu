// Writes a keyed, PER-TEST receipt of the e2e run, so a red suite blocks a
// capture as a red typecheck does. Per test because SKIPPED IS NOT
// PASSED and a --grep run is not a whole one. Keyed by a hash of the
// e2e INPUTS, not a sha: a receipt committed with the plates would always name
// a commit that does not exist yet

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult
} from '@playwright/test/reporter'

import { buildProvenance } from '../scripts/buildDigest.mjs'
import { KEY_PATHS as KEY_PATHS_VALUE, keyCommand } from './keyPaths.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const PARITY_ROOT = resolve(import.meta.dirname, '..')

/**
 * Flattened build provenance for the receipt: what this tree BUILT, what the
 * dev server actually RESOLVED, and whether they were the same bytes.
 *
 * Never throws: a receipt that cannot record its provenance must still be
 * written, and `servedIsBuilt: false` (or an error string) is the signal a
 * reader needs. Swallowing it would make a stale build look clean.
 */
function buildProof() {
  try {
    const p = buildProvenance(REPO_ROOT, PARITY_ROOT, 'three-clouds-webgpu')
    return {
      builtRoot: p.built.root,
      servedRoot: p.served?.root ?? null,
      builtSharedSha256: p.built.sharedSha256,
      servedSharedSha256: p.served?.sharedSha256 ?? null,
      servedIsBuilt: p.servedIsBuilt,
      builtFromKey: p.builtFromKey,
      error: p.error
    }
  } catch (e) {
    return {
      builtRoot: REPO_ROOT,
      servedRoot: null,
      builtSharedSha256: '',
      servedSharedSha256: null,
      servedIsBuilt: false,
      builtFromKey: null,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

// Beside the PLATES, not in gitignored test-results/: the receipt is committed
// with the results it backs. It names the bytes the
// server SERVED, via the shared provenance module

export const RECEIPT_PATH = resolve(
  REPO_ROOT,
  'parity',
  'results',
  'e2e-receipt.json'
)

// KEY_PATHS is re-exported, not redefined: see ./keyPaths.mjs for why one
// definition serves the writer and the reader
export { KEY_PATHS } from './keyPaths.mjs'

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'did-not-run'

export interface ReceiptEntry {
  /** Spec file, relative, e.g. `e2e/p4.spec.ts`. */
  spec: string
  /** Exact full title, so a renamed test does not silently inherit a verdict */
  title: string
  status: TestStatus
}

export interface E2eReceipt {
  key: string
  /** True when the run was filtered (--grep): a partial run, never a whole one */
  filtered: boolean
  /** Tracked-file working tree differed from HEAD, or untracked files present */
  dirty: boolean
  tests: ReceiptEntry[]
  ts: string
  /**
   * The key hashes git-tracked SOURCES and `build/` is
   * gitignored, so it cannot cover the bytes the dev server served. Without
   * this a green receipt could cover a stale build, which voided a bench run.
   *
   * Recorded rather than re-checked later, since a later check would have to
   * rebuild, and a rebuild elsewhere can differ for unrelated reasons.
   */
  build?: {
    builtRoot: string
    servedRoot: string | null
    builtSharedSha256: string
    servedSharedSha256: string | null
    servedIsBuilt: boolean
    /** e2e input key stamped when these bytes were built */
    builtFromKey: string | null
    error: string | null
  }
}

function sh(command: string): string | null {
  try {
    return execSync(command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024
    }).trim()
  } catch {
    return null
  }
}

/**
 * Hash of the e2e inputs' WORKING-TREE contents.
 *
 * Working tree, not the index: `git write-tree` / `ls-files -s` hash staged
 * content and would call a dirty tree clean. `LC_ALL=C sort` so the key does
 * not depend on the machine's collation.
 *
 * Untracked files move the `dirty` flag, not this key: folding them in would
 * churn the key on every scratch file, and a gate that fires when nothing is
 * wrong gets turned off.
 */
export function e2eInputsKey(): string | null {
  return sh(keyCommand())
}

export default class ReceiptReporter implements Reporter {
  private readonly entries: ReceiptEntry[] = []
  private filtered = false

  onBegin(config: FullConfig, _suite: Suite): void {
    // MEASURED: `config.grep` does NOT reflect a CLI `--grep` (a filtered run
    // reported `filtered: false`), so the argv check is the load-bearing half
    // and config.grep only the belt to its braces
    const argv = process.argv.slice(2)
    const filteredByCli = argv.some(
      a =>
        a === '--grep' ||
        a === '-g' ||
        a.startsWith('--grep=') ||
        a.startsWith('--grep-invert') ||
        a.startsWith('--shard') ||
        a.startsWith('--project') ||
        // A bare spec path argument also narrows the run
        /\.spec\.[cm]?[jt]s$/.test(a)
    )
    this.filtered = filteredByCli || String(config.grep) !== String(/.*/)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const status: TestStatus =
      result.status === 'passed'
        ? 'passed'
        : result.status === 'skipped'
          ? 'skipped'
          : 'failed'
    this.entries.push({
      spec: test.location.file.split('/examples/parity/').pop() ?? '',
      title: test.titlePath().slice(1).join(' › '),
      status
    })
  }

  onEnd(_result: FullResult): void {
    // Playwright calls reporters for `--list`, even though no test executes
    // Writing that zero-entry run would overwrite the committed evidence with
    // a current-key receipt that misleadingly says it was unfiltered
    if (this.entries.length === 0) return

    const key = e2eInputsKey()
    // not a git checkout, nothing to key a receipt to
    if (key == null) return

    const receipt: E2eReceipt = {
      key,
      filtered: this.filtered,
      // Scoped to the INPUT paths: an unrelated edit elsewhere does not make
      // this receipt less true. Untracked files under those paths DO, since
      // they change what runs while the tracked-only key stays identical
      dirty:
        (sh(`git status --porcelain -- ${KEY_PATHS_VALUE.join(' ')}`) ?? '') !==
        '',
      tests: this.entries,
      ts: new Date().toISOString(),
      build: buildProof()
    }
    mkdirSync(dirname(RECEIPT_PATH), { recursive: true })
    writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2))
  }
}
