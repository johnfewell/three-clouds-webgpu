// Types for setupAssetsArgs.mjs

export interface SetupAssetValues {
  example: string | undefined
  from: string | undefined
}

export type SetupAssetsArgsResult =
  | { ok: true; help: true; values: SetupAssetValues }
  | {
      ok: true
      help: false
      values: { example: string; from: string }
    }
  | { ok: false; help: false; argument: string; error: string }

export function parseSetupAssetsArgs(
  argv: readonly string[]
): SetupAssetsArgsResult

export function formatSetupAssetsUsage(): string
