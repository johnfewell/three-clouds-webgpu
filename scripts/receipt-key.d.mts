// Types for receipt-key.mjs, in the shape keyPaths.d.mts / captureProvenance.d.mts
// use: the module is plain .mjs so node can run it as a CLI with no transpile
// step, and this declares it for the TypeScript consumers (its own test)

/** KEY_PATHS entries with uncommitted changes, empty when inputs are clean */
export function keyPathsDirty(root: string): string[]

/** The working tree's key. Throws if any KEY_PATH is dirty, or over 0 inputs. */
export function keyFromWorktree(root: string): { key: string; count: number }

/** A commit's key, hashed from its blobs. Throws over 0 inputs. */
export function keyFromCommit(
  root: string,
  commit: string
): { key: string; count: number }
