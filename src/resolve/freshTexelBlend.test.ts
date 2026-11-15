// experimental.freshTexelBlend: the just-rendered
// texel is blended with its clipped history instead of being written raw

import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  buildCloudsResolve,
  FRESH_TEXEL_WEIGHT,
  freshTexelBlendCPU,
  type CloudsResolveDeps
} from './cloudsResolve'

async function compileColor(
  weight: number | undefined,
  upscale = true
): Promise<string> {
  const { DataTexture, HalfFloatType, LinearFilter, RGBAFormat } =
    await import('three')
  const { float, texture } = await import('three/tsl')
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const createTexture = () => {
    const result = new DataTexture(
      new Uint16Array(4 * 4 * 4),
      4,
      4,
      RGBAFormat,
      HalfFloatType
    )
    result.minFilter = LinearFilter
    result.magFilter = LinearFilter
    result.needsUpdate = true
    return result
  }
  const deps: CloudsResolveDeps = {
    colorBuffer: createTexture(),
    depthVelocityBuffer: createTexture(),
    colorHistoryNode: texture(createTexture()),
    resolveWidth: float(16),
    resolveHeight: float(16),
    frame: float(0),
    varianceGamma: float(2),
    temporalAlpha: float(0.1),
    freshTexelWeight: weight
  }
  const { color } = buildCloudsResolve(deps, null, upscale)
  return compileWGSL(color, { width: 16, height: 16 }).fragment
}

const count = (text: string, pattern: RegExp) =>
  (text.match(pattern) ?? []).length

describe('freshTexelBlend', () => {
  setCurrentSpec('freshTexelBlend')

  test('CPU twin: weight 1 is the raw texel, 0 the clipped history', () => {
    const rows = [1, FRESH_TEXEL_WEIGHT, 0].map(weight => ({
      weight,
      computed: freshTexelBlendCPU(0.2, 0.6, weight),
      expected: 0.2 + 0.4 * weight
    }))
    log('fresh texel blend', rows)
    for (const row of rows) expect(row.computed).toBeCloseTo(row.expected, 12)
    expect(freshTexelBlendCPU(0.2, 0.6)).toBeCloseTo(0.3, 12)
  })

  test('the option adds one mix to the upscale resolve, and off is unchanged', async () => {
    const off = await compileColor(undefined)
    const on = await compileColor(FRESH_TEXEL_WEIGHT)
    const rows = [
      { variant: 'off', mixes: count(off, /\bmix\(/g), length: off.length },
      { variant: 'on', mixes: count(on, /\bmix\(/g), length: on.length }
    ]
    log('fresh texel blend WGSL', rows)
    expect(on).not.toBe(off)
    expect(rows[1]!.mixes).toBe(rows[0]!.mixes + 1)
    expect(on).toContain(String(FRESH_TEXEL_WEIGHT))
    // The history sample stays derivative-free inside the branch
    expect(count(on, /textureSample\(/g)).toBe(0)
  })

  test('without temporalUpscale the weight changes nothing', async () => {
    const off = await compileColor(undefined, false)
    const on = await compileColor(FRESH_TEXEL_WEIGHT, false)
    log('fresh texel blend, full-res resolve', {
      identical: on === off,
      length: on.length
    })
    expect(on.length).toBeGreaterThan(0)
    expect(on).toBe(off)
  })
})
