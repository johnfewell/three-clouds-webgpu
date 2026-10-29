// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: ADR-005 (shadowLength vec2 encoding)

import { float, Fn, uv, vec2 } from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

export interface CloudShadowLengthDeps {
  // The shadow-length history as a LIVE handle: its .value follows the resolve
  // swap (CloudsPassNode.swapShadowLengthBuffers) and holds a placeholder with
  // the real target's sampling contract until the targets exist
  shadowLengthTextureNode: TextureNode
  // Read when the consumer builds, not when the node is minted: the graph flags
  // rebuild every consumer through graphVersion. Deciding at mint time left the
  // aerial node holding a null
  isLive: () => boolean
}

// Cite: ADR-005, vec2(.x = shadowLength A→B, .y = camera→A). The attachment
// already holds it in the atmosphere's unit (shadowLengthToAttachment),
// so it passes through with no conversion or rebase

// `.y` is from the real camera, and the runtime moves it for an in-space camera
// (atmosphere-webgpu/runtime.ts:193-196, 722-725). A rebase here moved it twice

// One node for the life of the pass: consumers capture it at construction and
// the aerial node stores it by value, like the atlas's mapNode. A producer's
// public node must exist from construction, never be minted in setup()
export function buildCloudShadowLength(
  deps: CloudShadowLengthDeps
): Node<'vec2'> {
  return Fn(() => {
    if (!deps.isLive()) {
      return vec2(0, 0)
    }
    // Top-level uniform flow, but the LOD is stated rather than inferred: the
    // atlas read taught us what an implicit sample costs
    const sample = deps.shadowLengthTextureNode.sample(uv()).level(float(0))
    return vec2(sample.x, sample.y)
  })()
}

// CPU twin for testing

export function cloudShadowLengthCPU(
  shadowLengthVal: number,
  shadowStartVal: number,
  lightShafts: boolean,
  enabled: boolean
): [number, number] {
  if (!lightShafts || !enabled) return [0, 0]
  return [shadowLengthVal, shadowStartVal]
}
