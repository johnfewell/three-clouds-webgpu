// Plain .mjs + .d.mts, the convention captureLinear.mjs names
export interface LockfileResult {
  ok: boolean
  failures: string[]
}
export declare function parseImporters(
  lockfileText: string
): Map<string, Map<string, string>>
export declare function manifestSpecifiers(pkgJson: {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}): Map<string, string>
export declare function parseOverrides(text: string): Map<string, string>
export declare function workspaceOverrides(root: string): Record<string, string>
export declare function workspaceManifests(root: string): string[]
export declare function checkLockfileManifests(root?: string): LockfileResult
