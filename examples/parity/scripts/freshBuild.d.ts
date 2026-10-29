// Types for freshBuild.mjs: plain JS because capture.mjs (a node script) and
// the e2e gate (TypeScript) both consume it, and one implementation is the
// point
export const BUILD_COMMAND: string
export const TYPECHECK_COMMAND: string
export function findRepoRoot(startDir: string): string | null
export interface E2eReceipt {
  key: string
  filtered?: boolean
  dirty?: boolean
  tests?: Array<{ spec: string; title: string; status: string }>
  /** which bytes the dev server actually served */
  build?: {
    builtRoot: string
    servedRoot: string | null
    builtSharedSha256: string
    servedSharedSha256: string | null
    servedIsBuilt: boolean
    /** e2e input key stamped when the built bytes were produced */
    builtFromKey?: string | null
    error: string | null
  }
}
export type E2eReceiptStatus =
  'green' | 'red' | 'stale' | 'missing' | 'dirty' | 'partial'
export const E2E_RECEIPT_PATH: string

/**
 * the e2e receipt's KEY, a hash of the working-tree
 * contents of the inputs an e2e run depends on (Amendment 5). Exported so the
 * CI reporter and ensureFreshBuild share ONE definition instead of a second
 * copy of the hash command. Returns null when git cannot answer, which is not
 * a green.
 */
export function e2eInputsKey(root: string): string | null
export function e2eReceiptVerdict(
  receipt: E2eReceipt | null,
  key: string | null
): { status: E2eReceiptStatus; detail: string }
export function readE2eReceipt(
  root: string,
  read?: (path: string) => string
): E2eReceipt | null
export interface EnsureFreshBuildOptions {
  startDir?: string
  run?: (command: string, options: { cwd: string }) => unknown
  log?: (message: string) => void
  env?: Record<string, string | undefined>
  /** Opt-in: captures require a green e2e receipt, the e2e runner must NOT */
  requireGreenE2e?: boolean
  readReceipt?: (root: string) => E2eReceipt | null
  inputsKey?: (root: string) => string | null
}
export function ensureFreshBuild(
  label: string,
  options?: EnsureFreshBuildOptions
): { built: boolean; typechecked: boolean; reason: string; root?: string }
