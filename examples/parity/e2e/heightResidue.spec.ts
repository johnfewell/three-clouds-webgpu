// Height-residue invariant, STAGE: execution. A
// render must not depend on its height mod 4 (p0h3 rotated each Bayer cell's
// rows). r = mean|Δy| / mean|Δx| over the interior, on sky-horizon-low-sun
// (edges at pixel scale), must stay within R_TOLERANCE of 1280×720 on B AND A,
// A being the size-invariance control. Measured against the reverted fix:
// ```
//   side B r: 1.273 at 720 rows, 1.546 / 1.515 / 1.494 at 717 / 718 / 719
//   side A moved <= 0.016 at every size; width 1277-1279 moved <= 0.01
//   readback stride bug: +0.18 / +0.10 / +0.013 at 3 / 2 / 1 px of padding
// ```

import { expect, type Page } from '@playwright/test'

import { requireBootedHarness } from './harnessGate'
import { loadCase as loadParityCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

const CASE = 'sky-horizon-low-sun'
const BASE = { width: 1280, height: 720 }
// Residues 1, 2, 3 on each axis, one axis at a time
const SIZES = [
  { width: 1280, height: 717 },
  { width: 1280, height: 718 },
  { width: 1280, height: 719 },
  { width: 1277, height: 720 },
  { width: 1278, height: 720 },
  { width: 1279, height: 720 }
]
// The reverted fix moves r by ≥ 0.22 at every height residue, the readback
// stride moved it 0.18 at 3 px of padding, and a correct renderer moves ≤ 0.02
const R_TOLERANCE = 0.1
const WARMUP = 64

interface Readback {
  width: number
  height: number
  data: number[]
}

async function loadCase(
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await loadParityCase(page, CASE, {
    w: String(size.width),
    h: String(size.height)
  })
}

async function renderBoth(page: Page): Promise<void> {
  // The temporal upscale is the path with the Bayer phase. The registry's
  // neutralised default leaves it off, so switch it on for both sides
  await page.evaluate(() => {
    ;(window as ParityWindow).__parity.set({ temporalUpscale: true })
  })
  for (const side of ['A', 'B'] as const) {
    await page.evaluate(
      ([s, warmup]) =>
        (window as ParityWindow).__parity.renderOnce(s, {
          time: 0,
          frame: 0,
          warmup,
          resetHistory: true
        }),
      [side, WARMUP] as const
    )
  }
}

async function readLinear(page: Page, side: 'A' | 'B'): Promise<Readback> {
  return page.evaluate(async s => {
    const r = await (window as ParityWindow).__parity.readLinear(s)
    return { width: r.width, height: r.height, data: Array.from(r.data) }
  }, side)
}

function luminance(r: Readback): Float32Array {
  const { width: w, height: h, data } = r
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    lum[i] =
      0.2126 * data[i * 4]! +
      0.7152 * data[i * 4 + 1]! +
      0.0722 * data[i * 4 + 2]!
  }
  return lum
}

// mean|Δy| / mean|Δx| of luminance over the interior 10 %–90 % of the frame
function directionalRatio(r: Readback): number {
  const { width: w, height: h } = r
  const lum = luminance(r)
  const x0 = Math.floor(w * 0.1)
  const x1 = Math.floor(w * 0.9)
  const y0 = Math.floor(h * 0.1)
  const y1 = Math.floor(h * 0.9)
  let dy = 0
  let dx = 0
  let n = 0
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = y * w + x
      dy += Math.abs(lum[i + w]! - lum[i]!)
      dx += Math.abs(lum[i + 1]! - lum[i]!)
      n++
    }
  }
  return dx === 0 ? Number.POSITIVE_INFINITY : dy / n / (dx / n)
}

test.beforeAll(async ({ browser, baseURL }) => {
  await requireBootedHarness(browser, baseURL, 'heightResidue')
})

test.describe('height-residue invariant (temporal upscale, both sides)', () => {
  test('the directional statistic does not move with the size residue mod 4', async ({
    page
  }) => {
    test.setTimeout(300_000)

    const measure = async (size: {
      width: number
      height: number
    }): Promise<{ rA: number; rB: number }> => {
      await loadCase(page, size)
      await renderBoth(page)
      const A = await readLinear(page, 'A')
      const B = await readLinear(page, 'B')
      // The readback must be the requested size on both sides: rounding to
      // the Bayer grid here would hide the very class this spec exists for
      expect([A.width, A.height]).toEqual([size.width, size.height])
      expect([B.width, B.height]).toEqual([size.width, size.height])
      return { rA: directionalRatio(A), rB: directionalRatio(B) }
    }

    const base = await measure(BASE)
    console.log(
      `[heightResidue] ${BASE.width}x${BASE.height}  rA ${base.rA.toFixed(3)}  rB ${base.rB.toFixed(3)}`
    )
    const failures: string[] = []
    for (const size of SIZES) {
      const m = await measure(size)
      const tag = `${size.width}x${size.height}`
      const dA = Math.abs(m.rA - base.rA)
      const dB = Math.abs(m.rB - base.rB)
      console.log(
        `[heightResidue] ${tag}  rA ${m.rA.toFixed(3)} (Δ ${dA.toFixed(3)})  rB ${m.rB.toFixed(3)} (Δ ${dB.toFixed(3)})`
      )
      if (dA > R_TOLERANCE) failures.push(`A ${tag} Δr ${dA.toFixed(3)}`)
      if (dB > R_TOLERANCE) failures.push(`B ${tag} Δr ${dB.toFixed(3)}`)
    }
    expect(failures, 'sizes whose directional ratio moved').toEqual([])
  })
})
