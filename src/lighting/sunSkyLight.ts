// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:417–447 (getCloudsSunSkyIrradiance, getGroundSunSkyIrradiance)
// Cite: clouds.vert:46–65 (sampleSunSkyIrradiance, per-frame vertex precomputation)
// Cite: clouds.frag:701–716 (applyAerialPerspective → GetSkyRadianceToPoint)
// eslint-disable-next-line no-comment-slop/no-trailing-period -- verbatim upstream TODO
// TODO(port): Construct spherical harmonics of degree 2 using 2 sample points positioned near the horizon occlusion points on the sun direction plane.

import {
  Fn,
  mix,
  normalize,
  remapClamp,
  struct,
  varying,
  vec2
} from 'three/tsl'
import type { Node, NodeBuilder } from 'three/webgpu'

import {
  getIndirectIlluminance as atmoGetIndirectIlluminance,
  getIndirectLuminance as atmoGetIndirectLuminance,
  getIndirectLuminanceToPoint as atmoGetIndirectLuminanceToPoint,
  getSolarLuminance as atmoGetSolarLuminance,
  getSplitIlluminance as atmoGetSplitIlluminance,
  getSplitScalarIlluminance as atmoGetSplitScalarIlluminance,
  getAtmosphereContext
} from '@takram/three-atmosphere/webgpu'

// ADR-005: no shadow, for the accessor the march never shadows (the sky
// direction one; the reference passes 0 there too)
const ZERO_SHADOW_LENGTH = vec2(0, 0)

const splitIlluminance = /*#__PURE__*/ struct(
  { direct: 'vec3', indirect: 'vec3' },
  'CloudsSplitIlluminance'
)

// Exported so a consumer that adds a light to the direct member rebuilds the
// same struct the producers return, rather than a second one with the same
// members and a different WGSL type name
export { splitIlluminance }

// Units (ADR-013): the original converts with METER_TO_LENGTH_UNIT at each
// accessor (clouds.frag:427, 440, 709–711, clouds.vert:48, 54). Here that is
// parametersNode.worldToUnit, never the march's 1 / bottomRadius scale

// Positions are already altitude-corrected metres (clouds.frag:833). The cast
// is needed because the atmosphere types parametersNode fields as strings
function lengthUnitScale(builder: NodeBuilder): Node<'float'> {
  const { parametersNode } = getAtmosphereContext(builder)
  return (parametersNode as unknown as { worldToUnit: Node<'float'> })
    .worldToUnit
}

function toLengthUnit(
  positionECEF: Node<'vec3'>,
  builder: NodeBuilder
): Node<'vec3'> {
  return positionECEF.mul(lengthUnitScale(builder))
}

// The atmosphere's length-unit scale as a node, for call sites outside a Fn
// body that must convert metres for an atmosphere consumer (e.g. the
// shadow-length output, clouds.frag:1001 METER_TO_LENGTH_UNIT)
export function atmosphereWorldToUnit(): Node<'float'> {
  return Fn((builder: NodeBuilder) => lengthUnitScale(builder))()
}

// Sun disc luminance from the atmosphere LUT
export const cloudsSolarLuminance = /*#__PURE__*/ Fn(() => {
  return atmoGetSolarLuminance()
})

// Accurate path (per-sample LUT reads)

// Cite: clouds.frag:440
export function createCloudsSunSkyIrradiance(sunDirectionECEF: Node<'vec3'>) {
  return Fn(([positionECEF]: [Node<'vec3'>], builder: NodeBuilder) => {
    return atmoGetSplitScalarIlluminance(
      toLengthUnit(positionECEF, builder),
      sunDirectionECEF
    )
  })
}

// Cite: clouds.frag:426
export function createGroundSunSkyIrradiance(sunDirectionECEF: Node<'vec3'>) {
  return Fn(
    (
      [positionECEF, surfaceNormal, height]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'float'>
      ],
      builder: NodeBuilder
    ) => {
      const groundPositionUnit = toLengthUnit(
        positionECEF.sub(surfaceNormal.mul(height)),
        builder
      )
      return atmoGetSplitIlluminance(
        groundPositionUnit,
        surfaceNormal,
        sunDirectionECEF
      )
    }
  )
}

// Interpolated path: varying() runs the LUT lookups in the fullscreen quad's
// vertex stage. Every vertex shares the camera position, so the result is
// constant per fragment, as in clouds.vert:46–65, with no per-sample reads

export interface SunSkyIrradianceCache {
  groundSun: Node<'vec3'>
  groundSky: Node<'vec3'>
  cloudsMinSun: Node<'vec3'>
  cloudsMinSky: Node<'vec3'>
  cloudsMaxSun: Node<'vec3'>
  cloudsMaxSky: Node<'vec3'>
}

