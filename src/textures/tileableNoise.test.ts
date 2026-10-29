import type * as TSL from 'three/tsl'
import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

// Numeric agreement with the CPU twins is an e2e readback (node cannot run
// WGSL). Here each graph must compile and keep its structure: a lost inner loop
// or collapsed octaves would still compile

const build = async (make: (tsl: typeof TSL) => unknown): Promise<string> => {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const tsl = await import('three/tsl')
  const node = tsl.Fn(() => make(tsl) as never)()
  return compileWGSL(node).fragment
}

describe('tileableNoise — WGSL', () => {
  setCurrentSpec('tileable-noise-wgsl')

  test('hash keeps its two magic constants', async () => {
    const { hash } = await import('./tileableNoise')
    const fragment = await build(tsl => hash(tsl.float(3)))
    // Either constant silently changed would reseed every generator and
    // invalidate the baked textures the fallback path loads
    expect(fragment).toContain('1.951')
    expect(fragment).toContain('43758.5453')
  })

  test('value noise keeps the lattice-offset encoding', async () => {
    const { valueNoise } = await import('./tileableNoise')
    const fragment = await build(tsl => valueNoise(tsl.vec3(0.5, 0.5, 0.5)))
    // 57 and 113 pack the eight cube corners into one hash argument; 170 and
    // 171 are the far-face sums. Losing any of them still yields smooth noise.
    for (const constant of ['57', '113', '114', '170', '171']) {
      expect(fragment, `lattice offset ${constant}`).toContain(constant)
    }
  })

  test('worley unrolls the full 3x3x3 neighbourhood', async () => {
    const { worleyNoise } = await import('./tileableNoise')
    const fragment = await build(tsl =>
      worleyNoise(tsl.vec3(0.25, 0.5, 0.75), tsl.float(4))
    )
    // 27 cells, each contributing a min() against the running distance. A
    // partially unrolled neighbourhood produces a field that still looks
    // cellular but whose feature points are wrong near cell edges
    const mins = (fragment.match(/\bmin\b/g) ?? []).length
    log('worley-unroll', [
      { field: 'min() calls', expected: '>= 27', actual: mins }
    ])
    expect(mins).toBeGreaterThanOrEqual(27)
  })

  test('fbm emits one perlin evaluation per octave', async () => {
    const { createPerlinFbm } = await import('./tileableNoise')
    const one = await build(tsl =>
      createPerlinFbm(1)(tsl.vec3(0.5, 0.5, 0.5), tsl.vec3(4, 4, 4))
    )
    const four = await build(tsl =>
      createPerlinFbm(4)(tsl.vec3(0.5, 0.5, 0.5), tsl.vec3(4, 4, 4))
    )

    // Octaves unroll at graph time, so more octaves must mean more shader. A
    // collapsed loop only makes the noise smoother, which no range or
    // continuity check would catch
    log('fbm-unroll', [
      { field: '1 octave chars', expected: '<', actual: one.length },
      { field: '4 octave chars', expected: '>', actual: four.length }
    ])
    expect(four.length).toBeGreaterThan(one.length)
  })

  test('fbm is deterministic across builds', async () => {
    const { createPerlinFbm } = await import('./tileableNoise')
    const norm = (s: string): string =>
      s
        .replace(/nodeVar\d+/g, 'nodeVar')
        .replace(/NodeBuffer_\d+/g, 'NodeBuffer')
    const once = norm(
      await build(tsl =>
        createPerlinFbm(3)(tsl.vec3(0.1, 0.2, 0.3), tsl.vec3(8, 8, 8))
      )
    )
    const twice = norm(
      await build(tsl =>
        createPerlinFbm(3)(tsl.vec3(0.1, 0.2, 0.3), tsl.vec3(8, 8, 8))
      )
    )
    expect(once).toBe(twice)
  })
})
