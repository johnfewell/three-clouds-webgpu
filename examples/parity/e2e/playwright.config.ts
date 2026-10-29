import { defineConfig, devices } from '@playwright/test'

import { chromiumLaunchOptions } from '../src/e2eSupport/chromeFlags.mjs'
import {
  portOf,
  resolveE2eOrigins,
  SERVED_PACKAGES,
  SERVED_URL_VARS
} from '../src/e2eSupport/e2ePorts'

const isCI = !!process.env.CI
const gpuMode = process.env.PARITY_GPU ?? (isCI ? 'software' : 'hardware')
const isSoftware = gpuMode === 'software'

// One --enable-features switch: a second one silently replaced Playwright's
// own
const webGPULaunch = chromiumLaunchOptions(
  [
    '--enable-unsafe-webgpu',
    ...(isSoftware
      ? [
          '--use-vulkan=swiftshader',
          '--use-angle=swiftshader',
          '--ignore-gpu-blocklist'
        ]
      : [])
  ],
  ['Vulkan']
)

// Resolved at config LOAD and published in the environment, so the workers
// (which re-read this config), the specs and the served-tree gate all read ONE
// value. The URLs are assigned, not defaulted: one already set is an INPUT
const { origins, sources } = await resolveE2eOrigins(process.env)
SERVED_URL_VARS.forEach((name, i) => {
  process.env[name] = origins[SERVED_PACKAGES[i]!] ?? ''
})

const base = process.env.PARITY_HARNESS_URL

// Logged at config load, not in a test: a reader needs to know which port
// answers BEFORE a failure names one. The source is named too, because a run on
// inherited ports and a run on probed ones fail for different reasons
console.log(
  `[e2e] origins: ${SERVED_PACKAGES.map(
    pkg => `${pkg} ${origins[pkg]} (${sources[pkg]})`
  ).join(', ')}`
)

// Playwright empties outputDir every run, deleting the last failure's trace, so
// each run gets its own folder. The id is set once here and reaches the
// workers (which re-read this config) through the inherited environment
process.env.PARITY_E2E_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-')

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    // Writes the SHA-keyed, per-test receipt the capture gate reads, so a red
    // suite blocks a capture the way a red typecheck does
    ['./receiptReporter.ts'],
    ['junit', { outputFile: '../../../test-results/e2e/junit.xml' }],
    [
      'html',
      { outputFolder: '../../../test-results/e2e-report', open: 'never' }
    ]
  ],
  outputDir: `../../../test-results/e2e/runs/${process.env.PARITY_E2E_RUN_ID}`,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    baseURL: base
  },
  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...(isSoftware
          ? { ...devices['Desktop Chrome'], headless: true }
          : { channel: 'chrome', headless: false }),
        launchOptions: webGPULaunch
      }
    }
  ],
  // reuseExistingServer is false in all modes and strictPort avoids
  // port walk, trailing --port overrides literals, and basic/r3f run dev
  webServer: [
    {
      command: isCI
        ? `pnpm --filter parity preview --port ${portOf(origins.parity, 'PARITY_HARNESS_URL')} --strictPort`
        : `pnpm --filter parity dev --port ${portOf(origins.parity, 'PARITY_HARNESS_URL')} --strictPort`,
      port: portOf(origins.parity, 'PARITY_HARNESS_URL'),
      reuseExistingServer: false,
      timeout: 30_000,
      cwd: '../../..'
    },
    {
      command: `pnpm --filter basic dev --port ${portOf(origins.basic, 'PARITY_BASIC_URL')} --strictPort`,
      port: portOf(origins.basic, 'PARITY_BASIC_URL'),
      reuseExistingServer: false,
      timeout: 30_000,
      cwd: '../../..'
    },
    {
      command: `pnpm --filter r3f dev --port ${portOf(origins.r3f, 'PARITY_R3F_URL')} --strictPort`,
      port: portOf(origins.r3f, 'PARITY_R3F_URL'),
      reuseExistingServer: false,
      timeout: 30_000,
      cwd: '../../..'
    }
  ],
  // Asks each server over HTTP whether THIS tree's root is inside what it
  // serves, and refuses when one is not
  globalSetup: './servedTreeGlobalSetup.ts'
})
