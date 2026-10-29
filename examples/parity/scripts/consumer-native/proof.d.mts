export interface Digest {
  sha256: string
  files: Record<string, { sha256: string; bytes: number }>
}
export interface Build {
  base: string
  root: string
  files: Digest
}
export function insist(condition: unknown, message: string): asserts condition
export function hash(bytes: string | Uint8Array): string
export function contained(root: string, path: string): boolean
export function verifyFiles(
  root: string,
  digest: Digest,
  complete?: boolean
): string
export function verifyRecipeNames(recipes: unknown): string[]
export function verifyReceipt(receipt: unknown): unknown[]
export function verifyPreparedRecipe(
  recipe: {
    name: string
    root: string
    sources: Digest
    prepared?: Digest
    installed: { root: string }
  },
  three: { version: string; types: string }
): void
export function scenarios(
  receipt: unknown
): { id: string; development: boolean }[]
export function assertHardware(
  events: Record<string, unknown>[]
): Record<string, unknown>
export function assertDevelopmentReplay(
  events: Record<string, unknown>[],
  responses: Record<string, unknown>[],
  assets: Record<string, unknown>[]
): Record<string, unknown>[]
