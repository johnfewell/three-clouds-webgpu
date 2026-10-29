import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

// The numeric check against the CPU twin (test/helpers/perlinReference.ts) is an
// e2e readback, since node cannot run WGSL. Here: the graph compiles and is not
// degenerate (constant-folded, or missing the permutation chain)

describe('perlin — WGSL', () => {
  setCurrentSpec('perlin-wgsl')

  test('compiles and keeps the structure the noise depends on', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn: tslFn, vec4 } = await import('three/tsl')
    const { perlin } = await import('./perlin')

    const node = tslFn(() =>
      perlin(vec4(0.5, 0.5, 0.5, 0.5), vec4(8, 8, 8, 8))
    )()
    const { fragment } = compileWGSL(node)

    // 289 is the permutation modulus and 34 its multiplier; 1.79284291400159 is
    // taylorInvSqrt's constant and 2.2 the output scale. If the graph had folded
    // away or lost the permute chain, these would not survive into the WGSL
    const has = (needle: string): boolean => fragment.includes(needle)
    const checks = {
      'permutation modulus 289': has('289'),
      'permutation multiplier 34': has('34'),
      'taylorInvSqrt constant': has('1.79284291400159'),
      'output scale 2.2': has('2.2'),
      'fade constants 6/15/10': has('15') && has('10')
    }

    log(
      'perlin-wgsl',
      Object.entries(checks)
        .map(([field, actual]) => ({ field, expected: true, actual }))
        .concat([
          { field: 'wgsl chars', expected: true, actual: fragment.length > 0 }
        ])
    )

    expect(fragment.length).toBeGreaterThan(0)
    for (const [what, ok] of Object.entries(checks)) {
      expect(ok, `${what} must survive into the compiled WGSL`).toBe(true)
    }
  })

  test('is a pure function of its arguments — no hidden uniform capture', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn: tslFn, vec4 } = await import('three/tsl')
    const { perlin } = await import('./perlin')

    // Two builds of the same call must produce the same graph. Anything
    // captured at build time would make results depend on build order (the
    // yx4a/594e stale-binding class), and it would look like plausible noise
    const build = (): string =>
      compileWGSL(
        tslFn(() => perlin(vec4(0.25, 0.5, 0.75, 1), vec4(4, 4, 4, 4)))()
      )
        .fragment.replace(/nodeVar\d+/g, 'nodeVar')
        .replace(/NodeBuffer_\d+/g, 'NodeBuffer')

    expect(build()).toBe(build())
  })
})
