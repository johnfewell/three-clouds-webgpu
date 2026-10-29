export const PROVENANCE_PATH: string
export interface FileDigest {
  sha256: string
  files: Record<string, string>
}
export interface PackProvenance {
  schemaVersion: number
  package: { name: string; version: string }
  content: FileDigest
  groups: Record<string, { count: number; sha256: string }>
  buildInputs: FileDigest
  checks: { sourceMapInputs: number; exportTargetCount: number }
  qualification: string
}
export function sha256(value: string | Buffer): string
export function fileDigest(root: string, paths: string[]): FileDigest
export function cleanTypes(root: string): void
export function verifyExports(root: string): number
export function writeProvenance(root: string): PackProvenance
export function verifyProvenance(
  root: string,
  options?: { checkBuildInputs?: boolean }
): PackProvenance
