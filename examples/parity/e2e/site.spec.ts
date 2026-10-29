import { expect, test } from '@playwright/test'

import { cases } from '../cases/index'

test.describe('static site (built)', () => {
  test('index page loads grid with one row per case number @p0', async ({
    page
  }) => {
    await page.goto('/')
    await page.waitForSelector('.grid-table', { timeout: 10_000 })

    const numbers = await page.$$eval('.grid-table tbody tr .num-cell', cells =>
      [...new Set(cells.map(c => c.textContent?.trim()))].filter(Boolean)
    )
    // DERIVED from the registry, not hardcoded: a literal 55 went stale when
    // case 53 was retired, unnoticed since `pnpm check` runs no e2e
    // A literal is a promise to remember, the registry is the fact
    expect(numbers.length).toBe(new Set(cases.map(c => c.number)).size)
  })

  test('footer shows gate numbers @p0', async ({ page }) => {
    await page.goto('/?case=baseline-medium')
    const gatesEl = page.locator('#gates')
    await expect(gatesEl).not.toBeEmpty({ timeout: 5_000 })
    const text = await gatesEl.textContent()
    expect(text).toContain('citations')
  })

  test('live page shows WebGPU notice or renders @p0', async ({ page }) => {
    await page.goto('/?case=baseline-medium')
    await page.waitForTimeout(2000)

    const caseNameEl = page.locator('#case-name')
    await expect(caseNameEl).toHaveText('baseline-medium')
  })
})
