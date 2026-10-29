// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:701–716 (applyAerialPerspective)

import { distance, float, Fn, max, min, select, vec2, vec4 } from 'three/tsl'
import type { Node, StructNode } from 'three/webgpu'

import { atmosphereWorldToUnit } from '../lighting/sunSkyLight'

// clouds.frag:701–716. The only place the cloud volume receives atmosphere,
// which is why the composite comes after aerial on the scene (ADR-001), and
// multiplying by color.a keeps the encoding associated (ADR-002)

// `shadowLength` is the marched shaft length to the front, in metres
// (clouds.frag:942). Bruneton reads it as the last metres of the ray
// (runtime.glsl:318–322, Eq. 17), ADR-005's vec2 (.x length, .y its start)

// Ending at the point, the runtime takes Eq. 17 for either
// accurateShadowScattering. It was vec2(0) until
// the zero shadow length, leaving shafts out of in-scatter
export function createApplyAerialPerspective(
  // Structural call signature rather than ReturnType<typeof factory>, see
  // secondaryGroundMarch.ts. Returns a struct read with
  // .get('transmittance' | 'luminance')
  getIndirectLuminanceToPoint: (
    cameraPositionECEF: Node<'vec3'>,
    frontPositionECEF: Node<'vec3'>,
    shadowLength: Node<'vec2'>
  ) => StructNode
) {
  return Fn(
    ([cameraPositionECEF, frontPositionECEF, shadowLength, color]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'vec4'>
    ]) => {
      const transfer = getIndirectLuminanceToPoint(
        cameraPositionECEF,
        frontPositionECEF,
        shadowLengthToPoint(
          distance(frontPositionECEF, cameraPositionECEF),
          shadowLength
        ).mul(atmosphereWorldToUnit())
      )
      const transmittance = transfer.get('transmittance') as Node<'vec3'>
      const inscatter = transfer.get('luminance') as Node<'vec3'>
      const rgb = color.xyz.mul(transmittance).add(inscatter.mul(color.w))
      return vec4(rgb, color.w)
    }
  )
}

// The ADR-005 segment for a scalar shadow length on a ray of length
// `rayLength`, both in metres: the last `shadowLength` metres, capped at the
// ray. Unit conversion is the caller's.
export function shadowLengthToPoint(
  rayLength: Node<'float'>,
  shadowLength: Node<'float'>
): Node<'vec2'> {
  const x = max(min(shadowLength, rayLength), float(0))
  return vec2(x, rayLength.sub(x))
}

// The same contract for the aerial node's screen-space attachment, in
// metres. A geometry pixel gets the surface-end segment (runtime.glsl:318-322,
// Eq. 17), a sky pixel (L, 0), Eq. 18 (atmosphere-webgpu/runtime.ts:346)

// `.y` is from the real camera: the runtime moves it itself for an in-space
// camera (runtime.ts:193-196, 722-725)
export const shadowLengthToAttachment = /*#__PURE__*/ Fn(
  ([shadowLength, sceneRayDistance]: [Node<'float'>, Node<'float'>]) =>
    select(
      sceneRayDistance.greaterThan(0),
      shadowLengthToPoint(sceneRayDistance, shadowLength),
      vec2(max(shadowLength, float(0)), 0)
    )
)

// CPU twin for testing

export function shadowLengthToPointCPU(
  rayLength: number,
  shadowLength: number
): [number, number] {
  const x = Math.max(Math.min(shadowLength, rayLength), 0)
  return [x, rayLength - x]
}

export function shadowLengthToAttachmentCPU(
  shadowLength: number,
  sceneRayDistance: number
): [number, number] {
  return sceneRayDistance > 0
    ? shadowLengthToPointCPU(sceneRayDistance, shadowLength)
    : [Math.max(shadowLength, 0), 0]
}

export function applyAerialPerspectiveCPU(
  colorRGB: [number, number, number],
  opacity: number,
  transmittance: [number, number, number],
  inscatter: [number, number, number]
): [number, number, number, number] {
  return [
    colorRGB[0] * transmittance[0] + inscatter[0] * opacity,
    colorRGB[1] * transmittance[1] + inscatter[1] * opacity,
    colorRGB[2] * transmittance[2] + inscatter[2] * opacity,
    opacity
  ]
}
