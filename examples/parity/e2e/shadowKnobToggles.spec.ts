import { expect } from '@playwright/test'

import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// A shadow knob toggled at runtime must not leave the shadow pass drawing
// with a pipeline built for another attachment layout: the frame that flips a
// graph-time knob still runs the old program. Hardware only

const gpuMode =
  process.env.PARITY_GPU ?? (process.env.CI ? 'software' : 'hardware')
const HARDWARE = gpuMode === 'hardware'

// Each knob is set to every value in turn, four rendered frames apiece
const SEQUENCES: Record<string, readonly (number | boolean)[]> = {
  temporalPass: [false, true, false, true],
  cascadeCount: [2, 4, 1, 3],
  mapSize: [512, 128, 256],
  updateInterval: [1, 4, 2],
  shadowRoundRobin: [true, false]
}

// Only what the probe touches, since this project carries no WebGPU types
interface ProbeDevice {
  addEventListener: (
    type: 'uncapturederror',
    listener: (event: { error: { message: string } }) => void
  ) => void
  queue: { onSubmittedWorkDone: () => Promise<void> }
}

test.describe('shadow knobs toggled at runtime', () => {
  test.skip(!HARDWARE, 'hardware-only (PARITY_GPU=hardware)')

  test('every shadow knob toggles without a GPU validation error', async ({
    page
  }) => {
    test.setTimeout(5 * 60_000)
    const consoleErrors: string[] = []
    page.on('console', m => {
      const text = m.text()
      if (m.type() === 'error' || /GPUValidationError/.test(text)) {
        if (/favicon|404 \(Not Found\)/.test(text)) return
        consoleErrors.push(text.slice(0, 200))
      }
    })
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
    await loadCase(page, 'shadow-plane')

    const rows = await page.evaluate(
      async ({ sequences }) => {
        const p = (window as ParityWindow).__parity as unknown as {
          sideBHandle: {
            renderer: { backend: { device: ProbeDevice } }
            cloudsContext: {
              frame: number
              time: number
              experimental: Record<string, boolean>
              shadow: Record<string, unknown> & {
                mapSize: { set: (x: number, y: number) => void; x: number }
              }
            }
            render: () => void
          }
        }
        const h = p.sideBHandle
        const ctx = h.cloudsContext
        const gpuErrors: string[] = []
        h.renderer.backend.device.addEventListener('uncapturederror', e => {
          gpuErrors.push(e.error.message)
        })
        let frame = 0
        const render = async (n: number) => {
          for (let i = 0; i < n; i++) {
            await new Promise(r => requestAnimationFrame(r))
            ctx.time = 0
            ctx.frame = frame++
            h.render()
          }
          await h.renderer.backend.device.queue.onSubmittedWorkDone()
        }
        const set = (knob: string, value: number | boolean): boolean => {
          if (knob === 'shadowRoundRobin') {
            if (!(knob in ctx.experimental)) return false
            ctx.experimental = { ...ctx.experimental, [knob]: value as boolean }
          } else if (knob === 'mapSize') {
            ctx.shadow.mapSize.set(value as number, value as number)
          } else {
            ctx.shadow[knob] = value
          }
          return true
        }
        await render(8)
        const out: Array<{ knob: string; value: string; gpuErrors: number }> =
          []
        for (const [knob, values] of Object.entries(sequences)) {
          for (const value of values) {
            const before = gpuErrors.length
            if (!set(knob, value)) {
              out.push({ knob, value: 'absent', gpuErrors: 0 })
              break
            }
            await render(4)
            out.push({
              knob,
              value: String(value),
              gpuErrors: gpuErrors.length - before
            })
          }
        }
        return { out, gpuErrors: gpuErrors.slice(0, 3) }
      },
      { sequences: SEQUENCES }
    )

    console.log(
      rows.out
        .map(r => `[toggle] ${r.knob}=${r.value} gpu=${r.gpuErrors}`)
        .join('\n')
    )
    expect(rows.gpuErrors, rows.gpuErrors.join('\n')).toEqual([])
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
    // Every sequence that exists on this build ran to the end
    for (const [knob, values] of Object.entries(SEQUENCES)) {
      const ran = rows.out.filter(r => r.knob === knob)
      if (ran.some(r => r.value === 'absent')) continue
      expect(ran.length, knob).toBe(values.length)
    }
  })
})
