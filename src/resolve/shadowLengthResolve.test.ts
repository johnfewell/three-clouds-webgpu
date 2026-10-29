import { RenderTarget, Texture } from 'three'
import { mrt, texture, uniform } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { buildCloudsResolve } from './cloudsResolve'

// Shadow length and colour resolve in one fragment, sharing the Bayer test,
// closest-fragment search and reprojection (cloudsResolve.frag SHADOW_LENGTH
// branches). Emission stage, the pass wiring is in CloudsPassNode.test.ts
describe('buildCloudsResolve — colour + shadow length in one fragment', () => {
  function build(temporalUpscale: boolean, withShadowLength: boolean) {
    const colorBuffer = new Texture()
    const depthVelocityBuffer = new Texture()
    const shadowLengthBuffer = new Texture()
    const deps = {
      colorBuffer,
      depthVelocityBuffer,
      colorHistoryNode: texture(new Texture()),
      resolveWidth: uniform(1280),
      resolveHeight: uniform(720),
      frame: uniform(0),
      varianceGamma: uniform(2),
      temporalAlpha: uniform(0.1)
    }
    const out = buildCloudsResolve(
      deps,
      withShadowLength
        ? {
            shadowLengthBuffer,
            shadowLengthHistoryNode: texture(new Texture())
          }
        : null,
      temporalUpscale
    )
    const renderTarget = new RenderTarget(1, 1, {
      count: withShadowLength ? 2 : 1
    })
    renderTarget.textures[0]!.name = 'output'
    if (withShadowLength) renderTarget.textures[1]!.name = 'shadowLength'
    const node =
      out.shadowLength != null
        ? mrt({ output: out.color, shadowLength: out.shadowLength })
        : out.color
    const { fragment } = compileWGSL(node, { renderTarget })
    return { fragment, out }
  }

  const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

  it.each([
    // 9 closest-fragment loads + 2 current-texel loads = 11 under the upscale,
    // and the antialiasing path adds 8-neighbour clip loads per output, 27. A
    // second closest-fragment search would add 9 to either
    ['temporal upscale', true, 11],
    ['temporal antialiasing', false, 27]
  ])(
    '%s: one closest-fragment search serves both outputs',
    (_, upscale, loads) => {
      const { fragment } = build(upscale, true)
      expect(count(fragment, /textureLoad\(/g)).toBe(loads)
      // Both histories are sampled (bilinear), each once
      // Accumulation is conditional, so both must use explicit LOD
      expect(count(fragment, /textureSampleLevel\(/g)).toBeGreaterThanOrEqual(2)
      expect(count(fragment, /textureSample\(/g)).toBe(0)
      // Two outputs come out of the one fragment
      expect(fragment).toContain('shadowLength')
    }
  )

  it('without a shadow-length attachment the fragment carries no second output', () => {
    const { fragment, out } = build(true, false)
    expect(out.shadowLength).toBeNull()
    expect(count(fragment, /textureLoad\(/g)).toBe(10)
  })

  it('temporal antialiasing blends BOTH outputs with temporalAlpha', () => {
    const { fragment } = build(false, true)
    // mix(clipped, current, alpha) appears once per output
    expect(count(fragment, /mix\(/g)).toBeGreaterThanOrEqual(2)
  })

  it('the upscale gates accumulation on the Bayer current-frame test', () => {
    const { fragment } = build(true, true)
    // frame % 16 against the per-cell Bayer value, one test for both outputs
    expect(
      count(fragment, /% 16|- \( \( [^;]*\/ 16 \) \* 16 \)/g)
    ).toBeGreaterThanOrEqual(1)
  })
})

describe('shadowLengthResolveCPU', () => {
  it('current-frame texels return current value unchanged', async () => {
    const { shadowLengthResolveCPU } = await import('./shadowLengthResolve')
    const current: [number, number, number, number] = [0.5, 0.3, 0, 0]
    const history: [number, number, number, number] = [0.1, 0.1, 0, 0]
    const result = shadowLengthResolveCPU({
      current,
      history,
      prevUvInBounds: true,
      isCurrentFrame: true,
      neighbours: [],
      gamma: 1
    })
    expect(result[0]).toBe(0.5)
    expect(result[1]).toBe(0.3)
  })

  it('out-of-bounds prevUv returns current value', async () => {
    const { shadowLengthResolveCPU } = await import('./shadowLengthResolve')
    const current: [number, number, number, number] = [0.5, 0.3, 0, 0]
    const history: [number, number, number, number] = [0.1, 0.1, 0, 0]
    const result = shadowLengthResolveCPU({
      current,
      history,
      prevUvInBounds: false,
      isCurrentFrame: false,
      neighbours: [],
      gamma: 1
    })
    expect(result[0]).toBe(0.5)
    expect(result[1]).toBe(0.3)
  })

  it('in-bounds history with matching neighbours preserves history', async () => {
    const { shadowLengthResolveCPU } = await import('./shadowLengthResolve')
    // When current, history, and neighbours are identical,
    // variance clipping should pass through the history
    const v: [number, number, number, number] = [0.5, 0.3, 0, 0]
    const neighbours = Array(8).fill(v) as [number, number, number, number][]
    const result = shadowLengthResolveCPU({
      current: v,
      history: v,
      prevUvInBounds: true,
      isCurrentFrame: false,
      neighbours,
      gamma: 1
    })
    expect(result[0]).toBeCloseTo(0.5, 4)
    expect(result[1]).toBeCloseTo(0.3, 4)
  })

  it('outlier history is clipped toward current neighbourhood', async () => {
    const { shadowLengthResolveCPU } = await import('./shadowLengthResolve')
    const current: [number, number, number, number] = [0.5, 0.3, 0, 0]
    const outlier: [number, number, number, number] = [5.0, 5.0, 0, 0]
    const neighbours = Array(8).fill(current) as [
      number,
      number,
      number,
      number
    ][]
    const result = shadowLengthResolveCPU({
      current,
      history: outlier,
      prevUvInBounds: true,
      isCurrentFrame: false,
      neighbours,
      gamma: 1
    })
    // The outlier should be clipped to within the neighbourhood range
    expect(Math.abs(result[0] - current[0])).toBeLessThan(
      Math.abs(outlier[0] - current[0])
    )
  })

  it('RG channels carry shadow-length data, BA are zero-passthrough', async () => {
    const { shadowLengthResolveCPU } = await import('./shadowLengthResolve')
    const current: [number, number, number, number] = [0.7, 0.4, 0, 0]
    const result = shadowLengthResolveCPU({
      current,
      history: current,
      prevUvInBounds: true,
      isCurrentFrame: true,
      neighbours: [],
      gamma: 1
    })
    // BA channels should pass through unchanged (zero in, zero out)
    expect(result[2]).toBe(0)
    expect(result[3]).toBe(0)
  })
})
