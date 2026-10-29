export interface PublicationFile {
  path: string
  surface: string
  bytes: Buffer
}
export interface ScanHit {
  path: string
  surface: string
  class: string
  line: number
  sha256: string
}
export interface Approval {
  path: string
  surface: string
  class: string
  match: string
  count: number
  reason: string
  approvedBy: string
  approvedAt: string
}
export function digest(bytes: string | Buffer): string
export function archiveMembers(bytes: Buffer): { path: string; bytes: Buffer }[]
export function publicationFiles(
  root: string,
  surface?: string
): PublicationFile[]
export function scanPublicFiles(
  entries: PublicationFile[],
  allowlist?: Approval[],
  options?: { publicToken?: string }
): {
  manifestSha256: string
  surfaceManifests: Record<string, string>
  files: number
  bytes: number
  binaries: { path: string; surface: string; sha256: string }[]
  hits: ScanHit[]
  unapproved: ScanHit[]
  allowlistErrors: {
    path: string
    class: string
    expected: number
    actual: number
  }[]
  publicClientTokenSha256: string | null
}
