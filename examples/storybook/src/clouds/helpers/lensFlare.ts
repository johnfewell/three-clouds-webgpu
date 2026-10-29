import type { LensFlareNode } from '@takram/three-geospatial/webgpu'

// Set up like the WebGL original's <LensFlare />: its intensity (0.005) and no
// glare. The WebGPU defaults bloom 10x brighter and add 4-ray spikes
export function matchWebGLLensFlare(node: LensFlareNode): LensFlareNode {
  node.bloomIntensity.value = 0.005
  node.glareNode.intensity.value = 0
  return node
}
