import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { table } from '../../../../test/helpers/cpuTwin'
import {
  chromiumLaunchOptions,
  PLAYWRIGHT_DEFAULT_ENABLE_FEATURES
} from './chromeFlags.mjs'

const enableSwitches = (args: readonly string[]) =>
  args.filter(a => a.startsWith('--enable-features'))

describe('chromiumLaunchOptions', () => {
  it('passes exactly one --enable-features carrying both lists', () => {
    const o = chromiumLaunchOptions(['--enable-unsafe-webgpu'], ['Vulkan'], {})
    table('merged-launch', [
      {
        field: 'enable switches',
        expected: 1,
        actual: enableSwitches(o.args).length
      },
      {
        field: 'ignored defaults',
        expected: 1,
        actual: o.ignoreDefaultArgs.length
      }
    ])
    expect(enableSwitches(o.args)).toEqual([
      '--enable-features=CDPScreenshotNewSurface,Vulkan'
    ])
    expect(o.ignoreDefaultArgs).toEqual([
      '--enable-features=CDPScreenshotNewSurface'
    ])
    expect(o.args).toContain('--enable-unsafe-webgpu')
  })

  it('follows Playwright when its legacy-screenshot switch is set', () => {
    const o = chromiumLaunchOptions([], ['Vulkan'], {
      PLAYWRIGHT_LEGACY_SCREENSHOT: '1'
    })
    expect(enableSwitches(o.args)).toEqual(['--enable-features=Vulkan'])
    expect(o.ignoreDefaultArgs).toEqual([])
  })

  it('refuses a feature switch smuggled in through args', () => {
    expect(() =>
      chromiumLaunchOptions(['--enable-features=X'], [], {})
    ).toThrow(/features list/)
  })
})

describe('PLAYWRIGHT_DEFAULT_ENABLE_FEATURES', () => {
  it('matches the --enable-features switch of the installed playwright-core', () => {
    const require = createRequire(join(__dirname, '../../package.json'))
    const testPkg = require.resolve('@playwright/test/package.json')
    const corePkg = createRequire(testPkg).resolve(
      'playwright-core/package.json'
    )
    const bundle = readFileSync(
      join(dirname(corePkg), 'lib', 'coreBundle.js'),
      'utf8'
    )
    const found = [
      ...new Set(
        [...bundle.matchAll(/"--enable-features=([A-Za-z0-9,]+)"/g)].map(
          m => m[1]
        )
      )
    ]
    table('playwright-default', [
      { field: 'switch values found', expected: 1, actual: found.length }
    ])
    expect(found).toEqual([PLAYWRIGHT_DEFAULT_ENABLE_FEATURES.join(',')])
  })
})
