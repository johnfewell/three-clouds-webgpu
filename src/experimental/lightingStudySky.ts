// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Replaces the cloud sky-gradient term only in the controlled study
// Cite: clouds.frag:575-578

import { Vector3 } from 'three'
import {
  acos,
  atan,
  clamp,
  float,
  Fn,
  min,
  mix,
  smoothstep,
  texture3D,
  vec2,
  vec3
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import type { LightingStudy } from './lightingStudy'

export function createStudySky(study: LightingStudy) {
  if (study.skyCache == null || study.phaseWeights == null) return {}
  const lo = vec3(new Vector3(...study.minimum))
  const size = vec3(new Vector3(...study.maximum)).sub(lo)
  const volumes = study.skyCache.map(value => {
    const node = texture3D(value)
    node.updateMatrix = false
    return node
  })
  const tables = study.phaseWeights.map(value => {
    const node = texture3D(value)
    node.updateMatrix = false
    return node
  })
  let weights: Node<'float'>[] = []
  return {
    prepareSkylight: (direction: Node<'vec3'>) => {
      const uv = vec2(
        atan(direction.z, direction.x)
          .div(2 * Math.PI)
          .add(0.5),
        acos(clamp(direction.y, -1, 1)).div(Math.PI)
      )
      const first = tables[0]!.sample(vec3(uv, 0.5)).level(float(0)).toVar()
      const second = tables[1]!.sample(vec3(uv, 0.5)).level(float(0)).toVar()
      weights = [
        first.x,
        first.y,
        first.z,
        first.w,
        second.x,
        second.y,
        second.z,
        second.w
      ]
    },
    skySource: Fn(([position, baseline]: [Node<'vec3'>, Node<'vec3'>]) => {
      const uv = position.sub(lo).div(size)
      const result = vec3(0).toVar()
      for (let i = 0; i < volumes.length; i++)
        result.addAssign(
          volumes[i]!.sample(uv).level(float(0)).rgb.mul(weights[i]!)
        )
      const edge = min(uv, vec3(1).sub(uv))
      const fraction = min(edge.x, min(edge.y, edge.z))
      const blend = smoothstep(
        float(0),
        float(2 / study.skyCache![0]!.image.width),
        fraction
      )
      return mix(baseline, result, blend)
    })
  }
}
