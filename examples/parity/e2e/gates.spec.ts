import { expect, type Page } from '@playwright/test'

import { loadCase, PageLoadTimeoutError, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// Runtime gate: every case up to the current
// phase must render side B with ZERO console errors and a non-empty cloud
// layer, catching what unit snapshots miss. Hardware only, not SwiftShader.

const gpuMode =
  process.env.PARITY_GPU ?? (process.env.CI ? 'software' : 'hardware')
const HARDWARE = gpuMode === 'hardware'

interface CaseInfo {
  name: string
  phase: number
  scene: string
  lookOnly: boolean
}

async function listCases(page: Page): Promise<{
  cases: CaseInfo[]
  currentPhase: number
}> {
  await page.goto('/?e2e=1')
  const cases = (await page.evaluate(async () => {
    // A Vite-served URL resolved at run time, typed at the boundary
    // @ts-expect-error runtime URL import, no static module to resolve
    const mod = (await import('/cases/index.ts')) as {
      cases: Array<{
        name: string
        phase: number
        scene: string
        lookOnly?: boolean
      }>
    }
    return mod.cases.map(c => ({
      name: c.name,
      phase: c.phase,
      scene: c.scene,
      lookOnly: c.lookOnly ?? false
    }))
  })) as CaseInfo[]
  const grid = (await (
    await page.request.get('/api/grid-data.json')
  ).json()) as {
    currentPhase: number
  }
  return { cases, currentPhase: grid.currentPhase }
}

test.describe('gates: console-clean sweep', () => {
  // ~4 s per case on hardware, and the 60 s default would cut the sweep short
  test.describe.configure({ timeout: 20 * 60_000 })
  test.skip(!HARDWARE, 'hardware-only gate (PARITY_GPU=hardware)')

  test('p0 gate: every case ≤ current phase renders side B with zero console errors', async ({
    page
  }) => {
    test.setTimeout(20 * 60_000)
    const { cases, currentPhase } = await listCases(page)
    const targets = cases.filter(
      c => c.phase <= currentPhase && c.scene === 'synthetic' && !c.lookOnly
    )
    expect(targets.length).toBeGreaterThan(0)

    const failures: string[] = []
    for (const c of targets) {
      const consoleErrors: string[] = []
      const onConsole = (m: { type: () => string; text: () => string }) => {
        const text = m.text()
        if (m.type() !== 'error') return
        if (/favicon|404 \(Not Found\)/.test(text)) return
        consoleErrors.push(text.slice(0, 160))
      }
      page.on('console', onConsole)
      page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
      try {
        // The sweep's old { timeout: 40_000 } sat in waitForFunction's argument
        // slot and never applied. The effective bound, the test timeout, is
        // kept
        await loadCase(page, c.name)
        const stats = await page.evaluate(async () => {
          const p = (window as ParityWindow).__parity
          // build the linear pipeline once, then render
          await p.readLinear('B')
          await p.renderOnce('B', { time: 0, frame: 0, warmup: 4 })
          const layer = await p.readLayer()
          let cloudPx = 0
          for (let i = 3; i < layer.data.length; i += 4) {
            if (layer.data[i]! > 0.01) cloudPx++
          }
          return { cloudPx, total: layer.data.length / 4 }
        })
        const errors = [...new Set(consoleErrors)]
        if (errors.length > 0) {
          failures.push(
            `${c.name}: ${errors.length} console error(s): ${errors[0]}`
          )
        }
        if (stats.cloudPx === 0) {
          failures.push(
            `${c.name}: side B marched no clouds (0/${stats.total} layer px)`
          )
        }
        console.log(
          `[gate] ${c.name}: errors=${errors.length} cloudPx=${stats.cloudPx}/${stats.total}`
        )
      } catch (error) {
        // A page-load timeout keeps its whole diagnostic summary
        failures.push(
          error instanceof PageLoadTimeoutError
            ? `${c.name}: ${error.message}`
            : `${c.name}: ${String(error).slice(0, 160)}`
        )
      } finally {
        page.off('console', onConsole)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
