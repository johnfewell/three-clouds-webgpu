import { expect, test } from '@playwright/test'

import { cases } from '../cases/index'

test.describe('index grid page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.grid-table')
  })

  test('renders one row per case number in the grid', async ({ page }) => {
    const numbers = await page.$$eval('.grid-table tbody tr .num-cell', cells =>
      [...new Set(cells.map(c => c.textContent?.trim()))].filter(Boolean)
    )
    // DERIVED from the registry, not hardcoded: a literal 55 went stale when
    // case 53 was retired, unnoticed since `pnpm check` runs no e2e
    // A literal is a promise to remember, the registry is the fact
    expect(numbers.length).toBe(new Set(cases.map(c => c.number)).size)
  })

  test('grid rows have status badges', async ({ page }) => {
    const badges = await page.$$eval('.grid-table tbody .status-badge', els =>
      els.map(e => e.textContent?.trim()).filter(Boolean)
    )
    expect(badges.length).toBeGreaterThan(0)
    for (const badge of badges) {
      expect(['pass', 'FAIL', 'accepted', 'not yet', 'hw-skip']).toContain(
        badge
      )
    }
  })

  test('lightbox opens on thumbnail click', async ({ page }) => {
    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toHaveCSS('display', 'none')

    const firstThumb = page.locator('.thumb-cell').first()
    await firstThumb.click()

    await expect(overlay).toHaveCSS('display', 'flex')
    await expect(page.locator('.lightbox-title')).not.toBeEmpty()
  })

  test('lightbox tabs flip A/B/diff', async ({ page }) => {
    const firstThumb = page.locator('.thumb-cell').first()
    await firstThumb.click()

    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toHaveCSS('display', 'flex')

    const img = page.locator('.lightbox-img-container img')
    const tabs = page.locator('.lightbox-tabs button')

    await tabs.nth(0).click()
    const srcA = await img.getAttribute('src')
    expect(srcA).toContain('A.png')

    await tabs.nth(1).click()
    const srcB = await img.getAttribute('src')
    expect(srcB).toContain('B.png')

    await tabs.nth(2).click()
    const srcDiff = await img.getAttribute('src')
    expect(srcDiff).toContain('diff.png')
  })

  test('arrow keys navigate lightbox tabs', async ({ page }) => {
    const firstThumb = page.locator('.thumb-cell').first()
    await firstThumb.click()

    const img = page.locator('.lightbox-img-container img')

    // Start on first tab (A), press right to go to B
    await page.locator('.lightbox-tabs button').nth(0).click()
    await page.keyboard.press('ArrowRight')
    const src = await img.getAttribute('src')
    expect(src).toContain('B.png')

    // Press right again to go to diff
    await page.keyboard.press('ArrowRight')
    const srcDiff = await img.getAttribute('src')
    expect(srcDiff).toContain('diff.png')

    // Press left to go back to B
    await page.keyboard.press('ArrowLeft')
    const srcBack = await img.getAttribute('src')
    expect(srcBack).toContain('B.png')
  })

  test('Escape closes lightbox', async ({ page }) => {
    const firstThumb = page.locator('.thumb-cell').first()
    await firstThumb.click()

    const overlay = page.locator('.lightbox-overlay')
    await expect(overlay).toHaveCSS('display', 'flex')

    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCSS('display', 'none')
  })

  test('live-twin link carries ?case=', async ({ page }) => {
    const firstThumb = page.locator('.thumb-cell').first()
    await firstThumb.click()

    const liveLink = page.locator('.lightbox-live-link')
    const href = await liveLink.getAttribute('href')
    expect(href).toMatch(/^\?case=.+/)
  })
})
