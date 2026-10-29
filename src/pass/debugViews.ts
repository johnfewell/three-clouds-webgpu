// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// The two places a debug view enters the graph: the cascade overlay the march
// carries, and the colour the resolve pass writes for the resolve-side views

import { float, texture as tslTexture, uv, vec3, vec4 } from 'three/tsl'
import type { Node, Texture } from 'three/webgpu'

import { turbo } from '@takram/three-geospatial/webgpu'

import type { CloudsContext, DebugView } from '../CloudsContext'
import type { CloudShadowDescriptor } from '../CloudsPassNode'
import { createDebugCascadeColor } from '../march/debugCascadeColor'
import type { MarchCloudsDeps } from '../march/primaryMarch'
import type { CloudsResolveOutputs } from '../resolve/cloudsResolve'
import { createFadedCascadeIndex } from '../shadow/fadedCascadeIndex'

// Cite: clouds.frag:585–589, DEBUG_SHOW_CASCADES. A function keeps the march's
// factory wiring under the complexity gate

// Independent of the BSM `shadows` predicate: cascade selection reads only
// intervals and far, so the view works with no shadow-casting layers

// `cloudShadow` is a thunk because the descriptor is minted lazily, and every
// other debug view must not mint it just by building
export function buildDebugCascadeColor(opts: {
  debug: DebugView
  viewMatrix: Node<'mat4'>
  cameraNear: Node<'float'>
  ecefToWorldMatrix: Node<'mat4'>
  altitudeCorrection: Node<'vec3'>
  cascadeCount: number
  cloudShadow: () => CloudShadowDescriptor
}): MarchCloudsDeps['getDebugCascadeColor'] {
  if (opts.debug !== 'cascades') return undefined
  const desc = opts.cloudShadow()
  return createDebugCascadeColor({
    getFadedCascadeIndex: createFadedCascadeIndex({
      viewMatrix: opts.viewMatrix,
      cameraNear: opts.cameraNear,
      shadowFar: desc.far,
      shadowIntervals: desc.intervals,
      cascadeCount: desc.cascadeCountNode
    }),
    ecefToWorldMatrix: opts.ecefToWorldMatrix,
    altitudeCorrection: opts.altitudeCorrection,
    cascadeCount: opts.cascadeCount
  })
}

// Cite: cloudsResolve.frag:170–176 (resolve debug views). The shadow-length view
// shows the resolved length, as the reference does, and keeps both attachments:
// a lone vec4 failed pipeline creation
export function resolveDebugColor(
  ctx: CloudsContext,
  resolved: CloudsResolveOutputs,
  depthVelocityBuffer: Texture
): Node<'vec4'> {
  if (ctx.debug === 'shadowLength' && resolved.shadowLength != null) {
    return vec4(turbo(resolved.shadowLength.x.mul(0.05)), 1)
  }
  if (ctx.debug === 'velocity') {
    const dvTexNode = tslTexture(depthVelocityBuffer)
    const vel = dvTexNode.sample(uv()).gb.abs().mul(10)
    return vec4(
      resolved.color.xyz.add(vec3(vel.x, vel.y, float(0))),
      resolved.color.w
    )
  }
  return resolved.color
}
