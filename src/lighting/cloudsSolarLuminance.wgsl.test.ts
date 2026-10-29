// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:426 (sun disc radiance -> luminance)
// The one Fn in sunSkyLight.ts with no test touching its output. The stub is an
// `AtmosphereContext.prototype`-derived object, not a constructed one

import { float, context as tslContext, vec3 } from 'three/tsl'
import { beforeEach, describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { cloudsSolarLuminance } from './sunSkyLight'

// Untyped fields, because three's node types are not assignable to what a
// `Partial<{...}>` infers, and `Node` lost its type parameter in three 0.185
type AtmosphereParameters = Record<string, unknown>

async function compileWith(
  parameters: Partial<AtmosphereParameters>
): Promise<string> {
  const { AtmosphereContext } = await import('@takram/three-atmosphere/webgpu')
  const atmosphere = Object.create(AtmosphereContext.prototype) as Record<
    string,
    unknown
  >
  atmosphere.parametersNode = {
    worldToUnit: float(1),
    solarIrradiance: vec3(1, 1, 1),
    sunAngularRadius: float(0.01),
    sunRadianceToLuminance: float(1),
    luminanceScale: float(1),
    ...parameters
  }
  atmosphere.dispose = () => {}
  return compileWGSL(cloudsSolarLuminance(), {
    contextNode: tslContext({ getAtmosphere: () => atmosphere })
  }).fragment
}

describe('cloudsSolarLuminance, WGSL', () => {
  beforeEach(() => setCurrentSpec('cloudsSolarLuminance'))

  it('delegates to the atmosphere accessor rather than computing luminance', async () => {
    const fragment = await compileWith({})
    log('cloudsSolarLuminance-wgsl', {
      length: fragment.length,
      // getSolarLuminance is solarIrradiance / (π * r^2) * (radianceToLuminance *
      // luminanceScale). A division by PI*r^2 is the signature, a clouds-side
      // reimplementation would not carry the atmosphere's own constants
      hasPi: fragment.includes('3.141592653589793'),
      hasDivide: fragment.includes('/')
    })
    expect(fragment.length).toBeGreaterThan(0)
    expect(fragment).toContain('3.141592653589793')
    expect(fragment).toMatch(/\//)
  })

  it('reads its values from the atmosphere context, not from constants', async () => {
    // Two different parameter sets must produce two different graphs. If the
    // accessor closed over a module constant, both would be identical and the
    // "delegates to the atmosphere" claim above would be false
    const a = await compileWith({ sunAngularRadius: float(0.01) })
    const b = await compileWith({ sunAngularRadius: float(0.02) })
    log('cloudsSolarLuminance-from-context', {
      differ: a !== b,
      aLength: a.length,
      bLength: b.length
    })
    expect(a).not.toBe(b)
  })

  it('angular radius enters squared, as the disc solid angle requires', async () => {
    // The disc's radiance scales as 1/(π*r^2). `r` rather than `r^2` would give a
    // disc four times too dim at r = 0.02 and still compile, so the exponent is
    // the claim
    const fragment = await compileWith({ sunAngularRadius: float(0.02) })
    log('cloudsSolarLuminance-radius-squared', {
      hasSquare:
        /0\.02 \* 0\.02|0\.020000000298023224 \* 0\.020000000298023224|pow2/.test(
          fragment
        ),
      fragmentTail: fragment.slice(fragment.indexOf('fn main'))
    })
    // three emits pow2() as an explicit product of the SAME literal, so the
    // square is visible as the literal appearing twice in one parenthesised
    // product. Reading it as `pow(l, 2.0)` fails: the exponent never appears
    const squared = /\(\s*([-\d.]+)\s*\*\s*\1\s*\)/.exec(fragment)
    log('cloudsSolarLuminance-squared-literal', {
      found: squared != null,
      literal: squared?.[1] ?? ''
    })
    expect(squared).not.toBeNull()
    expect(Number(squared![1])).toBeCloseTo(0.02, 6)
  })

  it('luminance scale multiplies after the division, not before', async () => {
    // Order matters numerically only through overflow, but the shape is what a
    // snapshot can pin: `(irradiance / (PI*r^2)) * scale`, a divide then a
    // multiply at the same level
    const fragment = await compileWith({ luminanceScale: float(2) })
    const main = fragment.slice(fragment.indexOf('fn main'))
    log('cloudsSolarLuminance-scale-order', { main })
    const divide = main.indexOf('/')
    const times = main.indexOf('*')
    expect(divide).toBeGreaterThan(-1)
    expect(times).toBeGreaterThan(divide)
  })
})
