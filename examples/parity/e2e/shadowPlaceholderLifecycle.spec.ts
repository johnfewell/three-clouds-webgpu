import { expect } from '@playwright/test'

import type * as Lifecycle from '../src/e2eSupport/shadowPlaceholderLifecycle'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'shadow-placeholder-lifecycle')
})

test('shadow placeholder survives replacement but not pass disposal', async ({
  page
}) => {
  test.setTimeout(120_000)
  await loadCase(page, 'baseline-medium', { w: '160', h: '90' })
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/e2eSupport/shadowPlaceholderLifecycle.ts'
    const { measureShadowPlaceholderLifecycle } = (await import(
      moduleUrl
    )) as typeof Lifecycle
    return measureShadowPlaceholderLifecycle((window as ParityWindow).__parity)
  })
  console.log('[shadow-placeholder-lifecycle]', JSON.stringify(result))
  expect(result.errors).toEqual([])
  expect(result.cycles).toHaveLength(5)
  for (const cycle of result.cycles) {
    expect(cycle.uploaded).toBe(true)
    expect(cycle.replaced).toBe(true)
    expect(cycle.disposals).toBe(1)
    expect(cycle.textures).toBe(result.baseline)
  }
})
