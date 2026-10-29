// Plain .mjs + .d.mts, the convention captureLinear.mjs names
export interface Waiver {
  file: string
  code: number
  anchor: string
}
export interface DiagnosticCounts {
  deny: number
  skew: number
  waived: number
  unclassified: number
}
export interface DiagnosticResult {
  ok: boolean
  failures: string[]
  counts: DiagnosticCounts
}
export declare const DENY_CODES: Map<number, string>
export declare const SKEW_CODES: Map<number, string>
export declare const WAIVERS: Waiver[]
export declare function checkProjects(
  tsconfigPaths: string[],
  waivers?: Waiver[],
  root?: string
): DiagnosticResult
export declare function preflight(root?: string): string | null
