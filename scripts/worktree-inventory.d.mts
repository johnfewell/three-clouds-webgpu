// Types for worktree-inventory.mjs: plain JS because it is a node CLI, while
// its pure helpers are unit-tested from TypeScript. Same arrangement as
// verify-results.mjs
export interface WorktreeRecord {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  prunable: boolean
}

export interface InventoryRow extends WorktreeRecord {
  name: string
  dirty: number | null
  ageDays: number | null
  mergedIntoBase: boolean | null
}

/** Days after which a tree's HEAD is called out as possibly abandoned */
export const STALE_DAYS: number

export function parseWorktreeList(text: string): WorktreeRecord[]

/** null when git cannot say, which is NOT the same as "recent" */
export function ageInDays(
  root: string,
  sha: string | null,
  deps?: { cwd?: string }
): number | null

/**
 * the ref a tree is graded against. `origin/main`, falling back to
 * `main` only when no remote ref exists. The local branch is NOT the default:
 * Development branches from origin/main, so a local main trails it
 */
export function defaultBase(root: string, deps?: { cwd?: string }): string

/** null when undecidable, which is NOT a yes */
export function isMergedInto(
  root: string,
  head: string | null,
  base: string,
  deps?: { cwd?: string }
): boolean | null

/** Read-only by construction: every git call is a query */
export function inventory(
  root: string,
  options?: { base?: string; deps?: { cwd?: string } }
): InventoryRow[]

/** Reports what a removal would cost, and never says a tree is safe to delete */
export function renderInventory(rows: InventoryRow[], base?: string): string

export function run(root: string, options?: { base?: string }): number
