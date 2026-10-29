export declare const PLAYWRIGHT_DEFAULT_ENABLE_FEATURES: readonly string[]

export declare function chromiumLaunchOptions(
  args: readonly string[],
  features: readonly string[],
  env?: Record<string, string | undefined>
): { args: string[]; ignoreDefaultArgs: string[] }
