export declare const EXIT_CASES: readonly string[]
export declare const REQUIRED_CONTROLS: Record<string, readonly string[]>

export interface CaseVerdict {
  case: string
  pass: boolean
  reasons: string[]
  compared: number
  identical: number
  skipped: string[]
  differingBytes: number
  maxDiff: number
  controls: Record<string, number>
}

export declare function caseVerdict(name: string, report: unknown): CaseVerdict
export declare const EXIT_FAULTS: readonly string[]
export interface FaultVerdict {
  fault: string
  caught: boolean
  differingBytes: number
}
export declare function faultVerdict(
  fault: string,
  report: unknown
): FaultVerdict
export declare function runVerdict(
  expectedCases: readonly string[],
  verdicts: readonly CaseVerdict[],
  faults?: readonly FaultVerdict[] | null
): { pass: boolean; missing: string[]; failed: string[]; uncaught: string[] }
export declare function formatTable(verdicts: readonly CaseVerdict[]): string
