// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: ADR-007 (two shadow consumers: 3.2a aerial, 3.2b light-node)

import type { Node, TextureNode } from 'three/webgpu'

import { AerialPerspectiveNode } from '@takram/three-atmosphere/webgpu'

// The npm 0.19.1 AerialPerspectiveNode has neither input, so assigning them
// would add properties nothing reads and drop cloud shadows silently
export function assertAerialShadowInputs(node: object): void {
  if (!('shadowNode' in node) || !('lightingMaskNode' in node)) {
    throw new Error(
      'AerialPerspectiveNode has no shadowNode / lightingMaskNode input, so ' +
        'cloud shadows on surfaces would not render. Install the ' +
        '@takram/three-atmosphere fork build 0.19.1+fork.7 (see the README)'
    )
  }
}

// The node types are three/webgpu's, and AerialPerspectiveNode's constructor
// declares @takram/three-geospatial/webgpu's structurally distinct Node, so the
// node inputs cross a package boundary on the way in
export function aerialPerspectiveWithCloudShadow(
  colorNode: Node<'vec4'>,
  // The depth TextureNode, not a float read from it: AerialPerspectiveNode
  // samples it itself, as `scenePass.getTextureNode('depth')` on the plain path,
  // and a caller-side `.r` would sample at the wrong uv
  depthNode: Node<'float'> | TextureNode,
  shadowLengthNode: Node<'vec2'> | null,
  shadowNode: Node<'float'> | null,
  // Same as depthNode: the node samples the normal target itself
  normalNode?: Node<'vec3'> | TextureNode,
  lightingMaskNode: Node<'float'> | null = null
): AerialPerspectiveNode {
  const node = new AerialPerspectiveNode(
    colorNode,
    depthNode,
    normalNode,
    shadowLengthNode
  )

  if (shadowNode == null && lightingMaskNode == null) return node
  assertAerialShadowInputs(node)
  // AerialPerspectiveNode multiplies only the direct solar term by shadowNode
  // and blends post-lit with self-lit by lightingMaskNode (ADR-007 3.2a)
  node.shadowNode = shadowNode
  node.lightingMaskNode = lightingMaskNode
  return node
}
