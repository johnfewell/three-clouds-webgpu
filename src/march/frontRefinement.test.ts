import { float, Fn, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { createRefineCloudFront, refineCloudFrontCPU } from './frontRefinement'

describe('experimental cloud-front refinement', () => {
  it('keeps the dense endpoint within one sixteenth of the bracket', () => {
    for (const boundary of [0.01, 3.1, 49.9, 98.2]) {
      const result = refineCloudFrontCPU(x => x >= boundary, 0, 100)
      expect(result).toBeGreaterThanOrEqual(boundary)
      expect(result - boundary).toBeLessThanOrEqual(100 / 16)
      log('front refinement', { boundary, result, maxError: 100 / 16 })
    }
  })

  it('does not refine an empty endpoint or move an already dense bracket', () => {
    expect(refineCloudFrontCPU(() => false, 0, 100)).toBe(100)
    expect(refineCloudFrontCPU(() => true, 50, 50)).toBe(50)
  })

  it('emits a bounded shader search, including both endpoint updates', () => {
    const occupied = Fn(([position]: [Node<'vec3'>]) =>
      position.x.greaterThanEqual(3.1)
    )
    const refine = createRefineCloudFront(occupied)
    const shader = compileWGSL(
      Fn(() =>
        vec3(
          refine(
            vec3(0),
            vec3(1, 0, 0),
            float(0),
            float(100),
            float(0),
            float(0)
          )
        )
      )()
    ).fragment
    expect(shader).toContain('for (')
    expect(shader).toContain('< 4')
    expect(shader).toContain('else')
    expect(shader).toContain('3.1')
    log('front refinement WGSL', { bytes: shader.length, iterations: 4 })
  })
})
