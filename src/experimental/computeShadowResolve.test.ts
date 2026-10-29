import { DataArrayTexture, Vector2 } from 'three'
import { texture, uniform } from 'three/tsl'
import { StorageArrayTexture } from 'three/webgpu'
import { expect, it } from 'vitest'

import { compileComputeWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { buildComputeShadowResolve } from './computeShadowResolve'

it('compiles shared shadow tiles and a storage array without derivatives', () => {
  const input = new DataArrayTexture(new Uint8Array(16 * 16 * 4 * 3), 16, 16, 3)
  const output = new StorageArrayTexture(16, 16, 3)
  const kernel = buildComputeShadowResolve(
    {
      odBuffer: input,
      velocityBuffer: input,
      historyBuffer: texture(input),
      texelSize: uniform(new Vector2(1 / 16, 1 / 16)),
      resolution: uniform(new Vector2(16, 16)),
      varianceGamma: uniform(1),
      temporalAlpha: uniform(0.01),
      cascadeIndex: uniform(0)
    },
    output
  )
  const shader = compileComputeWGSL(kernel)
  expect(shader).toContain('texture_storage_2d_array')
  expect(shader).toContain('workgroupBarrier()')
  expect(shader).toContain('textureStore')
  // The array layer sits BETWEEN the coord and the value. Matched on the
  // layer's own neighbours, not by splitting the call on commas: the coord
  // nests commas in its parens, and 0.184 has no StorageTextureNode.store()
  expect(shader).toMatch(
    /,\s*i32\(\s*f32\(\s*workgroupId\.z\s*\)\s*\)\s*,\s*\w/
  )

  expect(shader).not.toContain('textureSample(')
  expect(kernel.count).toBeNull()
  log('compute shadow resolve', {
    bytes: shader.length,
    workgroup: kernel.workgroupSize
  })
  kernel.dispose()
  input.dispose()
  output.dispose()
})
