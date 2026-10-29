// The light-node half of ADR-007 (3.2b) for r3f stories: a
// CloudShadowedAtmosphereLightNode subclass reading its shadow functions from a
// holder CloudsPostProcessing fills, so it can be registered in onInit before
// <Clouds> exists. Lit objects gate on the clouds being mounted. Mirrors
// ParityShadowedLightNode in examples/parity/src/sideB.ts

import { CloudShadowedAtmosphereLightNode } from 'three-clouds-webgpu'

import type { AtmosphereLight } from '@takram/three-atmosphere/webgpu'

import type { CloudShadowConsumer } from './CloudsPostProcessing'

export function createCloudShadowedLightNodeClass(holder: {
  current: CloudShadowConsumer | null
}): typeof CloudShadowedAtmosphereLightNode {
  return class StoryCloudShadowedLightNode extends CloudShadowedAtmosphereLightNode {
    static override get type(): string {
      return 'StoryCloudShadowedLightNode'
    }

    constructor(light?: AtmosphereLight | null) {
      super(light)
      const consumer = holder.current
      if (consumer != null) {
        this.shadowTransmittanceFn = consumer.transmittance
        this.shadowRadiusFn = consumer.shadowRadius
        this.stbnNode = consumer.stbn
      }
    }
  }
}
