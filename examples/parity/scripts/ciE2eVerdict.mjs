#!/usr/bin/env node
// report the committed e2e receipt's verdict for THIS
// tree, never folded into a green. CI cannot boot the suite, so verification
// is a bench receipt (ADR-011 A5). green = verified, red = real failures (exit
// 1), stale/missing/dirty/partial = UNVERIFIED: warned, never a pass, and not
// failed either, since a permanently red CI signal gets ignored
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { e2eInputsKey, e2eReceiptVerdict } from './freshBuild.mjs'

// PARITY_REPO_ROOT overrides the root so a test can point at a fixture repo
// instead of MUTATING the tracked receipt: an in-place edit dirtied the tree
// for every other test that snapshots git status, and for good if the run died
const ROOT =
  process.env.PARITY_REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..')

/**
 * The COMMITTED receipt, read from git rather than the working tree.
 *
 * CI run 33557499792: the suite's own reporter had already overwritten the
 * working-tree receipt with CI's SwiftShader run, which this then "reported".
 * Reading HEAD is what "the committed receipt" means, immune to step order.
 */
function readCommittedReceipt(root) {
  try {
    const raw = execFileSync(
      'git',
      ['show', 'HEAD:parity/results/e2e-receipt.json'],
      { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return JSON.parse(raw)
  } catch {
    // No committed receipt, or git cannot answer. Null flows into
    // e2eReceiptVerdict as `missing`, which is not a pass
    return null
  }
}

/** GitHub Actions annotation, or a plain line when run locally */
function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::${level}::${message}`)
  } else {
    console.log(`[${level}] ${message}`)
  }
}

export function reportVerdict(verdict, key) {
  const inputs = key == null ? 'unknown' : key.slice(0, 12)
  const banner = [
    '',
    '='.repeat(72),
    `  e2e VERDICT FOR THIS TREE (inputs ${inputs}): ${verdict.status.toUpperCase()}`,
    `  ${verdict.detail}`,
    '='.repeat(72),
    ''
  ].join('\n')
  console.log(banner)

  if (verdict.status === 'green') {
    annotate(
      'notice',
      `e2e receipt is GREEN for this tree (${inputs}) — verified on bench hardware.`
    )
    return 0
  }

  if (verdict.status === 'red') {
    annotate(
      'error',
      `e2e receipt records FAILURES for this tree (${inputs}): ${verdict.detail}`
    )
    return 1
  }

  // stale / missing / dirty / partial: not a pass, not this commit's fault
  annotate(
    'warning',
    `e2e is UNVERIFIED for this tree (${inputs}): ${verdict.detail}. ` +
      `CI cannot run the harness (software rasteriser), so verification is a ` +
      `bench run recording a receipt. A green e2e job does NOT mean e2e passed.`
  )
  return 0
}

function main() {
  const key = e2eInputsKey(ROOT)
  const receipt = readCommittedReceipt(ROOT)
  const verdict = e2eReceiptVerdict(receipt, key)
  process.exit(reportVerdict(verdict, key))
}

if (process.argv[1] === import.meta.filename) {
  main()
}
