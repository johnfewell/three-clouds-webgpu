import { expect } from '@playwright/test'

import type * as CloudsIntegration from '../src/e2eSupport/cloudsIntegration'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'clouds-integration')
})

test('manual and helper compositions agree with changing live inputs', async ({
  page
}) => {
  test.setTimeout(180_000)
  await loadCase(page, 'baseline-medium', { w: '320', h: '180' })
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/e2eSupport/cloudsIntegration.ts'
    const { compareCloudsIntegration } = (await import(
      moduleUrl
    )) as typeof CloudsIntegration
    return compareCloudsIntegration((window as ParityWindow).__parity)
  })
  console.log('[clouds-integration]', JSON.stringify(result))
  expect(result.atmosphereLutCompleted).toBe(true)
  expect(result.errors).toEqual([])
  expect(result.results.map(value => value.label)).toEqual([
    'static',
    'camera',
    'world',
    'sun',
    'shadow',
    'clouds-disabled'
  ])
  for (const pair of result.results) {
    expect(pair.samples, pair.label).toBe(320 * 180 * 3)
    expect(pair.mean, pair.label).toBeGreaterThan(0.001)
    expect(pair.maximum - pair.minimum, pair.label).toBeGreaterThan(0.001)
    expect(pair.maximumDifference, pair.label).toBeLessThanOrEqual(0.001)
  }
  for (const label of ['camera', 'world', 'sun', 'clouds-disabled']) {
    const pair = result.results.find(value => value.label === label)!
    expect(pair.changeFromPrevious, label).toBeGreaterThan(0.00001)
  }
  expect(result.diagnostics.readiness.configuration).toBe('valid')
  expect(result.diagnostics.readiness.graph).toBe('unobserved')
})
