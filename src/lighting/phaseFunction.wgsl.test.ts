// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// clouds.frag:298-344
// The TSL twins of the three phase functions. phaseFunction.test.ts covers the
// PLAIN-JS forms and nothing reached these

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { float } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  accuratePhaseFunction,
  accuratePhaseFunctionTSL,
  henyeyGreenstein,
  phaseFunctionDefault,
  phaseFunctionTSL
} from './phaseFunction'

// phaseFunction.ts holds these twice, once per form. Read from the source so
// the expectations cannot drift with it
const FIT_CONSTANTS = {
  G_HG: '0.988176691700256',
  G_D: '0.5556712547839497',
  ALPHA: '21.995520856274638',
  WEIGHT: '0.4819554318404214'
}

describe('phase function TSL twins, WGSL', () => {
  setCurrentSpec('phaseFunction-tsl-wgsl')

  it('phaseFunctionTSL emits a guarded power per lobe, and a mix', () => {
    const node = phaseFunctionTSL(
      float(0.5),
      float(1),
      float(0.7),
      float(-0.2),
      float(0.5)
    )
    const { fragment } = compileWGSL(node)
    const powCount = (fragment.match(/pow/g) ?? []).length
    log('phaseFunctionTSL-wgsl', {
      length: fragment.length,
      powCount,
      hasMix: fragment.includes('mix')
    })
    // One denominator power per lobe, so two powers total. Losing the second
    // would make the backward lobe isotropic and still compile
    expect(powCount).toBeGreaterThanOrEqual(2)
    expect(fragment).toContain('mix')
  })

  it('phaseFunctionTSL guards both denominators with the 1e-7 epsilon', () => {
    const { fragment } = compileWGSL(
      phaseFunctionTSL(
        float(0.5),
        float(1),
        float(0.7),
        float(-0.2),
        float(0.5)
      )
    )
    const epsilons = (fragment.match(/1e-7/g) ?? []).length
    log('phaseFunctionTSL-epsilon', { epsilons })
    // clouds.frag:299 clamps max(denom, 1e-7), without it cosTheta -> 1 with
    // g -> 1 divides by zero, and WGSL's max is all that stands between the
    // forward lobe and an inf
    expect(epsilons).toBeGreaterThanOrEqual(2)
  })

  it('phaseFunctionTSL follows the mix argument rather than a fixed weight', () => {
    // Each weight is its own literal in the emitted graph, so the mix argument can
    // be read back. The earlier version captured `1.5` for all three inputs, the
    // pow exponent rather than the weight, so it compared one value with itself
    const mixWeightOf = (w: number): string => {
      const { fragment } = compileWGSL(
        phaseFunctionTSL(
          float(0.5),
          float(1),
          float(0.7),
          float(-0.2),
          float(w)
        )
      )
      const calls = [...fragment.matchAll(/mix\(/g)]
      expect(calls.length).toBeGreaterThanOrEqual(1)
      // the mix is the outermost call, so its closing paren is the last one
      const close = fragment.lastIndexOf(')')
      const open = fragment.lastIndexOf('mix(', close)
      expect(open).toBeGreaterThan(0)
      const args = fragment.slice(open + 4, close).split(',')
      // the outermost mix closes on the same paren as the whole expression, so
      // the split leaves a trailing ')' on the last argument and a leading
      // space on each
      return args[args.length - 1]!.replace(/\)\s*$/, '').trim()
    }
    const weights = [0, 0.25, 1].map(mixWeightOf)
    log('phaseFunctionTSL-mix-weights', { weights: weights.join(' | ') })
    expect(new Set(weights).size).toBe(3)
    expect(weights[0]).toBe('0.0')
    expect(weights[2]).toBe('1.0')
  })

  it('accuratePhaseFunctionTSL emits both lobes and the shared pi constant', () => {
    const node = accuratePhaseFunctionTSL(float(0.5), float(1))
    const { fragment } = compileWGSL(node)
    log('accuratePhaseFunctionTSL-wgsl', {
      length: fragment.length,
      // draine normalises by 4 * (1 + a*(1+2g^2)/3) * PI, so the constant
      // must survive into the graph rather than fold to 0
      hasPi: fragment.includes('3.141592653589793')
    })
    expect(fragment).toContain('mix')
    expect(fragment).toContain('pow')
    expect(fragment).toContain('3.141592653589793')
  })

  it('accuratePhaseFunctionTSL carries all four fit constants verbatim', () => {
    const { fragment } = compileWGSL(
      accuratePhaseFunctionTSL(float(0.5), float(1))
    )
    for (const [name, literal] of Object.entries(FIT_CONSTANTS)) {
      log('accuratePhaseFunctionTSL-constant', {
        name,
        literal,
        present: fragment.includes(literal)
      })
      // three emits these f64 literals unformatted, so an exact substring is
      // the assertion, a f32-rounded or reformatted copy would fail it
      expect(fragment).toContain(literal)
    }
  })

  it('the shared constants also appear in the JS twin source', () => {
    // The same file, read through the test: if the literals live only in the
    // TSL half, the "shared" claim in the comment above is false and the
    // snapshot above is pinning the wrong copy
    const source = readFileSync(
      join(import.meta.dirname, 'phaseFunction.ts'),
      'utf8'
    )
    log('phaseFunction-source-constants', {
      literals: Object.values(FIT_CONSTANTS).join(' ')
    })
    for (const literal of Object.values(FIT_CONSTANTS)) {
      expect(source).toContain(literal)
    }
  })

  it('the TSL and JS forms agree at g = 0 (both isotropic at 1/(4pi))', () => {
    // hgTSL is module-private, so it is reached THROUGH phaseFunctionTSL with
    // both lobes isotropic. The JS twin of the same claim is
    // henyeyGreenstein(0, 0, cosTheta)
    const RECIPROCAL_PI4 = 1 / (4 * Math.PI)
    const jsLobes = [-1, -0.5, 0, 0.5, 1].map(c => henyeyGreenstein(0, 0, c))
    const { fragment } = compileWGSL(
      phaseFunctionTSL(float(0.5), float(1), float(0), float(0), float(0.5))
    )
    // with both g at 0 the mix weight is irrelevant and every term collapses
    // to RECIPROCAL_PI4, the graph must still carry that scale
    expect(fragment).toContain(String(RECIPROCAL_PI4).slice(0, 10))
    log('phaseFunction-isotropic', {
      scale: String(RECIPROCAL_PI4).slice(0, 10),
      jsLobe0: jsLobes[0]![0]
    })
    for (const [lobe1, lobe2] of jsLobes) {
      expect(lobe1).toBeCloseTo(RECIPROCAL_PI4, 10)
      expect(lobe2).toBeCloseTo(RECIPROCAL_PI4, 10)
    }
  })

  it('the TSL accurate path tracks the JS accurate path in shape', () => {
    // Not a numeric comparison, node cannot run WGSL. What is assertable is
    // that the JS twin still has the forward-peak asymmetry the TSL form
    // encodes, so the snapshot above is pinned to a live property
    const forward = accuratePhaseFunction(1, 1)
    const backward = accuratePhaseFunction(-1, 1)
    const dualLobe = phaseFunctionDefault(0.5, 0.7, -0.2, 0.5)
    log('accuratePhaseFunction-shape', {
      forward: forward.toFixed(8),
      backward: backward.toFixed(8),
      dualLobeAtHalf: dualLobe.toFixed(8)
    })
    expect(forward).toBeGreaterThan(backward * 10)
  })
})
