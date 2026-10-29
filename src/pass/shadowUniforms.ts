// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// The shadow march pass's uniform set: one plain uniform per shadow knob, plus
// the per-draw matrices and the cascade slot the resolve writes through

import { Matrix4, type Vector2 } from 'three'
import { uniform } from 'three/tsl'
import type { UniformNode } from 'three/webgpu'

import type { CloudsContext } from '../CloudsContext'

export interface ShadowPassUniforms {
  maxIterationCount: UniformNode<'float', number>
  minStepSize: UniformNode<'float', number>
  maxStepSize: UniformNode<'float', number>
  minDensity: UniformNode<'float', number>
  minExtinction: UniformNode<'float', number>
  minTransmittance: UniformNode<'float', number>
  opticalDepthTailScale: UniformNode<'float', number>
  inverseShadowMatrix: UniformNode<'mat4', Matrix4>
  reprojectionMatrix: UniformNode<'mat4', Matrix4>
  mipLevel: UniformNode<'float', number>
  cascadeIndex: UniformNode<'float', number>
  shadowResolution: UniformNode<'vec2', Vector2>
}

export function createShadowPassUniforms(
  ctx: CloudsContext
): ShadowPassUniforms {
  return {
    maxIterationCount: uniform(ctx.shadow.maxIterationCount).setName(
      'shadow_maxIterationCount'
    ),
    minStepSize: uniform(ctx.shadow.minStepSize).setName('shadow_minStepSize'),
    maxStepSize: uniform(ctx.shadow.maxStepSize).setName('shadow_maxStepSize'),
    minDensity: uniform(ctx.shadow.minDensity).setName('shadow_minDensity'),
    minExtinction: uniform(ctx.shadow.minExtinction).setName(
      'shadow_minExtinction'
    ),
    minTransmittance: uniform(ctx.shadow.minTransmittance).setName(
      'shadow_minTransmittance'
    ),
    opticalDepthTailScale: uniform(ctx.shadow.opticalDepthTailScale).setName(
      'shadow_opticalDepthTailScale'
    ),
    inverseShadowMatrix: uniform(new Matrix4()).setName(
      'shadow_inverseShadowMatrix'
    ),
    reprojectionMatrix: uniform(new Matrix4()).setName(
      'shadow_reprojectionMatrix'
    ),
    mipLevel: uniform(0).setName('shadow_mipLevel'),
    cascadeIndex: uniform(0).setName('shadow_cascadeIndex'),
    shadowResolution: uniform(ctx.shadow.mapSize.clone()).setName(
      'shadow_shadowResolution'
    )
  }
}

// Cite: ShadowPass.ts (temporalAlpha 0.01, per frame). With updateInterval N
// the resolve runs every N frames, so it blends 1 − (1 − 0.01)^N to keep the
// reference's convergence per wall-clock frame
export function shadowTemporalAlpha(ctx: CloudsContext): number {
  // Round-robin resolves each cascade once per cycle of cascadeCount updates
  const cycle =
    ctx.experimental.shadowRoundRobin && !ctx.experimental.computeResolve
      ? Math.max(1, ctx.shadow.cascadeCount)
      : 1
  const interval = Math.max(1, Math.floor(ctx.shadow.updateInterval)) * cycle
  // Exactly the reference's constant at the reference's interval
  return interval === 1 ? 0.01 : 1 - Math.pow(1 - 0.01, interval)
}

export function updateShadowPassUniforms(
  u: ShadowPassUniforms,
  ctx: CloudsContext
): void {
  u.maxIterationCount.value = ctx.shadow.maxIterationCount
  u.minStepSize.value = ctx.shadow.minStepSize
  u.maxStepSize.value = ctx.shadow.maxStepSize
  u.minDensity.value = ctx.shadow.minDensity
  u.minExtinction.value = ctx.shadow.minExtinction
  u.minTransmittance.value = ctx.shadow.minTransmittance
  u.opticalDepthTailScale.value = ctx.shadow.opticalDepthTailScale
  u.shadowResolution.value.copy(ctx.shadow.mapSize)
}
