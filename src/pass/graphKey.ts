// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// The cache key that tells three when the pass's graph changed, and the device
// query that decides one of the graph-time switches

// `hash` and `hashString` reach us through the NodeUtils namespace three
// re-exports from three/webgpu. They also live at
// three/src/nodes/core/NodeUtils.js, a source path no peer range covers
import { NodeUtils, type NodeBuilder } from 'three/webgpu'

import type { CloudsContext } from '../CloudsContext'

const { hash, hashString } = NodeUtils

// Exported for the drift test: graphFlags() and this are two hand-kept lists
// that once diverged. The test flips every graphFlags field and asserts the hash
// moves
export function hashGraphFlags(
  enabled: boolean,
  sceneDepthNull: boolean,
  flags: ReturnType<CloudsContext['graphFlags']>
): number {
  return hash(
    +enabled,
    +sceneDepthNull,
    +flags.shapeDetail,
    +flags.turbulence,
    +flags.lightShafts,
    +flags.lightShaftsHalfResolution,
    +flags.haze,
    +flags.temporalUpscale,
    +flags.accurateSunSkyLight,
    +flags.accuratePhaseFunction,
    flags.multiScatteringOctaves,
    // Floats: hashed through their string form so 0.7 and 0.70001 differ
    hashString(String(flags.scatterAnisotropy1)),
    hashString(String(flags.scatterAnisotropy2)),
    hashString(String(flags.scatterAnisotropyMix)),
    hashString(flags.localWeatherChannels),
    hashString(flags.layerStructure),
    flags.shadowCascadeCount,
    +flags.shadowTemporalJitter,
    +flags.shadowTemporalPass,
    +flags.castsShadow,
    +flags.groundBounce,
    +flags.logarithmicDepthBuffer,
    hashString(flags.debug),
    flags.experimentalFlags,
    // The four shape controls are graph-time literals, so the whole object is
    // one string: a magnitude moving is as much a rebuild as a gate opening
    hashString(flags.cloudShape)
  )
}

// Quad operations (lightShaftsHalfResolution) need `subgroups`, which three
// requests when offered. Without it the march silently runs per fragment: the
// flag is a performance preference, not a rendering contract
export function supportsQuadOperations(builder: NodeBuilder): boolean {
  const renderer = builder.renderer as unknown as {
    hasFeature?: (name: string) => boolean
  }
  return renderer.hasFeature?.('subgroups') === true
}
