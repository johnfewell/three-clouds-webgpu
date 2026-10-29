// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:614-617, ADR-002, AUDIT-4 (unit-space depth)
// writeLayer ITSELF. The spec next door rebuilds each construct inline, and a
// re-typed construct keeps passing after its module changes underneath it

import { uniform, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { describe, expect, test } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { writeLayer } from './writeLayer'

// writeLayer returns the layerOutputStruct and `StructNode.get()` is typed to
// return `Node`, so the vec4 members need a cast. One cast in a named helper,
// not three at each call site
type LayerMember = 'w' | 'x' | 'z'
const member = (n: Node, name: LayerMember): Node<'float'> =>
  Reflect.get(n, name) as Node<'float'>

const MARS_UNIT = 1e-6
// Inputs are UNIFORMS, not literals. With literal arguments three const-folds
// the body, the guard collapses to `5.0 > 0.0`, and the graph under test stops
// being the graph the shader runs
function encode(
  radiance: [number, number, number],
  transmittance: number,
  minTransmittance: number,
  weightedDistanceSum: number,
  transmittanceSum: number,
  worldToUnit: number
): string {
  const out = writeLayer(
    uniform(vec3(radiance[0], radiance[1], radiance[2])),
    uniform(transmittance),
    uniform(minTransmittance),
    uniform(weightedDistanceSum),
    uniform(transmittanceSum),
    uniform(worldToUnit)
  )
  // the Fn returns the layerOutputStruct, so only the members a consumer reads
  // are emitted. primaryMarch reads both, so read both
  return compileWGSL(
    member(out.get('layer'), 'w')
      .add(member(out.get('depthVelocity'), 'x'))
      .add(member(out.get('layer'), 'z'))
  ).fragment
}

describe('writeLayer, WGSL', () => {
  test('compiles to WGSL', () => {
    const fragment = encode([0.1, 0.2, 0.3], 0.5, 0.01, 100, 5, MARS_UNIT)
    log('writeLayer-wgsl-compiled', { length: fragment.length })
    expect(fragment.length).toBeGreaterThan(0)
  })

  test('opacity is the remapClamped transmittance, clamped to 0..1', () => {
    // remapClamp(T, 1.0, minT) is `(T - 1.0) / (minT - 1.0)` clamped to 0..1. With
    // uniform inputs both endpoints survive, so the claim is 1.0 subtracted on
    // BOTH sides: a transposed remapClamp still subtracts and divides
    const fragment = encode([0, 0, 0], 0.5, 0.01, 100, 5, MARS_UNIT)
    // `clamp( ( ( A - 1.0 ) / ( B - 1.0 ) ), 0.0, 1.0 )`. Capturing the whole
    // call with one group stops at the FIRST close paren, which is inside the
    // numerator, so the numerator and denominator are captured separately
    const alpha = /clamp\(\s*\(\s*\(([^)]*)\)\s*\/\s*\(([^)]*)\)/.exec(fragment)
    log('writeLayer-wgsl-remap', {
      found: alpha != null,
      numerator: alpha?.[1] ?? '',
      denominator: alpha?.[2] ?? ''
    })
    expect(alpha).not.toBeNull()
    // both ends subtract the inLow endpoint 1.0. A remapClamp with the
    // endpoints transposed would still subtract and divide, so the presence of
    // 1.0 on BOTH sides is the claim, not the presence of a divide
    expect(alpha![1]).toMatch(/- 1\.0/)
    expect(alpha![2]).toMatch(/- 1\.0/)
    // and the clamp bounds are 0 and 1
    expect(fragment).toMatch(/clamp\([\s\S]*?,\s*0\.0,\s*1\.0\s*\)/)
  })

  test('frontDepth is selected on transmittanceSum > 0, with a -1 fallback', () => {
    // ts = 0 means the march integrated nothing, and dividing by it writes a NaN
    // into depthVelocity.r. The comparison must be STRICTLY greater than zero:
    // `>= 0` would let a ts of exactly 0 take the divide arm
    const fragment = encode([0, 0, 0], 0.5, 0.01, 100, 5, MARS_UNIT)
    log('writeLayer-wgsl-frontDepth', {
      hasStrictGreater: />\s*0\.0/.test(fragment),
      hasGreaterOrEqual: />=\s*0\.0/.test(fragment),
      hasSentinel: /=\s*-1\.0/.test(fragment)
    })
    expect(fragment).toMatch(/>\s*0\.0/)
    expect(fragment).not.toMatch(/>=\s*0\.0/)
    expect(fragment).toMatch(/=\s*-1\.0/)
  })

  test('depthVelocity.r is frontDepth TIMES worldToUnit, not frontDepth', () => {
    // AUDIT-4: every attachment is fp16 and saturates at 65504, so a depth in
    // metres overflows past ~65 km. Which uniform is worldToUnit is not pinned
    // by name, because three assigns those indices
    const fragment = encode([0, 0, 0], 0.5, 0.01, 4000, 5, MARS_UNIT)
    // the struct is built by constructor call, so the member has no `name:`
    const member = /vec4<f32>\(\s*\(?(.*?)\),\s*0\.0,\s*0\.0,\s*0\.0\s*\)/.exec(
      fragment
    )
    log('writeLayer-wgsl-unitScale', {
      found: member != null,
      member: member?.[1] ?? ''
    })
    expect(member).not.toBeNull()
    expect(member![1]).toMatch(/\*/)
  })

  test('worldToUnit is an input, so the graph tracks it', () => {
    // With uniform inputs the emitted WGSL is the SAME whatever the uniform's
    // VALUE, which lives in the buffer rather than the code. What is assertable
    // is that the product is present, and that dropping the multiply removes it
    const a = encode([0, 0, 0], 0.5, 0.01, 4000, 5, 0)
    const b = encode([0, 0, 0], 0.5, 0.01, 4000, 5, MARS_UNIT)
    const product = /vec4<f32>\(\s*\(?[^,]*\*/.test(a)
    log('writeLayer-wgsl-worldToUnit-input', {
      product,
      sameGraph: a === b
    })
    expect(product).toBe(true)
    expect(a).toBe(b)
  })

  test('the radiance integral reaches layer.rgb with no transform on it', () => {
    // rgb = associated radiance (ADR-002). The layer member must carry the
    // radiance vec3 as its first argument, and the alpha must not be applied to
    // it, a mixed rgb would still compile and would read as plausible fog
    const fragment = encode([0.25, 0.5, 0.75], 0.5, 0.01, 100, 5, MARS_UNIT)
    const layer = /CloudLayerOutput\(\s*vec4<f32>\(\s*([^,]*?),/.exec(fragment)
    log('writeLayer-wgsl-radiance', { rgb: layer?.[1] ?? '' })
    expect(layer).not.toBeNull()
    // The radiance reaches rgb as the bare uniform. The first version of this
    // assertion read as `/\*\s*object/`, which only rejects a product with the
    // uniform on the RIGHT, so a premultiply passed
    expect(layer![1]).not.toMatch(/\*/)
    expect(layer![1]).not.toMatch(/clamp/)
    expect(layer![1]).toMatch(/^\s*object\.nodeUniform\d+\s*$/)
  })
})
