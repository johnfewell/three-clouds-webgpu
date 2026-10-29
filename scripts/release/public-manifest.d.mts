// Types for public-manifest.mjs: plain JS because the exporter runs it under
// node with no transpile step, while its decisions are unit-tested from
// TypeScript. Same arrangement as export-public.mjs

/** One manifest decision: a path, and why it is in or out */
export interface ManifestEntry {
  path: string
  reason: string
}

/** Top-level paths copied into the public tree */
export const KEEP: ManifestEntry[]

/** Top-level paths left out of the public tree */
export const EXCLUDE: ManifestEntry[]

/** Second-level decisions inside docs/ */
export const DOCS_KEEP: ManifestEntry[]

/** Every docs/ path left out, each with a reason */
export const DOCS_EXCLUDE: ManifestEntry[]

/**
 * The decision for one repo-relative path.
 *
 * Throws when no entry covers the path, so a new top-level directory cannot
 * reach the public tree by being unmentioned.
 */
export function decide(path: string): {
  keep: boolean
  reason: string
  rest?: string
}

/** Every exclusion root the manifest can produce, for the report */
export function excludedRoots(): string[]
