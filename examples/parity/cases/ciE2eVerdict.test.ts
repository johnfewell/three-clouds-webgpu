// CI cannot boot this suite (SwiftShader), so the
// reporter states the committed receipt's verdict instead of reading CI green
// as "e2e passed" (ADR-011 A5). Only `red` fails the job: stale/missing is
// the bench lagging, not this commit's red, but always warns, never passes

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { keyCommand } from '../e2e/keyPaths.mjs'
import { reportVerdict } from '../scripts/ciE2eVerdict.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const PARITY_ROOT = join(REPO_ROOT, 'examples', 'parity')
const PLAYWRIGHT = join(PARITY_ROOT, 'node_modules', '.bin', 'playwright')

function capture(fn: () => number): { code: number; out: string } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation(m => {
    lines.push(String(m))
  })
  const code = fn()
  spy.mockRestore()
  return { code, out: lines.join('\n') }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GITHUB_ACTIONS
})

const RECEIPT_REL = 'parity/results/e2e-receipt.json'

interface ReceiptShape {
  key?: string
  tests?: Array<{ status?: string }>
}

/** The receipt as COMMITTED at HEAD, or null when git cannot answer */
function committedReceipt(): ReceiptShape | null {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `HEAD:${RECEIPT_REL}`], {
        cwd: REPO_ROOT,
        encoding: 'utf-8'
      })
    ) as ReceiptShape
  } catch {
    return null
  }
}

/**
 * Runs the reporter WITHOUT throwing, so a crash and a red verdict stay
 * distinguishable: spawnSync surfaces spawn errors, signals and status
 * separately, where execFileSync collapses all three into one exception
 *
 * `root` is the repo the reporter reads. Left unset it is this repository;
 * the regression test below passes a fixture so it never has to write the
 * tracked receipt
 */
function runVerdict(root: string = REPO_ROOT): {
  code: number | null
  out: string
  stderr: string
  error?: Error
  signal: NodeJS.Signals | null
} {
  const r = spawnSync(
    'node',
    [join(REPO_ROOT, 'examples/parity/scripts/ciE2eVerdict.mjs')],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, PARITY_REPO_ROOT: root }
    }
  )
  return {
    code: r.status,
    out: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
    signal: r.signal
  }
}

/**
 * A throwaway git repo whose HEAD holds a receipt the reporter calls GREEN,
 * so the sabotage below is a real verdict flip (green at HEAD, red in the
 * working tree) rather than two identical STALE banners agreeing with each other
 *
 * It is a git repo because the reporter reads its receipt with `git show
 * HEAD:…`, and it commits something under KEY_PATHS: `git ls-files` over an
 * empty list hashes to the digest of nothing, which is a measurement over zero
 * inputs wearing a key
 */
