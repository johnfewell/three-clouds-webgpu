// WGSL compilation of the shared cascade selector,
// cite: @takram/three-geospatial cascadedShadowMaps.glsl

// Pins that the walk reaches every interval slot (a fixed MAX_CASCADE_COUNT
// unroll with runtime guards) and that the jitter crossfade survives

import { Matrix4, Vector2 } from 'three'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { MAX_CASCADE_COUNT } from './CascadedShadowMaps'

async function compileSelector(cascadeCount: number): Promise<string> {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const { Fn, float, uniform, uniformArray, vec3 } = await import('three/tsl')
  const { createFadedCascadeIndex } = await import('./fadedCascadeIndex')

  const getFadedCascadeIndex = createFadedCascadeIndex({
    viewMatrix: uniform(new Matrix4()),
    cameraNear: uniform(1),
    shadowFar: uniform(1e5),
    // uniformArray, as CloudsPassNode passes it (scalars cannot exercise
    // .element(i), #381). MAX_CASCADE_COUNT long, as the real descriptor, since
    // every slot is unrolled and guarded at runtime
    shadowIntervals: uniformArray(
      Array.from({ length: MAX_CASCADE_COUNT }, () => new Vector2(0, 1))
    ),
    // Runtime node now, not a graph-time number
    cascadeCount: uniform(cascadeCount, 'int')
  })

  const node = Fn(() =>
    // float() so the int result is representable as the fragment output
    float(getFadedCascadeIndex(vec3(0, 0, 100), float(0.5)))
  )()

  return compileWGSL(node).fragment
}

// TSL numbers its temporaries and uniform buffers from process-global
// counters, so raw text differs between compiles for reasons that have nothing
// to do with this graph
function normalise(wgsl: string): string {
  return wgsl
    .replace(/nodeVar\d+/g, 'nodeVar')
    .replace(/NodeBuffer_\d+/g, 'NodeBuffer')
}

describe('createFadedCascadeIndex', () => {
  setCurrentSpec('fadedCascadeIndex')

  it('compiles and emits the jitter crossfade', async () => {
    const wgsl = await compileSelector(4)
    // The dithered seam is the whole point of the "faded" variant: without the
    // jitter comparison this degenerates into a hard cascade boundary
    const hasJitterCompare = /<=|greater|less/.test(wgsl)
    log('fadedCascadeIndex', [
      { field: 'compiles', expected: true, actual: wgsl.length > 0 },
      {
        field: 'jitter comparison present',
        expected: true,
        actual: hasJitterCompare
      },
      { field: 'wgsl chars', expected: '>0', actual: wgsl.length }
    ])
    expect(wgsl.length).toBeGreaterThan(0)
    expect(hasJitterCompare).toBe(true)
  })

  it('indexes every interval slot, independently of the live cascade count', async () => {
    // The distinct `value[ Nu ]` indices are the unroll: reading only element 0
    // would compile and score but never pick a later cascade (#381)

    // The unroll is always MAX_CASCADE_COUNT, independent of the count. Tying
    // it to the count froze consumers at their build-time count
    const indicesUsed = async (n: number): Promise<number> => {
      const wgsl = await compileSelector(n)
      const hits = wgsl.match(/value\[ \d+u \]/g) ?? []
      return new Set(hits).size
    }
    const [one, two, four] = await Promise.all([
      indicesUsed(1),
      indicesUsed(2),
      indicesUsed(4)
    ])
    log('fadedCascadeIndex-unroll', [
      { field: 'distinct indices (count=1)', expected: 4, actual: one },
      { field: 'distinct indices (count=2)', expected: 4, actual: two },
      { field: 'distinct indices (count=4)', expected: 4, actual: four }
    ])
    expect(one).toBe(MAX_CASCADE_COUNT)
    expect(two).toBe(MAX_CASCADE_COUNT)
    expect(four).toBe(MAX_CASCADE_COUNT)
  })

  it('guards each unrolled cascade against the runtime count', async () => {
    // The guard keeps stale slots past the live count unreachable. Without it
    // the highest stale slot wins, as the selector assigns in order
    const wgsl = await compileSelector(2)
    // One pair per unrolled slot, `0 < object.nodeUniformN` (live) and
    // `0 == ( object.nodeUniformN - 1 )` (last). TSL numbers uniforms
    // globally, so match the shape, not the number
    const activeGuards = wgsl.match(/\d+ < \w+\.nodeUniform\d+/g) ?? []
    // three r186 hoists the shared `count - 1` into one var (#34251), so only
    // the first slot compares against the expression and the rest against that
    // var. Either spelling is the same guard, so count both
    const cseVar = wgsl.match(/(\w+) = \( \w+\.nodeUniform\d+ - 1 \);/)?.[1]
    const inlineLast = wgsl.match(/\d+ == \( \w+\.nodeUniform\d+ - 1 \)/g) ?? []
    const hoistedLast = cseVar
      ? (wgsl.match(new RegExp(`\\d+ == ${cseVar}\\b`, 'g')) ?? [])
      : []
    const lastTests = [...inlineLast, ...hoistedLast]
    log('fadedCascadeIndex-guard', [
      {
        field: 'active guards (i < count)',
        expected: MAX_CASCADE_COUNT,
        actual: activeGuards.length
      },
      {
        field: 'last-cascade tests (i == count-1)',
        expected: MAX_CASCADE_COUNT,
        actual: lastTests.length
      }
    ])
    // Every slot guarded, and "which is last" decided at runtime: the two
    // properties that let one graph serve any cascade count
    expect(activeGuards).toHaveLength(MAX_CASCADE_COUNT)
    expect(lastTests).toHaveLength(MAX_CASCADE_COUNT)
  })

  it('is deterministic — the same inputs compile to the same shader', async () => {
    const [a, b] = await Promise.all([compileSelector(3), compileSelector(3)])
    expect(normalise(a)).toBe(normalise(b))
  })
})
