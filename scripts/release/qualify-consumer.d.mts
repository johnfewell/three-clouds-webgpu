export interface ArtifactDigest {
  sha256: string
  files: Record<string, { sha256: string; bytes: number }>
}
export interface ConsumerBuild {
  base: string
  root: string
  files: ArtifactDigest
  assets: Array<{
    exportPath: string
    sha256: string
    bytes: number
    url: string
    status: number
  }>
}
export interface ConsumerRecipe {
  name: string
  root: string
  sources: ArtifactDigest
  prepared: ArtifactDigest
  installed: {
    root: string
    contentSha256: string
    files: ArtifactDigest
    build: ArtifactDigest
    types: ArtifactDigest
  }
  versions: Record<string, { requested: string; version: string; root: string }>
  isolation: { packageNames: string[]; optionalPeersAbsent: boolean }
  runtime: {
    imports: Record<string, { path: string; exports: string[] }>
    assets: Record<string, string>
  }
  compilerInputs: string[]
  compilerOptions: Record<string, unknown>
  lockfileSha256: string
  builds: ConsumerBuild[]
}
export interface ConsumerQualification {
  schemaVersion: number
  qualification: 'cpu-only'
  status: 'passed' | 'failed' | 'running'
  graph: 'unobserved'
  frame: 'unobserved'
  node: string
  runnerSha256: string
  platform: string
  arch: string
  three: ThreeRelease
  workRoot: string
  retained: boolean
  archive: {
    path: string
    originalPath: string
    sha256: string
    contentSha256: string
    bytes: number
    files: ArtifactDigest
  }
  navigation: { documents: number; localLinks: number; requiredFiles: number }
  recipes: ConsumerRecipe[]
  commands: Array<{
    cwd: string
    command: string
    args: string[]
    exitCode: number | null
    stdout: string
    stderr: string
    logSha256: string
  }>
}
export interface ThreeRelease {
  version: string
  types: string
}
export function selectThree(version?: string): ThreeRelease
export function pinRecipeThree<
  T extends {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
>(manifest: T, three: ThreeRelease): T
export function checkForkPins(
  versions: Record<
    string,
    { requested: string; version: string; override?: string }
  >,
  lockfile: string
): void
export type InventoryRefusal = 'symlink' | 'special'
export function regularFilesWithin(
  root: string,
  refuse: (kind: InventoryRefusal, path: string) => never
): string[]
export function digestFiles(root: string, paths?: string[]): ArtifactDigest
export function inspectDependencyIsolation(
  root: string,
  withoutReact: boolean
): ConsumerRecipe['isolation']
export function qualifyConsumerArchive(
  tarball: string,
  options?: { receiptPath?: string; keepProjects?: boolean; three?: string }
): Promise<ConsumerQualification>
