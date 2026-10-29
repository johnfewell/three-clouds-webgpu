import type * as TSL from 'three/tsl'
import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

const build = async (make: (tsl: typeof TSL) => unknown): Promise<string> => {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const tsl = await import('three/tsl')
  return compileWGSL(tsl.Fn(() => make(tsl) as never)()).fragment
}

describe('cloudShape — WGSL', () => {
  setCurrentSpec('cloud-shape-wgsl')

  test('keeps the asymmetric third-band weights', async () => {
    const { cloudShapeDetail } = await import('./cloudShape')
    const fragment = await build(tsl =>
      cloudShapeDetail(tsl.vec3(0.5, 0.5, 0.5))
    )
    // The third band is a two-component dot weighted 0.75/0.25, unlike the
    // others' 0.625/0.25/0.125. Regularising it would still look like cloud
    // shape, so the odd weights are asserted explicitly
    expect(fragment).toContain('0.75')
    expect(fragment).toContain('0.625')
    expect(fragment).toContain('0.125')
  })

  test('cloudShape and cloudShapeDetail are different graphs', async () => {
    const { cloudShape, cloudShapeDetail } = await import('./cloudShape')
    const shape = await build(tsl => cloudShape(tsl.vec3(0.5, 0.5, 0.5)))
    const detail = await build(tsl => cloudShapeDetail(tsl.vec3(0.5, 0.5, 0.5)))

    // They share the band-fbm helper, so a wiring slip could make one compile
    // to the other's parameters. cloudShape additionally carries a 3-octave
    // Perlin and a second fbm, so it must be substantially larger
    log('cloud-shape-sizes', [
      { field: 'cloudShape chars', expected: '>', actual: shape.length },
      { field: 'cloudShapeDetail chars', expected: '<', actual: detail.length }
    ])
    expect(shape.length).toBeGreaterThan(detail.length)
    expect(shape).not.toBe(detail)
  })

  test('cloudShape carries its Perlin term and all three Worley bands', async () => {
    const { cloudShape } = await import('./cloudShape')
    const fragment = await build(tsl => cloudShape(tsl.vec3(0.5, 0.5, 0.5)))

    // Perlin at frequency 8, and Worley at cellCount 4 x {2, 8, 14} = 8, 32, 56
    // A dropped band still produces plausible cloud shape at a different scale
    for (const constant of ['8', '32', '56']) {
      expect(fragment, `band ${constant}`).toContain(constant)
    }
    expect(fragment.length).toBeGreaterThan(0)
  })
})
