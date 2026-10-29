// Chromium launch options with ONE --enable-features switch: Chrome keeps one
// value per switch, so Playwright's own switch plus ours silently dropped a
// feature list. Playwright's default is dropped through ignoreDefaultArgs and
// a single switch carries both lists

/**
 * The features Playwright's default Chromium switch enables. chromeFlags.test.ts
 * checks this against the installed playwright-core, so an upgrade that changes
 * the default fails the test instead of being dropped again.
 */
export const PLAYWRIGHT_DEFAULT_ENABLE_FEATURES = Object.freeze([
  'CDPScreenshotNewSurface'
])

/**
 * @param {readonly string[]} args switches other than --enable-features
 * @param {readonly string[]} features features to enable
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ args: string[], ignoreDefaultArgs: string[] }}
 */
export function chromiumLaunchOptions(args, features, env = process.env) {
  if (args.some(a => a.startsWith('--enable-features'))) {
    throw new Error('pass features through the features list, not args')
  }
  // Playwright omits its switch when PLAYWRIGHT_LEGACY_SCREENSHOT is set
  const defaults = env.PLAYWRIGHT_LEGACY_SCREENSHOT
    ? []
    : [...PLAYWRIGHT_DEFAULT_ENABLE_FEATURES]
  const merged = [...new Set([...defaults, ...features])]
  return {
    args: [
      ...args,
      ...(merged.length > 0 ? [`--enable-features=${merged.join(',')}`] : [])
    ],
    ignoreDefaultArgs:
      defaults.length > 0 ? [`--enable-features=${defaults.join(',')}`] : []
  }
}
