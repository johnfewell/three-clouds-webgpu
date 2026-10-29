import { DataArrayTexture, DataTexture, FloatType, RGBAFormat } from 'three'
import { describe, expect, it } from 'vitest'

type V4 = [number, number, number, number]

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[varianceClipping] ${label}`)
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

function v4Str(v: V4) {
  return `(${v.map(x => x.toFixed(4)).join(',')})`
}

describe('clipAABB CPU twin', () => {
  it('history inside AABB is unchanged', async () => {
    const { clipAABBCPU } = await import('./varianceClipping')
    const current: V4 = [0.5, 0.5, 0.5, 1.0]
    const history: V4 = [0.5, 0.5, 0.5, 1.0]
    const minColor: V4 = [0.0, 0.0, 0.0, 0.0]
    const maxColor: V4 = [1.0, 1.0, 1.0, 1.0]
    const result = clipAABBCPU(current, history, minColor, maxColor)
    for (let i = 0; i < 4; i++) {
      expect(result[i]).toBeCloseTo(history[i]!, 6)
    }
    logTable('inside AABB', [
      {
        history: v4Str(history),
        min: v4Str(minColor),
        max: v4Str(maxColor),
        result: v4Str(result),
        clipped: 'no'
      }
    ])
  })

  it('history outside AABB is clipped toward centre', async () => {
    const { clipAABBCPU } = await import('./varianceClipping')
    const current: V4 = [0.5, 0.5, 0.5, 1.0]
    const history: V4 = [2.0, 0.5, 0.5, 1.0]
    const minColor: V4 = [0.0, 0.0, 0.0, 0.0]
    const maxColor: V4 = [1.0, 1.0, 1.0, 1.0]
    const result = clipAABBCPU(current, history, minColor, maxColor)
    expect(result[0]).toBeLessThan(history[0])
    expect(result[0]).toBeGreaterThanOrEqual(minColor[0])
    expect(result[0]).toBeLessThanOrEqual(maxColor[0] + 0.01)
    logTable('outside AABB', [
      { history: v4Str(history), result: v4Str(result), clipped: 'yes' }
    ])
  })

  it('history on boundary is unchanged', async () => {
    const { clipAABBCPU } = await import('./varianceClipping')
    const current: V4 = [0.5, 0.5, 0.5, 1.0]
    const history: V4 = [1.0, 0.5, 0.5, 1.0]
    const minColor: V4 = [0.0, 0.0, 0.0, 0.0]
    const maxColor: V4 = [1.0, 1.0, 1.0, 1.0]
    const result = clipAABBCPU(current, history, minColor, maxColor)
    for (let i = 0; i < 3; i++) {
      expect(result[i]).toBeCloseTo(history[i]!, 5)
    }
    logTable('on boundary', [
      { history: v4Str(history), result: v4Str(result), clipped: 'no' }
    ])
  })
})

describe('varianceClipping CPU twin', () => {
  it('uniform neighbourhood → history unchanged when close', async () => {
    const { varianceClippingCPU } = await import('./varianceClipping')
    const current: V4 = [0.5, 0.5, 0.5, 1.0]
    const neighbours: V4[] = Array(8).fill([0.5, 0.5, 0.5, 1.0])
    const history: V4 = [0.5, 0.5, 0.5, 1.0]
    const result = varianceClippingCPU(current, neighbours, history, 1.0)
    for (let i = 0; i < 4; i++) {
      expect(result[i]).toBeCloseTo(history[i]!, 4)
    }
    logTable('uniform neighbourhood', [
      {
        current: v4Str(current),
        history: v4Str(history),
        result: v4Str(result)
      }
    ])
  })

  it('outlier history is clipped by neighbourhood variance', async () => {
    const { varianceClippingCPU } = await import('./varianceClipping')
    const current: V4 = [0.5, 0.5, 0.5, 1.0]
    const neighbours: V4[] = Array(8).fill([0.5, 0.5, 0.5, 1.0])
    const history: V4 = [5.0, 0.5, 0.5, 1.0]
    const result = varianceClippingCPU(current, neighbours, history, 1.0)
    expect(result[0]).toBeLessThan(history[0])
    expect(result[0]).toBeCloseTo(0.5, 1)
    logTable('outlier clipped', [
      { history: v4Str(history), result: v4Str(result), clipped: 'yes' }
    ])
  })
})

describe('offsets', () => {
  it('9-sample has 8 offsets, 4-sample has 4', async () => {
    const { OFFSETS_9, OFFSETS_4 } = await import('./varianceClipping')
    expect(OFFSETS_9).toHaveLength(8)
    expect(OFFSETS_4).toHaveLength(4)
    logTable('offset counts', [
      { variant: '9-sample', offsets: 8 },
      { variant: '4-sample', offsets: 4 }
    ])
  })
})

describe('WGSL compilation', () => {
  it('clipAABB compiles to WGSL', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const { vec4: tslVec4 } = await import('three/tsl')
    const { clipAABB } = await import('./varianceClipping')
    const { contextNode } = createContextStub()

    const result = clipAABB(
      tslVec4(0.5, 0.5, 0.5, 1.0),
      tslVec4(2.0, 0.5, 0.5, 1.0),
      tslVec4(0.0, 0.0, 0.0, 0.0),
      tslVec4(1.0, 1.0, 1.0, 1.0)
    )
    const { fragment } = compileWGSL(result, { contextNode })
    expect(fragment).toContain('if')
    expect(fragment).toContain('abs')
    logTable('WGSL compilation', [
      { fn: 'clipAABB', length: String(fragment.length), compiled: 'yes' }
    ])
  })

  function createDummyTexture(array: boolean) {
    const data = new Float32Array(4 * 4 * 4)
    if (array) {
      return new DataArrayTexture(data, 4, 4, 1)
    }
    const tex = new DataTexture(data, 4, 4, RGBAFormat, FloatType)
    tex.needsUpdate = true
    return tex
  }

  function countTextureLoads(wgsl: string): number {
    return (wgsl.match(/textureLoad/g) ?? []).length
  }

  function countTextureSamples(wgsl: string): number {
    return (wgsl.match(/textureSample/g) ?? []).length
  }

  const variants = [
    { samples: 9 as const, array: false, expectedLoads: 8 },
    { samples: 4 as const, array: false, expectedLoads: 4 },
    { samples: 9 as const, array: true, expectedLoads: 8 },
    { samples: 4 as const, array: true, expectedLoads: 4 }
  ]

  for (const v of variants) {
    const label = `${v.samples}-sample ${v.array ? 'array' : '2D'}`

    it(`varianceClipping ${label} compiles to WGSL`, async () => {
      const { compileWGSL } = await import('../../test/helpers/compileWGSL')
      const { createContextStub } =
        await import('../../test/helpers/contextStub')
      const {
        vec4: tslVec4,
        float: tslFloat,
        ivec2: tslIvec2,
        ivec3: tslIvec3
      } = await import('three/tsl')
      const { varianceClipping } = await import('./varianceClipping')
      const { contextNode } = createContextStub()

      const tex = createDummyTexture(v.array)
      const fn = varianceClipping(tex, {
        samples: v.samples,
        array: v.array
      })
      const coord = v.array ? tslIvec3(2, 2, 0) : tslIvec2(2, 2)
      const result = fn(
        coord,
        tslVec4(0.5, 0.5, 0.5, 1.0),
        tslVec4(0.5, 0.5, 0.5, 1.0),
        tslFloat(1.0)
      )
      const { fragment } = compileWGSL(result, { contextNode })

      const loads = countTextureLoads(fragment)
      expect(loads).toBe(v.expectedLoads)
      expect(fragment).toContain('sqrt')

      logTable(`WGSL ${label}`, [
        {
          variant: label,
          textureLoads: loads,
          expected: v.expectedLoads,
          match: loads === v.expectedLoads ? 'yes' : 'NO',
          length: fragment.length
        }
      ])
    })
  }

  it('vec2 variant emits bilinear samples at texture-sized UV offsets', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const {
      float: tslFloat,
      vec2: tslVec2,
      vec4: tslVec4
    } = await import('three/tsl')
    const { varianceClippingUv } = await import('./varianceClipping')
    const { contextNode } = createContextStub()

    const tex = createDummyTexture(false)
    const fn = varianceClippingUv(tex)
    const result = fn(
      tslVec2(0.375, 0.625),
      tslVec4(0.5, 0.5, 0.5, 1),
      tslVec4(0.5, 0.5, 0.5, 1),
      tslFloat(1)
    )
    const { fragment } = compileWGSL(result, { contextNode })
    const samples = countTextureSamples(fragment)
    const loads = countTextureLoads(fragment)

    // The stub backend lowers unfilterable float samples to dimensions + loads
    // Runtime fp16 render targets retain the same normalized-UV sample graph
    expect(samples + loads).toBe(8)
    expect(fragment).toContain('textureDimensions')
    logTable('WGSL vec2 bilinear', [
      {
        textureSamples: samples,
        textureLoads: loads,
        totalReads: samples + loads,
        expectedReads: 8,
        textureSizedOffsets: fragment.includes('textureDimensions')
          ? 'yes'
          : 'NO'
      }
    ])
  })
})