function greenFixtureRepo(): { root: string; key: string } {
  const root = mkdtempSync(join(tmpdir(), 'e2e-verdict-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'e2e verdict test')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'vitest.config.ts'), '// fixture\n')
  git('add', '-A')
  git('commit', '-qm', 'key inputs')
  // The key hashes TRACKED contents of KEY_PATHS only, so writing the receipt
  // does not move it, and the second commit carries a receipt that matches
  const key = execSync(keyCommand(), { cwd: root, encoding: 'utf8' }).trim()
  mkdirSync(join(root, 'parity', 'results'), { recursive: true })
  writeFileSync(
    join(root, RECEIPT_REL),
    JSON.stringify({
      key,
      tests: [{ spec: 'p0', title: 'boots', status: 'passed' }],
      // Provenance the reporter demands before it will call a receipt green:
      // absent it, the verdict is STALE on bytes rather than on this test
      build: {
        builtRoot: root,
        servedRoot: root,
        builtSharedSha256: 'a'.repeat(64),
        servedSharedSha256: 'a'.repeat(64),
        servedIsBuilt: true,
        builtFromKey: key,
        error: null
      }
    })
  )
  git('add', '-A')
  git('commit', '-qm', 'receipt')
  return { root, key }
}

describe('e2e receipt verdict reporting', () => {
  it('green exits 0 and says the tree IS verified', () => {
    const { code, out } = capture(() =>
      reportVerdict(
        { status: 'green', detail: '90 tests passed' },
        'abc123def456'
      )
    )
    expect(code).toBe(0)
    expect(out).toContain('GREEN')
    expect(out).toContain('verified on bench hardware')
  })

  it('red FAILS the job — a receipt recording failures is a real red', () => {
    const { code, out } = capture(() =>
      reportVerdict(
        { status: 'red', detail: 'e2e FAILED: p0.spec.ts › 1. boots' },
        'abc123def456'
      )
    )
    expect(code).toBe(1)
    expect(out).toContain('RED')
  })

  it.each(['stale', 'missing', 'dirty', 'partial'] as const)(
    '%s does not fail the job but is never reported as a pass',
    status => {
      const { code, out } = capture(() =>
        reportVerdict({ status, detail: 'because reasons' }, 'abc123def456')
      )
      expect(code).toBe(0)
      expect(out).toContain(status.toUpperCase())
      // The load-bearing assertion: a green job must not be readable as "e2e
      // passed", so the reporter says so in as many words
      expect(out).toContain('UNVERIFIED')
      expect(out).toContain('does NOT mean e2e passed')
    }
  )

  it('emits GitHub annotations when running in Actions', () => {
    process.env.GITHUB_ACTIONS = 'true'
    const green = capture(() =>
      reportVerdict({ status: 'green', detail: 'ok' }, 'abc123def456')
    )
    const stale = capture(() =>
      reportVerdict({ status: 'stale', detail: 'other inputs' }, 'abc123def456')
    )
    const red = capture(() =>
      reportVerdict({ status: 'red', detail: 'failed' }, 'abc123def456')
    )
    expect(green.out).toContain('::notice::')
    expect(stale.out).toContain('::warning::')
    expect(red.out).toContain('::error::')
  })

  it('handles a null key without pretending to know the inputs', () => {
    const { out } = capture(() =>
      reportVerdict({ status: 'missing', detail: 'no key' }, null)
    )
    expect(out).toContain('unknown')
  })

  // These drive the real script, since the unit tests pass over dead wiring
  //. spawnSync, not execFileSync: a thrown non-zero exit made
  // "correctly reported RED" indistinguishable from "crashed"
  it('the script reports on the current tree and does not crash', () => {
    const { code, out, stderr, error, signal } = runVerdict()

    expect(error, 'the reporter failed to spawn').toBeUndefined()
    expect(signal, 'the reporter was killed by a signal').toBeNull()
    // 0 (green/stale/missing) and 1 (red) are the ONLY contracted statuses
    expect([0, 1]).toContain(code)
    expect(out).toContain('e2e VERDICT FOR THIS TREE')
    // A banner alone is not enough: the process could print it and then die
    // No stack frame may reach stderr (LilacOtter #1586)
    expect(stderr).not.toMatch(/\s+at\s/)

    // The verdict must AGREE with the committed receipt (#1584), CONDITIONED on
    // key agreement: this file is in a key path, so any branch editing it is
    // honestly STALE. The unconditional draft failed its own PR
    const receipt = committedReceipt()
    const failed = (receipt?.tests ?? []).filter(t => t.status === 'failed')
    // The tree key comes from the reporter's OWN banner ("inputs <key>"),
    // not from re-importing the hashing helper: one source of truth, and the
    // test cannot disagree with the thing it is testing
    const treeKey = /inputs ([0-9a-f]{12})/.exec(out)?.[1]
    const keysAgree =
      typeof receipt?.key === 'string' &&
      treeKey != null &&
      receipt.key.startsWith(treeKey)

    if (keysAgree && failed.length > 0) {
      // The receipt describes THIS tree and records failures: red is the only
      // honest report, and exit 1 is the contract
      expect(out, 'a red receipt for this tree must be reported RED').toContain(
        'RED'
      )
      expect(code, 'a red receipt must exit 1').toBe(1)
    } else if (keysAgree) {
      expect(out).toMatch(/GREEN|DIRTY|PARTIAL/)
      expect(code).toBe(0)
    } else {
      // Keys differ: the receipt is about another tree. STALE (or MISSING) is
      // correct and must NOT be reported as a pass
      expect(out).toMatch(/STALE|MISSING/)
      expect(out).toContain('does NOT mean e2e passed')
      expect(code).toBe(0)
    }
  })

  // REGRESSION (CI run 33557499792): the e2e suite's reporter overwrote the
  // working-tree receipt with CI's own SwiftShader run first. The reporter
  // must read HEAD, not the file the same job clobbers
  it('reads the COMMITTED receipt, not a clobbered working-tree one', () => {
    // A FIXTURE repo, never this one: sabotaging the tracked receipt in place
    // dirtied the tree under every test that snapshots git status, and left it
    // dirty for good if the run was killed mid-write
    const { root, key } = greenFixtureRepo()
    try {
      // GREEN at HEAD, so a reporter reading the working tree instead would
      // flip to RED and exit 1, and the differential is a verdict change
      const before = runVerdict(root)
      expect(before.out, 'the fixture must be GREEN at HEAD').toContain('GREEN')
      expect(before.code).toBe(0)

      const sabotaged = JSON.parse(
        readFileSync(join(root, RECEIPT_REL), 'utf8')
      ) as Record<string, unknown>
      sabotaged.key = 'deadbeefcafe0000'
      sabotaged.tests = [{ spec: 'x', title: 'y', status: 'failed' }]
      writeFileSync(join(root, RECEIPT_REL), JSON.stringify(sabotaged, null, 2))

      const after = runVerdict(root)

      expect(after.out, 'output changed when the working tree did').toBe(
        before.out
      )
      expect(after.code, 'status changed when the working tree did').toBe(
        before.code
      )
      expect(after.out).not.toContain('deadbeefcafe')
      // The key is DERIVED from the tree it was pointed at, never hardcoded, so
      // the reporter cannot pass by echoing the fixture's own receipt back
      expect(after.out).toContain(`inputs ${key.slice(0, 12)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite committed evidence when Playwright only lists tests', () => {
    const receiptPath = join(REPO_ROOT, RECEIPT_REL)
    const original = readFileSync(receiptPath, 'utf8')
    let listedReceipt: string | undefined
    try {
      execFileSync(
        PLAYWRIGHT,
        ['test', '--config', 'e2e/playwright.config.ts', '--list'],
        {
          cwd: PARITY_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 32 * 1024 * 1024
        }
      )
      listedReceipt = readFileSync(receiptPath, 'utf8')
    } finally {
      // A failing implementation must not leave committed evidence modified
      if (readFileSync(receiptPath, 'utf8') !== original) {
        writeFileSync(receiptPath, original)
      }
    }

    expect(listedReceipt).toBe(original)
  })
})
