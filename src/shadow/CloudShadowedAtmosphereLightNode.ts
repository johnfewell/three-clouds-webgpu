// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: CloudsEffect.ts:421–431 (AtmosphereShadow → CloudShadowDescriptor)
// Cite: ADR-007 (two shadow consumers: 3.2a aerial, 3.2b light-node)

import { float, positionWorld, vec4 } from 'three/tsl'
import type { Node, NodeBuilder } from 'three/webgpu'

import {
  AtmosphereLightNode,
  getAtmosphereContext,
  type AtmosphereLight
} from '@takram/three-atmosphere/webgpu'

export class CloudShadowedAtmosphereLightNode extends AtmosphereLightNode {
  static override get type(): string {
    return 'CloudShadowedAtmosphereLightNode'
  }

  shadowTransmittanceFn:
    | ((
        pos: Node<'vec3'>,
        radius: Node<'float'>,
        jitter: Node<'float'>
      ) => Node<'float'>)
    | null = null

  // Cite: @takram/three-atmosphere shared.js:445-446 passes a per-pixel shadow
  // radius and STBN jitter to the PCF sampler. Without them shadows are hard
  //. Optional, so an unwired consumer still builds
  shadowRadiusFn: ((worldPosition: Node<'vec3'>) => Node<'float'>) | null = null
  stbnNode: Node<'float'> | null = null

  constructor(light?: AtmosphereLight | null) {
    super(light)
  }

  // DirectLightData is on no public three entry, so derive it from the
  // superclass instead of importing it from a three source path
  override setupDirect(
    builder: NodeBuilder
  ): ReturnType<AtmosphereLightNode['setupDirect']> {
    const result = super.setupDirect(builder)
    if (result == null || this.shadowTransmittanceFn == null) {
      return result
    }

    const ctx = getAtmosphereContext(builder)

    // Reconstruct positionECEF from world position
    let positionECEF = ctx.matrixWorldToECEF.mul(vec4(positionWorld, 1)).xyz
    if (ctx.correctAltitude) {
      positionECEF = positionECEF.add(ctx.altitudeCorrectionECEF)
    }

    // shared.js:445-446: per-pixel adaptive radius + STBN, not a point sample
    const radius =
      this.shadowRadiusFn != null
        ? this.shadowRadiusFn(positionWorld)
        : float(0)
    const jitter = this.stbnNode ?? float(0)
    const shadow = this.shadowTransmittanceFn(positionECEF, radius, jitter)

    return {
      lightDirection: result.lightDirection,
      // AtmosphereLightNode's result crosses the atmosphere package boundary
      lightColor: (result.lightColor as unknown as Node<'vec3'>).mul(shadow)
    }
  }
}
