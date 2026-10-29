import type { LensFlareNode } from '@takram/three-geospatial/webgpu'

// Match the WebGL reference lens flare intensity (0.005) with zero glare spikes
export function matchWebGLLensFlare(node: LensFlareNode): LensFlareNode {
  node.bloomIntensity.value = 0.005
  node.glareNode.intensity.value = 0
  return node
}
