// The basic example's sky at its shipped pose, measured rather than eyeballed
// Unbound `atmosphere.camera` integrates the sky from the Earth's
// centre along a view-space ray: 34.5% of the sky band below 0.002 luminance,
// minimum exactly 0. Bound: 0 of 184800, minimum 0.159. The CPU half of this
// guard is test/exampleWiring.test.ts, which audits the binding itself

import { expect, type Page } from '@playwright/test'

import { test } from './pageLoad'

// The config owns the port: it probes a free one per run, so a
// literal here would send this spec to whatever is on 5199, which is how a run
// graded another worktree's sky in the first place
const BASIC_URL = process.env.PARITY_BASIC_URL ?? 'http://localhost:5199/'
const WARMUP_MS = 9000
// A dev server on the basic port running anything else would pass a
// mean-luminance check, and basic's title is the marker
const TITLE = 'basic example'
// The top quarter of the frame: above the horizon at 2.5 km looking level, so
// every pixel in it is sky and none of it is the deck
const SKY_TOP = 0.25
const SKY_BOTTOM = 0.04
// Below this a pixel is the black wedge. The measured values are 0 and 0.159,
// so the threshold sits two orders of magnitude below the fixed frame and three
// orders above a rounding error, and cannot be straddled by exposure
const NEAR_BLACK = 0.002
const NEAR_BLACK_FRACTION = 0.01

interface Sky {
  pixels: number
  nearBlack: number
  min: number
  mean: number
  /** The worst per-column mean horizontal step, over the median column's */
  worstColumnStep: number
  medianColumnStep: number
}

/**
 * Luminance stats over the sky band, decoded from a screenshot: drawImage of a
 * WebGPU canvas reads black, which is the p4 basic smoke's own note
 */
async function readSky(page: Page): Promise<Sky> {
  const png = await page.locator('canvas').screenshot()
  await test.info().attach('basic-sky', { body: png, contentType: 'image/png' })
  return page.evaluate(
    async ({ encoded, top, bottom, nearBlack }) => {
      const image = new Image()
      image.src = 'data:image/png;base64,' + encoded
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      const { width: w, height: h } = canvas
      const data = ctx.getImageData(0, 0, w, h).data
      const lum = new Float32Array(w * h)
      for (let i = 0; i < w * h; i++) {
        lum[i] =
          (0.2126 * data[i * 4]! +
            0.7152 * data[i * 4 + 1]! +
            0.0722 * data[i * 4 + 2]!) /
          255
      }
      // top is the band's upper edge in frame fractions, so y0 < y1. Getting
      // this pair the wrong way round measures ZERO pixels, and a count of zero
      // near-black pixels out of zero measured passes everything below
      const y0 = Math.floor(h * bottom)
      const y1 = Math.floor(h * top)
      let count = 0
      let black = 0
      let min = 1
      let sum = 0
      const colStep: number[] = []
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const v = lum[y * w + x]!
          ++count
          sum += v
          if (v < nearBlack) ++black
          if (v < min) min = v
        }
      }
      // A hard vertical seam is one column stepping, repeated down the band, so
      // the per-column mean step is the shape to grade and the median is the
      // texture floor it has to clear
      for (let x = 1; x < w; x++) {
        let s = 0
        for (let y = y0; y < y1; y++) {
          s += Math.abs(lum[y * w + x]! - lum[y * w + x - 1]!)
        }
        colStep.push(s / (y1 - y0))
      }
      const sorted = [...colStep].sort((a, b) => a - b)
      return {
        pixels: count,
        nearBlack: black,
        min: +min.toFixed(5),
        mean: +(sum / count).toFixed(5),
        worstColumnStep: +sorted[sorted.length - 1]!.toFixed(5),
        medianColumnStep: +sorted[Math.floor(sorted.length / 2)]!.toFixed(5)
      }
    },
    {
      encoded: png.toString('base64'),
      top: SKY_TOP,
      bottom: SKY_BOTTOM,
      nearBlack: NEAR_BLACK
    }
  )
}

/**
 * The example source the dev server is actually serving. Several worktrees run
 * examples/basic on :5199 and playwright's `reuseExistingServer` takes
 * whichever answers first, so without this the guard grades another agent's
 * tree and reports its sky as ours
 */
async function readServedExample(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/src/main.ts')
    return response.ok ? response.text() : ''
  })
}

test.describe('examples/basic renders a sky', () => {
  test('no wedge: the sky band has no near-black region', async ({ page }) => {
    const errors: string[] = []
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', e => errors.push(String(e)))

    await page.goto(BASIC_URL)
    expect(await page.title()).toContain(TITLE)
    // Which TREE answered is settled outside this spec: 5199 is shared, so a
    // run that must be its own sets PARITY_BASIC_URL to a port it started
    // Comments cannot mark it: vite serves TRANSFORMED modules, comments gone
    const served = await readServedExample(page)
    expect(
      served.length,
      `${BASIC_URL} served no module, so there is nothing to grade`
    ).toBeGreaterThan(1000)
    expect(
      served.includes('atmosphere.camera = camera'),
      `${BASIC_URL} does not bind the atmosphere camera. Either the tree that ` +
        `server belongs to is unfixed, or another worktree's examples/basic is ` +
        `answering on this port`
    ).toBe(true)
    await page.waitForSelector('canvas', { timeout: 30_000 })
    // The example advances time per frame and the temporal resolve needs
    // frames, so the read is after a settled window rather than at load
    await page.waitForTimeout(WARMUP_MS)

    const sky = await readSky(page)
    // The served module's length is the provenance record: the two assertions
    // above passed, so this source is a fixed tree, and the length pins which
    console.log('[basic sky]', {
      served: `${BASIC_URL} ${served.length}B`,
      ...sky
    })
    expect(errors, 'examples/basic logged console errors').toEqual([])
    // A measurement over zero inputs is a failed measurement, not a pass: an
    // empty band would report 0 near-black pixels out of 0 and clear every
    // threshold below
    expect(
      sky.pixels,
      'the sky band measured no pixels, so every threshold below is vacuous'
    ).toBeGreaterThan(1000)
    expect(
      sky.nearBlack / sky.pixels,
      `near-black sky pixels ${sky.nearBlack}/${sky.pixels} at min ` +
        `${sky.min}: the atmosphere has no camera, so half the sky is the ` +
        `black side of the wedge`
    ).toBeLessThan(NEAR_BLACK_FRACTION)
    expect(sky.min, 'the darkest sky pixel is black').toBeGreaterThan(
      NEAR_BLACK
    )
    // The seam metric, kept as a second shape: a wedge whose lit side happens to
    // be brighter than NEAR_BLACK everywhere would pass the count above
    expect(
      sky.worstColumnStep,
      `the worst sky column steps ${sky.worstColumnStep} against a median of ` +
        `${sky.medianColumnStep}, which is a vertical seam`
    ).toBeLessThan(sky.medianColumnStep * 8)
  })
})
