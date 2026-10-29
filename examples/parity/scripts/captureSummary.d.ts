// Types for captureSummary.mjs: plain JS because capture.mjs (a node script)
// consumes it and the unit suite (TypeScript) pins it
export interface SummaryRow {
  case?: string
  result?: string
  reason?: string
}
/** B9: the results a row may legitimately carry */
export const RECOGNISED_RESULTS: readonly string[]
export interface RunVerdict {
  lines: string[]
  exitCode: number | undefined
  failCount: number
  skipCount: number
}
export function summarizeRun(
  rows: ReadonlyArray<SummaryRow>,
  opts?: { allowSkip?: boolean; sabotageMode?: string | null }
): RunVerdict
