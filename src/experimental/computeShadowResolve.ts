// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: shadowResolve.frag:32-66 - one workgroup tile per cascade

import {
  float,
  Fn,
  If,
  ivec2,
  localId,
  mix,
  storageTexture,
  texture,
  textureStore,
  uint,
  vec2,
  workgroupBarrier,
  workgroupId
} from 'three/tsl'
import type { StorageArrayTexture } from 'three/webgpu'

import type { ShadowResolveDeps } from '../shadow/shadowResolve'
import {
  createResolveTile,
  createTileClip,
  createTileClosest
} from './computeResolve'

export function buildComputeShadowResolve(
  deps: ShadowResolveDeps,
  output: StorageArrayTexture
) {
  const layer = workgroupId.z.toFloat()
  const opticalDepth = createResolveTile(
    deps.odBuffer,
    deps.resolution,
    8,
    1,
    layer
  )
  const velocity = createResolveTile(
    deps.velocityBuffer,
    deps.resolution,
    8,
    1,
    layer
  )
  const closest = createTileClosest(velocity)
  const clip = createTileClip(opticalDepth, deps.resolution, false)
  const history = texture(deps.historyBuffer)
  return Fn(() => {
    opticalDepth.fill().toStack()
    velocity.fill().toStack()
    workgroupBarrier()
    const coord = ivec2(workgroupId.xy.mul(uint(8)).add(localId.xy))
    If(
      coord.x
        .lessThan(deps.resolution.x.toInt())
        .and(coord.y.lessThan(deps.resolution.y.toInt())),
      () => {
        const uv = vec2(coord).add(0.5).div(deps.resolution)
        const current = opticalDepth.load(coord)
        const result = current.toVar()
        const prevUv = uv.sub(closest(coord).gb.mul(deps.texelSize))
        const valid = prevUv.x
          .greaterThanEqual(0)
          .and(prevUv.x.lessThanEqual(1))
          .and(prevUv.y.greaterThanEqual(0))
          .and(prevUv.y.lessThanEqual(1))
        If(valid, () => {
          const previous = history.sample(prevUv).level(float(0)).depth(layer)
          const clipped = clip(coord, uv, current, previous, deps.varianceGamma)
          result.assign(mix(clipped, current, deps.temporalAlpha))
        })
        // Building the store FROM the layered node: 0.184 has no
        // StorageTextureNode.store(), and `depth()` AFTER a store clones the node
        // the store already left, so the layer never reaches the WGSL
        textureStore(storageTexture(output).depth(layer), coord, result)
      }
    )
  })().computeKernel([8, 8, 1])
}
