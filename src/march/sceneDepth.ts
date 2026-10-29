// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:812–821 (getRayDistanceToScene)
// Cite: clouds.frag:101–107 (getViewZ)

import type { Camera } from 'three'
import { float, Fn, select, struct, uv, vec2 } from 'three/tsl'
import type { Node, NodeBuilder, TextureNode } from 'three/webgpu'

import { depthToViewZ } from '@takram/three-geospatial/webgpu'

// (rayDistance, viewZ) as a struct, read with .get('rayDistance')
export const sceneDepthStruct = /*#__PURE__*/ struct(
  { rayDistance: 'float', viewZ: 'float' },
  'SceneDepthResult'
)

export interface SceneDepthDeps {
  sceneDepthTexture: TextureNode
  camera: Camera
  reversedDepthBuffer?: boolean
  logarithmicDepthBuffer?: boolean
  targetUvScale?: Node<'vec2'>
  temporalJitter?: Node<'vec2'>
}

// Cite: clouds.frag:812–821, read scene depth and convert to ray distance
// The renderer owns the clear-depth convention and logarithmic decoding
// An explicit reversedDepthBuffer overrides only the clear-depth test
export function createGetRayDistanceToScene(deps: SceneDepthDeps) {
  const {
    sceneDepthTexture,
    camera,
    reversedDepthBuffer,
    targetUvScale,
    temporalJitter
  } = deps

  const scale = targetUvScale ?? vec2(1)
  const jitter = temporalJitter ?? vec2(0)

  return /*#__PURE__*/ Fn(
    (
      [rayDirection, cameraDirection]: [Node<'vec3'>, Node<'vec3'>],
      builder: NodeBuilder
    ) => {
      // Cite: clouds.frag:813 (vUv * targetUvScale + temporalJitter). The depth
      // is sampled at the pixel's own uv now that the ray is on its true row
      // (ADR-013 Amendment 5)

      // The old v flip matched a mirrored ray, and kept, it dropped the deck
      // view from r = 0.99 to 0.40. Projection jitter is bottom-up, so the
      // top-down lookup needs -jitter.y
      const adjustedUv = uv().mul(scale).add(vec2(jitter.x, jitter.y.negate()))
      const rawDepth = sceneDepthTexture.sample(adjustedUv).r
      const reversed =
        reversedDepthBuffer ?? builder.renderer.reversedDepthBuffer
      const hasGeometry = reversed
        ? rawDepth.greaterThan(0)
        : rawDepth.lessThan(float(1.0 - 1e-7))
      // Unlike the GLSL helper, depthToViewZ already decodes logarithmic depth
      // Decode once, with the scene camera rather than the fullscreen camera
      const rawViewZ = depthToViewZ(rawDepth, camera)
      const rawRayDistance = rawViewZ
        .negate()
        .div(rayDirection.dot(cameraDirection))
      return sceneDepthStruct(
        select(hasGeometry, rawRayDistance, float(0)),
        select(hasGeometry, rawViewZ, float(0))
      )
    }
  )
}

// CPU twins

// Cite: clouds.frag:815 (reverseLogDepth = logarithmicToPerspectiveDepth)
// three.js: viewZ = -e^(depth * ln(far/near)) * near
//           perspDepth = (near + viewZ) * far / ((far - near) * viewZ)
export function logarithmicToPerspectiveDepthCPU(
  depth: number,
  near: number,
  far: number
): number {
  const viewZ = -Math.exp(depth * Math.log(far / near)) * near
  return ((near + viewZ) * far) / ((far - near) * viewZ)
}

export function perspectiveDepthToViewZCPU(
  depth: number,
  near: number,
  far: number,
  reversed: boolean = false
): number {
  if (reversed) {
    return (near * far) / ((near - far) * depth - near)
  }
  return (near * far) / ((far - near) * depth - far)
}

export function orthographicDepthToViewZCPU(
  depth: number,
  near: number,
  far: number,
  reversed: boolean = false
): number {
  if (reversed) {
    return depth * (far - near) - far
  }
  return depth * (near - far) - near
}

export function getRayDistanceToSceneCPU(
  depth: number,
  near: number,
  far: number,
  isPerspective: boolean,
  reversedDepthBuffer: boolean,
  rayDirDotCamDir: number
): { viewZ: number; rayDistance: number } {
  const noGeometry = reversedDepthBuffer ? depth <= 0 : depth >= 1 - 1e-7

  if (noGeometry) {
    return { viewZ: 0, rayDistance: 0 }
  }

  const viewZ = isPerspective
    ? perspectiveDepthToViewZCPU(depth, near, far, reversedDepthBuffer)
    : orthographicDepthToViewZCPU(depth, near, far, reversedDepthBuffer)

  const rayDistance = -viewZ / rayDirDotCamDir
  return { viewZ, rayDistance }
}
