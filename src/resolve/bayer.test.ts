import { int, uniform } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[bayer] ${label}`)
  if (rows.length === 0) return
  const keys = Object.keys(rows[0]!)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k]).length))
  )
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join(' | ')
  console.log(header)
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  for (const row of rows) {
    console.log(
      keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' | ')
    )
  }
}

describe('bayerIndices', () => {
  it('contains exactly the integers 0–15', async () => {
    const { bayerIndices } = await import('./bayer')
    expect(bayerIndices).toHaveLength(16)
    const sorted = [...bayerIndices].sort((a, b) => a - b)
    expect(sorted).toEqual(Array.from({ length: 16 }, (_, i) => i))
  })
})

describe('bayerOffsets', () => {
  it('has 16 distinct centres in [0,1]²', async () => {
    const { bayerOffsets } = await import('./bayer')
    expect(bayerOffsets).toHaveLength(16)

    const rows: Record<string, string>[] = []
    const seen = new Set<string>()
    for (let k = 0; k < 16; k++) {
      const o = bayerOffsets[k]!
      expect(o.x).toBeGreaterThan(0)
      expect(o.x).toBeLessThan(1)
      expect(o.y).toBeGreaterThan(0)
      expect(o.y).toBeLessThan(1)
      const key = `${o.x.toFixed(4)},${o.y.toFixed(4)}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      rows.push({ k: String(k), x: o.x.toFixed(4), y: o.y.toFixed(4) })
    }
    logTable('bayerOffsets', rows)
  })
})

describe('temporal jitter table', () => {
  it('frames 0..15 visit all 16 sub-pixel offsets', async () => {
    const { bayerOffsets } = await import('./bayer')

    // Cite: CloudsMaterial.ts:339–346
    const resX = 256
    const resY = 256
    const jitters: { dx: number; dy: number }[] = []
    const uniqueOffsets = new Set<string>()

    for (let frame = 0; frame < 16; frame++) {
      const offset = bayerOffsets[frame % 16]!
      const dx = ((offset.x - 0.5) / resX) * 4
      const dy = ((offset.y - 0.5) / resY) * 4
      jitters.push({ dx, dy })
      uniqueOffsets.add(`${offset.x.toFixed(4)},${offset.y.toFixed(4)}`)
    }

    expect(uniqueOffsets.size).toBe(16)

    const rows = jitters.map((j, i) => ({
      frame: i,
      dx: j.dx.toFixed(6),
      dy: j.dy.toFixed(6),
      ox: bayerOffsets[i]!.x.toFixed(4),
      oy: bayerOffsets[i]!.y.toFixed(4)
    }))
    logTable('jitter table (256×256)', rows)
  })

  it('jitter magnitudes scale inversely with resolution', async () => {
    const { bayerOffsets } = await import('./bayer')

    for (const res of [64, 128, 512, 1024]) {
      const offset = bayerOffsets[0]!
      const dx = ((offset.x - 0.5) / res) * 4
      const dy = ((offset.y - 0.5) / res) * 4
      expect(Math.abs(dx)).toBeLessThan(4 / res)
      expect(Math.abs(dy)).toBeLessThan(4 / res)
    }
  })

  it('resolutionScale + temporalUpscale compose correctly', async () => {
    await import('./bayer')

    for (const [fullW, fullH, resScale] of [
      [1920, 1080, 1.0],
      [1920, 1080, 0.5],
      [800, 600, 0.75],
      [3840, 2160, 0.25]
    ] as [number, number, number][]) {
      const w = Math.ceil(fullW * resScale)
      const h = Math.ceil(fullH * resScale)
      const marchW = Math.ceil(w / 4)
      const marchH = Math.ceil(h / 4)
      const resW = marchW * 4
      const resH = marchH * 4
      const uvScaleX = resW / w
      const uvScaleY = resH / h

      expect(marchW * marchH).toBeLessThanOrEqual(
        Math.ceil((w * h) / 16) + w + h
      )
      expect(uvScaleX).toBeGreaterThanOrEqual(1)
      expect(uvScaleY).toBeGreaterThanOrEqual(1)
      expect(uvScaleX).toBeLessThanOrEqual(1 + 4 / w)
      expect(uvScaleY).toBeLessThanOrEqual(1 + 4 / h)
    }
  })
})

