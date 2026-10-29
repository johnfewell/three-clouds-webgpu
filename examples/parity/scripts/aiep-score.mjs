// Acceptance scorer, CLI. The logic lives in
// src/acceptance/aiepScorer.mjs so vitest collects its test. This is only the
// node entry point with the console/process use that src/ is linted against
//   node examples/parity/scripts/aiep-score.mjs --new <dir> [--old <dir>]

import { existsSync } from 'node:fs'

import {
  exitCodeFor,
  formatReport,
  scoreTree
} from '../src/acceptance/aiepScorer.mjs'

function main(argv) {
  const arg = flag => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }
  const newRoot = arg('--new')
  const oldRoot = arg('--old') ?? 'parity/results'
  if (newRoot == null) {
    console.error(
      'usage: node examples/parity/src/acceptance/aiepScorer.mjs --new <dir> [--old <dir>]'
    )
    return 2
  }
  if (!existsSync(newRoot)) {
    console.error(`--new tree does not exist: ${newRoot}`)
    return 2
  }
  const rows = scoreTree(oldRoot, newRoot)
  if (rows.length === 0) {
    // An empty comparison must not print a clean report. A tree with no cases
    // is a broken input, not a passing one (the e3b0c442 family, at the report)
    console.error(`no cases found in ${oldRoot} or ${newRoot}`)
    return 2
  }
  console.log(`aiep acceptance: old=${oldRoot} new=${newRoot}`)
  console.log(formatReport(rows))
  return exitCodeFor(rows)
}

// Unconditional: this file exists only to be run. A filename guard silently
// stopped main() after a rename, and a do-nothing CLI exits 0, which looks
// like success
process.exit(main(process.argv.slice(2)))
