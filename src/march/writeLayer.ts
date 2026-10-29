// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:617 (opacity from transmittance via remapClamped)
// Cite: ADR-002 (associated color + OPACITY convention)

import { float, Fn, remapClamp, select, struct, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// The layer/depthVelocity pair as a struct, read with .get('layer')
export const layerOutputStruct = /*#__PURE__*/ struct(
  { layer: 'vec4', depthVelocity: 'vec4' },
  'CloudLayerOutput'
)

// clouds.frag:614–617, the march accumulators encoded into the layer buffer:
// rgb = associated radiance, a = remapClamped(transmittance, 1, minT)

// depthVelocity.r = frontDepth × worldToUnit (unit space, AUDIT-4), .gb the
// velocity added in Phase 2
export const writeLayer = /*#__PURE__*/ Fn(
  ([
    radianceIntegral,
    transmittanceIntegral,
    minTransmittance,
    weightedDistanceSum,
    transmittanceSum,
    worldToUnit
  ]: [
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    // clouds.frag:614–615
    const wds = float(weightedDistanceSum)
    const ts = float(transmittanceSum)
    const frontDepth = select(ts.greaterThan(0), wds.div(ts), float(-1))

    // clouds.frag:617 + ADR-002
    const opacity = remapClamp(
      float(transmittanceIntegral),
      1.0,
      float(minTransmittance)
    )
    const layer = vec4(radianceIntegral, opacity)

    // AUDIT-4: depth stored in UNIT space (worldToUnit), not metres
    const scaledDepth = frontDepth.mul(float(worldToUnit))
    const depthVelocity = vec4(scaledDepth, 0, 0, 0)

    return layerOutputStruct(layer, depthVelocity)
  }
)
