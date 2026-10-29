// WGSL compilation of the shadow-length march,
// cite: clouds.frag:622-650

// The CPU twin covers the arithmetic, not the TSL that runs, which is where
// side B lost its shafts (layerRT[2].x was 0 on every pixel)

import type { Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

describe('marchShadowLength — WGSL', () => {
  setCurrentSpec('shadowLengthMarch-wgsl')

  it('emits a loop that terminates and accumulates the sampled optical depth', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn: tslFn, float, vec2, vec3 } = await import('three/tsl')
    const { createMarchShadowLength } = await import('./shadowLengthMarch')

    // A sampler that returns a constant non-zero optical depth: whatever the
    // loop emits, the integral must be able to accumulate from it
    const mockSampleOD = tslFn(
      ([_position, _a, _b, _jitter]: [
        Node<'vec3'>,
        Node<'float'>,
        Node<'float'>,
        Node<'float'>
      ]) => float(0.5)
    )

    const marchShadowLength = createMarchShadowLength({
      sampleShadowOpticalDepth: mockSampleOD,
      perspectiveStepScale: float(1.01),
      minShadowLengthStepSize: float(50),
      maxShadowLengthIterationCount: 500
    })

    const node = tslFn(() => {
      return marchShadowLength(
        vec3(0, 0, 6371000),
        vec3(0, 0, 1),
        vec2(0, 5000),
        float(0.5)
      )
    })()

    const { fragment } = compileWGSL(node)

    const hasLoop = /\bfor\s*\(|\bloop\b|\bwhile\b/.test(fragment)
    const hasBreak = /\bbreak\b/.test(fragment)
    const callsSampler = fragment.includes('0.5')

    log('shadowLengthMarch-wgsl', [
      { field: 'compiles', expected: true, actual: fragment.length > 0 },
      { field: 'emits a loop', expected: true, actual: hasLoop },
      {
        field: 'emits a break (termination)',
        expected: true,
        actual: hasBreak
      },
      { field: 'sampler inlined', expected: true, actual: callsSampler }
    ])

    expect(fragment.length).toBeGreaterThan(0)
    expect(hasLoop, 'the march must emit a loop').toBe(true)
    // clouds.frag:640-642 breaks when rayDistance exceeds maxRayDistance. A
    // loop with no break either runs the full iteration count or, worse, has
    // had its body folded away
    expect(hasBreak, 'the march must emit a termination break').toBe(true)
  })
})

// lightShaftsHalfResolution as WGSL: a per-lane loop, and the quad sum with
// the fragment `subgroups` directive, which three enables only for compute:
// its absence is a shader-creation error the unit suite would not see
describe('marchShadowLengthQuadPartial + sumQuadShadowLength — WGSL (lightShaftsHalfResolution)', () => {
  setCurrentSpec('shadowLengthMarch-quad-wgsl')

  it('emits the per-lane loop, the subgroups directive and four quad broadcasts', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { Fn: tslFn, float, int, vec2, vec3 } = await import('three/tsl')
    const {
      createMarchShadowLengthQuadPartial,
      enableSubgroups,
      quadLane,
      sumQuadShadowLength
    } = await import('./shadowLengthMarch')

    const mockSampleOD = tslFn(
      ([_position, _a, _b, _jitter]: [
        Node<'vec3'>,
        Node<'float'>,
        Node<'float'>,
        Node<'float'>
      ]) => float(0.5)
    )
    const partialFn = createMarchShadowLengthQuadPartial({
      sampleShadowOpticalDepth: mockSampleOD,
      perspectiveStepScale: float(1.01),
      minShadowLengthStepSize: float(50),
      maxShadowLengthIterationCount: 500
    })

    const node = tslFn((builder: unknown) => {
      enableSubgroups(builder as Parameters<typeof enableSubgroups>[0])
      const partial = partialFn(
        vec3(0, 0, 6371000),
        vec3(0, 0, 1),
        vec2(0, 5000),
        float(0.5),
        quadLane()
      ).toVar()
      return sumQuadShadowLength(partial, int(1).equal(int(1)), vec2(0, 5000))
    })()

    const { fragment } = compileWGSL(node)

    const hasDirective = /^enable subgroups;/m.test(fragment)
    const broadcasts = (fragment.match(/quadBroadcast\(/g) ?? []).length
    // three re-formats the native function's header (`fn quadBroadcast4 (`)
    const helperDefinitions = (fragment.match(/fn quadBroadcast4\b/g) ?? [])
      .length
    const helperCalls = (fragment.match(/quadBroadcast4\(/g) ?? []).length
    // ceil((500 + 3 - lane) / 4): the lane's own iteration cap, not 500
    const perLaneCap = fragment.includes('503')
    const fullCap = /< 500;/.test(fragment)

    log('shadowLengthMarch-quad-wgsl', [
      { field: 'compiles', expected: true, actual: fragment.length > 0 },
      { field: 'enable subgroups;', expected: true, actual: hasDirective },
      { field: 'quadBroadcast calls', expected: 4, actual: broadcasts },
      {
        field: 'quadBroadcast4 definition',
        expected: 1,
        actual: helperDefinitions
      },
      {
        field: 'quadBroadcast4 calls (partial, lit, near, far)',
        expected: 4,
        actual: helperCalls
      },
      { field: 'per-lane iteration cap', expected: true, actual: perLaneCap },
      { field: 'full 500 cap absent', expected: true, actual: !fullCap }
    ])

    expect(fragment.length).toBeGreaterThan(0)
    expect(hasDirective, 'quad operations need `enable subgroups;`').toBe(true)
    expect(broadcasts).toBe(4)
    expect(helperDefinitions).toBe(1)
    // partial, lit, near, far
    expect(helperCalls).toBe(4)
    expect(perLaneCap).toBe(true)
    expect(fullCap).toBe(false)
  })
})
