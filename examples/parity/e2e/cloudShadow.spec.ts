import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { expect, type Page } from '@playwright/test'

import { loadCase, test } from './pageLoad'
import type { ParityWindow } from './parityProbe'

// the public cloudShadow, proved on pixels. A ground patch is drawn
// with `cloudsPass.cloudShadowAt(positionWorld)` and nothing else, so each
// texel IS the 0..1 transmittance a water or vegetation material multiplies by

interface ProbePixels {
  width: number
  height: number
  data: number[]
  min: number
  max: number
  mean: number
  shadowedFraction: number
}

// A greyscale PNG, so the probe can be LOOKED at, not only asserted on
// zlib and the four chunks are the whole format, no image dependency
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, Buffer.from(body), crc])
}

function grayscalePng(width: number, height: number, values: number[]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  // 8 = bit depth, 0 = greyscale
  ihdr[8] = 8
  ihdr[9] = 0
  // One filter byte per row, filter 0 (none): the point is the values
  const raw = Buffer.alloc(height * (1 + width))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const v = values[y * width + x] ?? 0
      raw[row + 1 + x] = Math.max(0, Math.min(255, Math.round(v * 255)))
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array())
  ])
}

function readProbe(page: Page): Promise<ProbePixels> {
  return page.evaluate(async () => {
    const p = (window as ParityWindow).__parity
    const r = await p.readCloudShadowProbe()
    return { ...r, data: Array.from(r.data) }
  })
}

test.describe('public cloudShadow on a material', () => {
  // Short on purpose. The boot is the expensive part and a stalled page must
  // fail here rather than sit on the fleet's one GPU
  test.setTimeout(240_000)

  test('a material darkens under a cloud and not in the open', async ({
    page
  }) => {
    // The same filter the p0 gate sweep uses (gates.spec.ts:72): a bare 404 or a
    // favicon request is harness noise, and a shadow probe that reports it as a
    // failure would be measuring the page, not the shadow
    const errors: string[] = []
    page.on('console', m => {
      if (m.type() !== 'error') return
      if (/favicon|404 \(Not Found\)/.test(m.text())) return
      errors.push(m.text())
    })
    page.on('pageerror', e => errors.push(String(e)))

    // shadow-plane: shadows on, low sun, the atlas the graded plate uses
    await loadCase(page, 'shadow-plane', { w: '641', h: '361' })
    await page.waitForFunction(
      () => (window as ParityWindow).__parity?.sideBHandle != null
    )

    const cast = await readProbe(page)
    // The control arm: the same patch and material, the casters off. Without
    // it a patch that is dark everywhere would pass arm one
    const noCasters = await page.evaluate(async () => {
      const p = (window as ParityWindow).__parity
      const ctx = p.sideBHandle!.cloudsContext
      for (const layer of ctx.cloudLayers) layer.shadow = false
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 24,
        resetHistory: true
      })
      const off = await p.readCloudShadowProbe()
      for (const layer of ctx.cloudLayers) layer.shadow = true
      await p.renderOnce('B', {
        time: 0,
        frame: 0,
        warmup: 24,
        resetHistory: true
      })
      const { min, max, mean } = off
      return { min, max, mean }
    })

    // The shadowed arm as an image, so the pattern can be looked at
    const outDir = 'test-results/e2e'
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      `${outDir}/cloudShadow-cast.png`,
      grayscalePng(cast.width, cast.height, cast.data)
    )

    console.log(
      '[cloudShadow]',
      JSON.stringify({
        cast: {
          min: cast.min,
          max: cast.max,
          mean: cast.mean,
          shadowedFraction: cast.shadowedFraction
        },
        noCasters,
        errors
      })
    )

    // 0..1 and finite: a material multiplying by this must not invert or NaN
    expect(
      cast.data.every(v => Number.isFinite(v) && v >= 0 && v <= 1),
      'the probe returned a value outside 0..1'
    ).toBe(true)
    // The patch is not a flat wash, so the shadow varies over it. At this pose
    // the anchor's 30 km sits under ONE cloud (measured 99.8 % of its texels),
    // so the unshadowed half of the claim is carried by the control arm below
    expect(
      cast.max - cast.min,
      'the patch is uniform: either all shadow or none'
    ).toBeGreaterThan(0.25)
    // Under a cloud, deeply
    expect(cast.min, 'no texel of the patch is in shadow').toBeLessThan(0.6)
    // A real fraction of it, not everything and not nothing
    expect(cast.shadowedFraction).toBeGreaterThan(0.02)
    // THE CONTROL: no casters, same patch, lit end to end and brighter than
    // every texel of the shadowed arm, so the cloud shadow darkened it
    // RELATIVE numbers: the sampler averages a texel's whole column
    expect(
      noCasters.min,
      'the patch is dark with the casters OFF, so the cloud shadow is not what darkened it'
    ).toBeGreaterThan(cast.max)
    expect(noCasters.max - noCasters.min).toBeLessThan(0.02)

    expect(errors).toEqual([])
  })
})