// Cite: clouds.vert:46–65. clouds.vert:78 samples at the corrected camera, so
// the atmosphere's altitudeCorrectionUnit (the aerial node's uniform) is added
// to the uncorrected cameraPositionECEF here
export function createSunSkyIrradianceCache(
  sunDirectionECEF: Node<'vec3'>,
  cameraPositionECEF: Node<'vec3'>,
  bottomRadius: Node<'float'>,
  minHeight: Node<'float'>,
  maxHeight: Node<'float'>
): SunSkyIrradianceCache {
  const worldToUnit = Fn((builder: NodeBuilder) => lengthUnitScale(builder))()
  const cameraUnit = Fn((builder: NodeBuilder) => {
    const { altitudeCorrectionUnit } = getAtmosphereContext(builder)
    return cameraPositionECEF
      .mul(lengthUnitScale(builder))
      .add(altitudeCorrectionUnit)
  })()
  const surfaceNormal = normalize(cameraUnit)

  // Ground irradiance at camera position (scalar, no surface normal)
  const groundIllu = atmoGetSplitScalarIlluminance(cameraUnit, sunDirectionECEF)

  // Cloud irradiance at layer bounds: surfaceNormal * (bottomRadius + height)
  const minPos = surfaceNormal.mul(bottomRadius.add(minHeight).mul(worldToUnit))
  const maxPos = surfaceNormal.mul(bottomRadius.add(maxHeight).mul(worldToUnit))
  const minIllu = atmoGetSplitScalarIlluminance(minPos, sunDirectionECEF)
  const maxIllu = atmoGetSplitScalarIlluminance(maxPos, sunDirectionECEF)

  return {
    groundSun: varying(groundIllu.get('direct'), 'vGroundSun'),
    groundSky: varying(groundIllu.get('indirect'), 'vGroundSky'),
    cloudsMinSun: varying(minIllu.get('direct'), 'vCloudsMinSun'),
    cloudsMinSky: varying(minIllu.get('indirect'), 'vCloudsMinSky'),
    cloudsMaxSun: varying(maxIllu.get('direct'), 'vCloudsMaxSun'),
    cloudsMaxSky: varying(maxIllu.get('indirect'), 'vCloudsMaxSky')
  }
}

// Cite: clouds.frag:438–446 (non-accurate path)
export function createCloudsSunSkyIrradianceInterpolated(
  cache: SunSkyIrradianceCache,
  minHeight: Node<'float'>,
  maxHeight: Node<'float'>
) {
  return Fn(([_positionECEF, height]: [Node<'vec3'>, Node<'float'>]) => {
    const alpha = remapClamp(height, minHeight, maxHeight)
    return splitIlluminance(
      mix(cache.cloudsMinSun, cache.cloudsMaxSun, alpha),
      mix(cache.cloudsMinSky, cache.cloudsMaxSky, alpha)
    )
  })
}

// Cite: clouds.frag:432–435 (non-accurate ground path)
export function createGroundSunSkyIrradianceInterpolated(
  cache: SunSkyIrradianceCache
) {
  return Fn(
    ([_positionECEF, _surfaceNormal, _height]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>
    ]) => {
      return splitIlluminance(cache.groundSun, cache.groundSky)
    }
  )
}

// Aerial perspective helpers

export function createGroundIndirectIlluminance(
  sunDirectionECEF: Node<'vec3'>
) {
  return Fn(
    (
      [positionECEF, surfaceNormal, height]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'float'>
      ],
      builder: NodeBuilder
    ) => {
      const groundPositionUnit = toLengthUnit(
        positionECEF.sub(surfaceNormal.mul(height)),
        builder
      )
      return atmoGetIndirectIlluminance(
        groundPositionUnit,
        surfaceNormal,
        sunDirectionECEF
      )
    }
  )
}

export function createIndirectLuminance(sunDirectionECEF: Node<'vec3'>) {
  return Fn(
    (
      [cameraPositionECEF, rayDirection]: [Node<'vec3'>, Node<'vec3'>],
      builder: NodeBuilder
    ) => {
      return atmoGetIndirectLuminance(
        toLengthUnit(cameraPositionECEF, builder),
        rayDirection,
        ZERO_SHADOW_LENGTH,
        sunDirectionECEF
      )
    }
  )
}

// Cite: clouds.frag:708–715. `shadowLength` is the ADR-005 vec2 in the
// atmosphere's length unit (.x shadowed interval, .y camera to its start),
// built by applyAerialPerspective
export function createIndirectLuminanceToPoint(sunDirectionECEF: Node<'vec3'>) {
  return Fn(
    (
      [cameraPositionECEF, pointECEF, shadowLength]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'vec2'>
      ],
      builder: NodeBuilder
    ) => {
      return atmoGetIndirectLuminanceToPoint(
        toLengthUnit(cameraPositionECEF, builder),
        toLengthUnit(pointECEF, builder),
        shadowLength,
        sunDirectionECEF
      )
    }
  )
}

// Sky gradient constant for the march (clouds.frag:574–576)
export const RECIPROCAL_PI4 = 1 / (4 * Math.PI)
