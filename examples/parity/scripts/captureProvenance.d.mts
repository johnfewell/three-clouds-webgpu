// Types for captureProvenance.mjs: plain JS because capture.mjs (a node
// script) consumes it and the unit suite (TypeScript) pins it
export const EMPTY_SHA256: string
export interface GitState {
  commit: string
  branch: string
  dirty: number
}
export interface ReceiptState {
  inputsKey: string
  verdict: string
  detail: string
  overrideArmed: boolean
}
export interface BuildDigestInfo {
  root: string
  files: string[]
  digest: string
  sharedSha256: string
}
export interface BuildProvenance {
  built: BuildDigestInfo
  served: BuildDigestInfo | null
  error: string | null
  servedIsBuilt: boolean
  builtFromKey: string | null
}
export interface ServedTreeState {
  root: string | null
  head: string | null
  error: string | null
}
export interface CaptureProvenance {
  git: GitState
  e2e: ReceiptState
  build: BuildProvenance
  /** which per-run skips were armed */
  skips: SkipState
  servedTree: ServedTreeState
}
export interface SkipState {
  build: boolean
  typecheck: boolean
}
export interface ReceiptDeps {
  inputsKey?: (root: string) => string | null
  readReceipt?: (root: string) => unknown
  verdict?: (
    receipt: unknown,
    key: string
  ) => { status: string; detail: string }
}
export function gitState(root: string): GitState
export function receiptState(
  root: string,
  env?: Record<string, string | undefined>,
  deps?: ReceiptDeps
): ReceiptState
export function captureProvenance(options: {
  projectRoot: string
  exampleRoot: string
  packageName: string
  env?: Record<string, string | undefined>
  deps?: ReceiptDeps
}): CaptureProvenance
/**
 * which per-run skips were armed. true
 * means the step was SKIPPED, so a reader never has to invert the name
 */
export function skipState(env?: Record<string, string | undefined>): SkipState
export function refuseUnlessServedIsBuilt(
  provenance: Pick<CaptureProvenance, 'build'>,
  packageName: string
): void
export function servedTreeState(
  exampleRoot: string,
  packageName: string
): ServedTreeState
export function refuseUnlessServedIsAncestor(
  provenance: Pick<CaptureProvenance, 'servedTree'>,
  shaUnderTest: string,
  projectRoot: string
): void
/** refuses unless the served tree IS this tree (identity, not lineage) */
export function refuseUnlessServedIsSelf(
  provenance: Pick<CaptureProvenance, 'servedTree'>,
  projectRoot: string
): void
export function provenanceLine(
  prefix: string,
  provenance: Omit<CaptureProvenance, 'servedTree'> &
    Partial<Pick<CaptureProvenance, 'servedTree'>>
): string
