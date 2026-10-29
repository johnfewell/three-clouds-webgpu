import { expect } from '@playwright/test'

import type * as SceneDepthRebinding from '../src/e2eSupport/sceneDepthRebinding'
import { requireBootedHarness } from './harnessGate'
import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'scene-depth-rebinding')
})

test('scene-depth replacement changes occlusion without replacing the pass', async ({
  page
}) => {
  test.setTimeout(120_000)
  await loadCase(page, 'inside-deck', { w: '320', h: '180' })
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/e2eSupport/sceneDepthRebinding.ts'
    const { measureSceneDepthRebinding } = (await import(
      moduleUrl
    )) as typeof SceneDepthRebinding
    return measureSceneDepthRebinding((window as ParityWindow).__parity)
  })
  console.log('[scene-depth-rebinding]', JSON.stringify(result))
  expect(result.errors).toEqual([])
  expect(result.stablePass).toBe(true)
  expect(result.measurements).toHaveLength(7)
  const opacity = (label: string): number => {
    const sample = result.measurements.find(value => value.label === label)
    expect(sample, `missing ${label} reading`).toBeDefined()
    return sample!.opacity
  }
  expect(opacity('far')).toBeGreaterThan(0.01)
  expect(opacity('near')).toBeLessThan(opacity('far') * 0.01)
  expect(opacity('near-from-null')).toBeLessThan(opacity('far') * 0.01)
  expect(opacity('far-again')).toBeCloseTo(opacity('far'), 4)
  expect(opacity('null')).toBeCloseTo(opacity('far'), 4)
  expect(opacity('original-again')).toBeCloseTo(opacity('original'), 4)
})
