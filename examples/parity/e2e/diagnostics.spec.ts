import { expect } from '@playwright/test'

import type * as CloudsDiagnostics from '../src/e2eSupport/cloudsDiagnostics'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'clouds-diagnostics')
})

test('cloud diagnostics distinguish live configuration from GPU readiness', async ({
  page
}) => {
  await loadCase(page, 'baseline-medium', { w: '320', h: '180' })
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/e2eSupport/cloudsDiagnostics.ts'
    const { inspectLiveCloudSetup } = (await import(
      moduleUrl
    )) as typeof CloudsDiagnostics
    return inspectLiveCloudSetup((window as ParityWindow).__parity)
  })
  console.log('[clouds-diagnostics]', JSON.stringify(result))
  expect(result.errors).toEqual([])
  expect(result.initial.readiness).toEqual({
    configuration: 'valid',
    assets: 'ready',
    graph: 'unobserved',
    frame: 'unobserved'
  })
  expect(result.initial.diagnostics).toEqual([])
  expect(result.invalid.readiness.configuration).toBe('invalid')
  expect(result.invalid.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'direction.invalid',
        severity: 'error',
        path: 'pass.cloudsContext.sunDirection',
        observed: [0, 0, 0],
        remedy: expect.stringContaining('ECEF')
      }),
      expect.objectContaining({
        code: 'provider.clouds-mismatch',
        severity: 'error',
        path: 'renderer.contextNode.value.getClouds',
        remedy: 'Return pass.cloudsContext from getClouds.'
      })
    ])
  )
  expect(result.restored).toEqual(result.initial)
  expect(result.preInit.initialized).toBe(false)
  expect(result.preInit.backendPresent).toBe(true)
  expect(result.preInit.error).toContain('await renderer.init()')
})
