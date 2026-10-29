// setup-assets' accepted argv. Pure, same parser as capture.
// setup-assets.mjs calls this before it creates directories or copies files
// An extra flag used to be ignored once --example and --from were present,
// and the copy ran anyway

import { formatUsage, parseArgs } from './cliArgs.mjs'

/** @type {readonly import('./cliArgs.mjs').FlagSpec[]} */
export const SETUP_ASSETS_FLAGS = [
  {
    name: 'example',
    takes: 'dir',
    kind: 'string',
    required: true,
    help: 'example directory, relative to the repo root'
  },
  {
    name: 'from',
    takes: 'package',
    kind: 'string',
    required: true,
    help: 'package whose assets/ directory is copied'
  },
  {
    name: 'help',
    aliases: ['-h'],
    help: 'print usage and exit'
  }
]

const INVOCATION = 'node scripts/setup-assets.mjs'

/**
 * @param {readonly string[]} argv arguments after the node binary and script path
 */
export function parseSetupAssetsArgs(argv) {
  const parsed = parseArgs(argv, SETUP_ASSETS_FLAGS)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    help: parsed.help,
    values: {
      example: parsed.values.example,
      from: parsed.values.from
    }
  }
}

export function formatSetupAssetsUsage() {
  return formatUsage(INVOCATION, SETUP_ASSETS_FLAGS)
}
