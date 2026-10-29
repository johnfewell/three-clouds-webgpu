import { DataTexture } from 'three'
import { texture, uniform } from 'three/tsl'
import { StorageTexture } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import {
  readsOutsideAssigningBlock,
  varsAssigned
} from '../../test/helpers/branchScope'
import { compileComputeWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { buildComputeCloudsResolve } from './computeResolve'

describe('tiled compute resolve', () => {
  for (const upscale of [false, true]) {
    it(`compiles shared tiles and barrier for upscale=${upscale}`, () => {
      const color = new DataTexture(new Uint8Array(16 * 16 * 4), 16, 16)
      const target = new StorageTexture(63, 61)
      const kernel = buildComputeCloudsResolve(
        {
          colorBuffer: color,
          depthVelocityBuffer: color,
          colorHistoryNode: texture(color),
          resolveWidth: uniform(63),
          resolveHeight: uniform(61),
          frame: uniform(0),
          varianceGamma: uniform(2),
          temporalAlpha: uniform(0.01)
        },
        null,
        upscale,
        target
      )
      const shader = compileComputeWGSL(kernel)
      expect(shader).toContain('var<workgroup>')
      expect(shader).toContain('workgroupBarrier()')
      expect(shader).toContain('textureStore')
      expect(shader).not.toContain('textureSample(')
      expect(shader.indexOf('workgroupBarrier()')).toBeLessThan(
        shader.indexOf('textureStore')
      )
      expect(kernel.count).toBeNull()
      // Every lane reads the tile origin, so no read may sit outside the block
      // that assigns it (zero for the lanes that skipped the fill's branch)
      const origins = varsAssigned(shader, /workgroupId\.xy \) \* vec2<i32>/)
      const outside = origins.flatMap(n =>
        readsOutsideAssigningBlock(shader, n)
      )
      expect(origins.length, 'the tile origin is held in vars').toBeGreaterThan(
        0
      )
      expect(outside).toEqual([])
      log('compute resolve WGSL', {
        upscale,
        bytes: shader.length,
        tileOriginVars: origins.length,
        readsOutsideAssigningBlock: outside.length,
        workgroup: kernel.workgroupSize
      })
      kernel.dispose()
      color.dispose()
      target.dispose()
    })
  }
})
