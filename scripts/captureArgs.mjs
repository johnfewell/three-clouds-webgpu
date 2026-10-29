// Capture's accepted argv. Pure: no filesystem, process, or GPU.
// capture.mjs calls parseCaptureArgs before it reads thresholds or starts
// the bench. The flag table is the usage text, so keep no second list.

import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatUsage, parseArgs } from './cliArgs.mjs'

// Resolved the way capture.mjs resolves --out: relative to the project root
const PROJECT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const RESULTS_DIR = join(PROJECT_ROOT, 'parity', 'results')

/**
 * Lexically inside parity/results (the committed evidence), `..` included
 * @param {string} out
 */
function isInsideResults(out) {
  const target = isAbsolute(out) ? resolve(out) : resolve(PROJECT_ROOT, out)
  const rel = relative(RESULTS_DIR, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** @type {readonly import('./cliArgs.mjs').FlagSpec[]} */
export const CAPTURE_FLAGS = [
  {
    name: 'phase',
    takes: 'N',
    kind: 'number',
    help: 'cumulative: every case with phase <= N'
  },
  {
    name: 'only-phase',
    takes: 'N',
    kind: 'number',
    help: 'exactly the cases of phase N'
  },
  {
    name: 'case',
    takes: 'name',
    kind: 'string',
    help: 'capture only this case'
  },
  {
    name: 'sabotage',
    takes: 'exposure',
    kind: 'string',
    help: 'sabotage mode (exposure)'
  },
  {
    name: 'allow-skip',
    help: 'exit 0 when a case skips; the default is to fail the run'
  },
  {
    name: 'keep-linear',
    help: 'also write linear readbacks (never commit them)'
  },
  {
    name: 'out',
    takes: 'dir',
    kind: 'string',
    help: 'write this run under dir instead of parity/results'
  },
  {
    name: 'atmosphere-profile',
    takes: 'lookup-both|raymarch-256',
    kind: 'string',
    help: 'run with side B on this atmosphere profile (raymarch-256 is the former 256-sample pin, ADR-013 Amendment 6); requires --out outside parity/results'
  },
  {
    name: 'help',
    aliases: ['-h'],
    help: 'print usage and exit'
  }
]

const INVOCATION = 'pnpm --filter parity capture'

/**
 * @param {readonly string[]} argv arguments after the node binary and script path
 */
export function parseCaptureArgs(argv) {
  const parsed = parseArgs(argv, CAPTURE_FLAGS)
  if (!parsed.ok) return parsed
  const profile = parsed.values['atmosphere-profile']
  if (!parsed.help && profile !== undefined) {
    // eslint-disable-next-line no-comment-slop/no-trailing-comment -- an inline JSDoc type cast, not prose
    const refuse = (/** @type {string} */ error) => ({
      ok: false,
      help: false,
      argument: '--atmosphere-profile',
      error: `--atmosphere-profile ${error}`
    })
    // The two non-default capture profiles: the lookup (the harness default
    // since ADR-013 Amendment 6, so an explicit lookup-both equals it) and the
    // opt-in 256-sample raymarch that was the harness pin before it
    if (profile !== 'lookup-both' && profile !== 'raymarch-256') {
      return refuse(
        `accepts only lookup-both or raymarch-256, got ${String(profile)}`
      )
    }
    // A qualification run must never overwrite the accepted evidence set
    const out = parsed.values.out
    if (typeof out !== 'string' || isInsideResults(out)) {
      return refuse(
        'requires --out <dir> outside parity/results; a lookup run must not ' +
          'write over the committed evidence'
      )
    }
  }
  return {
    ok: true,
    help: parsed.help,
    values: {
      phaseFilter: parsed.values.phase,
      onlyPhaseFilter: parsed.values['only-phase'],
      caseFilter: parsed.values.case,
      sabotageMode: parsed.values.sabotage,
      allowSkip: parsed.values['allow-skip'] === true,
      keepLinear: parsed.values['keep-linear'] === true,
      outDirOverride: parsed.values.out,
      atmosphereProfile: profile
    }
  }
}

export function formatCaptureUsage() {
  return formatUsage(INVOCATION, CAPTURE_FLAGS)
}
