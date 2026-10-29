// Types for the pure part of the digest gate. tsconfig has no allowJs, so its
// test reaches classify through this
export interface Verdict {
  /** Process exit code: 0 only when both passes agree the literals are current */
  code: number
  /** Verdict lines, naming the ref so a stale message says what to measure */
  lines: string[]
}

export function classify(
  mergedOk: boolean,
  refOk: boolean,
  ref: string
): Verdict

/** `git status --porcelain=v1 --untracked-files=all` in `cwd` */
export function treeStatus(cwd: string): string

/** Check out the ref's src/ and return the paths that exist only on the ref */
export function swapToRef(ref: string, cwd: string): string[]

/** src/ back to HEAD, with every ref-only path unstaged and deleted */
export function restoreFromHead(refOnly: string[], cwd: string): void