describe('1D/2D table equality', () => {
  it('bayerIndex2D(x,y) equals bayerIndices[y*4+x] for all 16 cells', async () => {
    const { bayerIndices, bayerIndex2D } = await import('./bayer')

    const rows: Record<string, string | number>[] = []
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const from1D = bayerIndices[y * 4 + x]!
        const from2D = bayerIndex2D(x, y)
        expect(from2D).toBe(from1D)
        rows.push({
          x,
          y,
          '1D': from1D,
          '2D': from2D,
          match: from1D === from2D ? 'yes' : 'NO'
        })
      }
    }
    logTable('1D vs 2D', rows)
  })

  it('2D table matches cloudsResolve.frag ivec4[4] layout', async () => {
    const { bayerIndex2D } = await import('./bayer')

    // cloudsResolve.frag:42–47: bayerIndices[coord.x % 4][coord.y % 4]
    // ivec4(0, 12, 3, 15), ivec4(8, 4, 11, 7), ivec4(2, 14, 1, 13), ivec4(10, 6, 9, 5)
    const glslTable = [
      [0, 12, 3, 15],
      [8, 4, 11, 7],
      [2, 14, 1, 13],
      [10, 6, 9, 5]
    ]

    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        expect(bayerIndex2D(x, y)).toBe(glslTable[x]![y]!)
      }
    }
  })
})

describe('fullscreen row origin', () => {
  it('maps top-first WebGPU rows to the reference bottom-first Bayer rows', async () => {
    const { referenceBayerRowCPU } = await import('./bayer')

    expect([0, 1, 2, 3].map(y => referenceBayerRowCPU(y, 720))).toEqual([
      3, 2, 1, 0
    ])
    expect(referenceBayerRowCPU(719, 720)).toBe(0)
  })

  it('the unconverted top-down selector chooses the wrong row on every frame', async () => {
    const { bayerIndices, bayerIndex2D, referenceBayerRowCPU } =
      await import('./bayer')
    const mismatches: number[] = []
    const rows = [0, 1, 2, 3]

    for (let frame = 0; frame < 16; frame++) {
      const oldIndex = bayerIndices.indexOf(frame)
      const x = oldIndex % 4
      const oldRow = Math.floor(oldIndex / 4)
      const referenceRow = rows.find(
        y => bayerIndex2D(x, referenceBayerRowCPU(y, 720)) === frame
      )
      if (oldRow !== referenceRow) mismatches.push(frame)
    }

    expect(mismatches).toEqual(Array.from({ length: 16 }, (_, i) => i))
  })
})

// the Bayer row mirror is within the
// top-aligned cell, 3 - (y % 4). The absolute mirror agrees only when height is
// a multiple of 4, and streaked the layer otherwise (|d/dy|/|d/dx| 1.2 to 1.5)
describe('Bayer row phase is a within-cell mirror', () => {
  it('agrees with the absolute mirror only when the height is a multiple of 4', async () => {
    const { referenceBayerRowCPU } = await import('./bayer')
    const absoluteMirror = (y: number, height: number): number =>
      (height - 1 - y) % 4
    for (const height of [720, 900]) {
      for (let y = 0; y < 8; y++) {
        expect(referenceBayerRowCPU(y, height)).toBe(absoluteMirror(y, height))
      }
    }
    // The red: at 901 the absolute mirror gives a different phase on every row
    const disagreements = [0, 1, 2, 3].filter(
      y => referenceBayerRowCPU(y, 901) !== absoluteMirror(y, 901)
    )
    expect(disagreements).toEqual([0, 1, 2, 3])
  })

  it('is independent of the height: rows 0..3 map to 3..0 for 900, 901, 902, 903', async () => {
    const { referenceBayerRowCPU } = await import('./bayer')
    for (const height of [900, 901, 902, 903, 1794]) {
      expect(
        [0, 1, 2, 3, 4, 5].map(y => referenceBayerRowCPU(y, height))
      ).toEqual([3, 2, 1, 0, 3, 2])
    }
  })
})

// The CPU twin is a CLAIM about the TSL function, not evidence of it: a
// pre-p0h3 absolute mirror kept every test above green while the compiled
// shader streaked. The unused height must leave no trace in the emission.
describe('emitted WGSL: the compiled row phase ignores the height', () => {
  const MARKER = 'bayerHeightMarker'
  const heights = [900, 901, 902, 903, 1794]

  async function compileAt(height: number, y: number): Promise<string> {
    const marker = uniform(height, 'float')
    marker.name = MARKER
    const { referenceBayerRow } = await import('./bayer')
    return compileWGSL(referenceBayerRow(int(y), marker)).fragment
  }

  it('drops the height uniform at every height', async () => {
    const rows: Record<string, string | number>[] = []

    for (const height of heights) {
      const fragment = await compileAt(height, 7)
      expect(fragment).not.toContain(MARKER)
      expect(fragment).not.toContain('var<uniform>')
      rows.push({
        height,
        markerInWGSL: fragment.includes(MARKER) ? 'yes' : 'NO',
        emitted: fragment.match(/f32\( \((.*)\) \)/)?.[1] ?? 'not found'
      })
    }
    logTable('emitted WGSL, referenceBayerRow(7, h)', rows)
  })

  it('emits the within-cell mirror 3 - (y - (y / 4) * 4)', async () => {
    const fragment = await compileAt(901, 7)
    expectWGSL(fragment).toContain('3 - ( 7 - ( ( 7 / 4 ) * 4 ) )')
  })
})
