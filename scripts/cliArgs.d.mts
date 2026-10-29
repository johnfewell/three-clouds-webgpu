// Types for cliArgs.mjs. The module is plain .mjs so node CLIs import it
// with no transpile. This declares it for the TypeScript tests

export interface FlagSpec {
  name: string
  aliases?: readonly string[]
  takes?: string
  kind?: 'number' | 'string'
  required?: boolean
  help: string
}

export type FlagValues = Record<string, string | number | boolean | undefined>

export type ParseArgsResult =
  | { ok: true; help: boolean; values: FlagValues }
  | { ok: false; help: false; argument: string; error: string }

export function parseArgs(
  argv: readonly string[],
  flags: readonly FlagSpec[]
): ParseArgsResult

export function formatUsage(
  invocation: string,
  flags: readonly FlagSpec[]
): string
