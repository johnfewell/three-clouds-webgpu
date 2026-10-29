export const DEMO_DIST: string
export const SHOWCASE_DIST: string
export const SITE_SURFACE: string
export const RECEIPT_PROTOCOL: string

export interface BuildStep {
  name: string
  command: string
  args: string[]
  env: 'showcase' | 'demo' | null
}
export const BUILD_STEPS: readonly BuildStep[]

export interface BuildInputs {
  showcase: Record<string, string>
  demo: Record<string, string>
}
export function buildInputs(token?: string): BuildInputs

export type RunStep = (
  command: string,
  args: string[],
  env: Record<string, string>
) => void
export function buildSources(token?: string, run?: RunStep): void

export function countFiles(dir: string): number

export interface Assembled {
  files: number
  demoFiles: number
  showcaseFiles: number
}
export function assembleSite(
  demoDist: string,
  showcaseDist: string,
  out: string
): Assembled

export function readApprovals(path?: string): unknown[]

export interface SiteScan {
  ok: boolean
  result: {
    files: number
    bytes: number
    manifestSha256: string
    surfaceManifests: Record<string, string>
    unapproved: unknown[]
    allowlistErrors: unknown[]
    publicClientTokenSha256: string | null
  }
}
export function scanSite(
  out: string,
  approvals: unknown[],
  token?: string
): SiteScan

export function siteReceipt(
  out: string,
  assembled: Assembled,
  scan: SiteScan,
  extra?: Record<string, unknown>
): Record<string, unknown>
