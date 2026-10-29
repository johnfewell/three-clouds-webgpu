// `convergence()` returns a probe field the LAST renderOnce wrote,
// and the capture read it AFTER the shaded-fraction receipt's four renders,
// so metrics.json described the receipt's render. Latent while every case
// declares warmup 64, because the receipt then landed nearby
// These read the capture's source, so no browser is needed
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CAPTURE = resolve(import.meta.dirname, '../scripts/capture.mjs')

function captureSource(): string {
  return readFileSync(CAPTURE, 'utf8')
}

/**
 * A stand-in for the page probe, with the one property that matters: the
 * convergence field is overwritten by every renderOnce, exactly as
 * main.ts's `convergence` object is
 */
function fakeProbe() {
  const field = { A: null as number | null, B: null as number | null }
  return {
    field,
    convergence: () => ({ A: field.A, B: field.B }),
    /** a renderOnce leaves behind the value its warm-up produced, per side */
    renderOnce: (side: 'A' | 'B', value: number) => {
      field[side] = value
    }
  }
}

describe('convergence describes the scored still', () => {
  it('a late read returns the receipt render, not the scored still', () => {
    const probe = fakeProbe()

    // the scored still, at the case's own warm-up
    probe.renderOnce('A', 0.52)
    probe.renderOnce('B', 0.96)
    const atStill = probe.convergence()

    // the shaded-fraction receipt then renders four more times. It runs with
    // a hard-coded warm-up, so a case that raises its own lands elsewhere
    probe.renderOnce('A', 0.00004)
    probe.renderOnce('B', 0.00004)
    const late = probe.convergence()

    expect(atStill.A).toBe(0.52)
    expect(late.A).toBe(0.00004)
    // the defect in one line: these are different numbers
    expect(late.A).not.toBe(atStill.A)
  })

  it('the capture captures at the still, so the receipt cannot clobber it', () => {
    const src = captureSource()
    const probe = fakeProbe()

    // The scored still, then the value the capture goes on to record
    // Replaying the capture's OWN order is what makes this a guard and not a
    // demonstration: these assertions go red on the old late read
    probe.renderOnce('A', 0.52)
    probe.renderOnce('B', 0.96)
    const captureIdx = src.indexOf('const convergenceNow = p.convergence()')
    const capturedAtStill = captureIdx > -1 ? probe.convergence() : null

    // the receipt's four renders, which a late read would have described
    probe.renderOnce('A', 0.00004)
    probe.renderOnce('B', 0.00004)

    expect(capturedAtStill).toEqual({ A: 0.52, B: 0.96 })
    expect(capturedAtStill).not.toEqual(probe.convergence())
  })

  it('the capture reads convergence before the receipt renders', () => {
    const src = captureSource()

    // captured inside the scored-still evaluate, right after the readbacks
    const captureIdx = src.indexOf('const convergenceNow = p.convergence()')
    expect(captureIdx, 'convergence must be captured in-page').toBeGreaterThan(
      -1
    )

    // the readback that produces the scored plate, inside the same evaluate
    const readbackIdx = src.indexOf("const linearB = await p.readLinear('B')")
    expect(readbackIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(readbackIdx)

    // the receipt setShadow renders come after it
    const receiptIdx = src.indexOf('const flagsOff = p.setShadow(false)')
    expect(receiptIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeLessThan(receiptIdx)

    // and the recorded value is the captured one, not a fresh read
    expect(src).toMatch(/const convergence = result\.convergenceNow/)
    // no bare late read of the mutable field survives
    expect(src).not.toMatch(
      /page\s*\n?\s*\.evaluate\(\(\) => window\.__parity\.convergence\(\)\)/
    )
  })

  it('the captured value rides the result object, empty-buffer path included', () => {
    const src = captureSource()
    // both return statements in the scored-still evaluate carry it, so an
    // empty readback cannot silently drop the receipt
    const returns = src.match(/convergenceNow,/g) ?? []
    expect(returns.length).toBeGreaterThanOrEqual(2)
  })
})
