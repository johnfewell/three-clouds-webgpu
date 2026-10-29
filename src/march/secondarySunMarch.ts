// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:346–395

import {
  float,
  Fn,
  If,
  int,
  length,
  Loop,
  remapClamp,
  vec2,
  vec4
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import { getGlobeUv } from '../density/globeUv'
import { computeMediaOutputs } from '../density/sampleShape'
import { sunMarchIterationCount } from '../experimental/distantShadows'

export interface MarchOpticalDepthDeps {
  sampleWeather: (
    uv: Node<'vec2'>,
    height: Node<'float'>,
    mipLevel: Node<'float'>,
    heightFraction?: Node<'vec4'>
  ) => Node<'vec4'>
  sampleMedia: (
    weatherDensity: Node<'vec4'>,
    weatherHeightFraction: Node<'vec4'>,
    position: Node<'vec3'>,
    uv: Node<'vec2'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec4'>
  bottomRadius: Node<'float'>
  minSecondaryStepSize: Node<'float'>
  secondaryStepScale: Node<'float'>
  minLayerHeights: Node<'vec4'>
  maxLayerHeights: Node<'vec4'>
  scatteringCoefficient: Node<'float'>
  absorptionCoefficient: Node<'float'>
}

// clouds.frag:346–377
export function createMarchOpticalDepth(deps: MarchOpticalDepthDeps) {
  const {
    sampleWeather,
    sampleMedia,
    bottomRadius,
    minSecondaryStepSize,
    secondaryStepScale,
    minLayerHeights,
    maxLayerHeights,
    scatteringCoefficient,
    absorptionCoefficient
  } = deps

  return /*#__PURE__*/ Fn(
    ([rayOrigin, rayDirection, maxIterationCount, mipLevel, jitter]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const iterationCount = sunMarchIterationCount(
        maxIterationCount,
        mipLevel,
        jitter
      )

      const opticalDepth = float(0).toVar()
      const rayDistance = float(0).toVar()

      // TODO(port): Remove fudge factor (clouds.frag:358–360)
      If(iterationCount.equal(0), () => {
        opticalDepth.assign(0.5)
      }).Else(() => {
        const stepSize = float(minSecondaryStepSize)
          .div(float(iterationCount))
          .toVar()
        const nextDistance = stepSize.mul(jitter).toVar()

        Loop(
          { start: int(0), end: iterationCount, type: 'int', condition: '<' },
          () => {
            rayDistance.assign(nextDistance)
            const position = rayDirection.mul(rayDistance).add(rayOrigin)
            const uv = getGlobeUv(position)
            const height = length(position).sub(bottomRadius)
            const fraction = remapClamp(
              vec4(height),
              minLayerHeights,
              maxLayerHeights
            ).toVar()
            const weatherDensity = sampleWeather(uv, height, mipLevel, fraction)
            const mediaDensity = sampleMedia(
              weatherDensity,
              fraction,
              position,
              uv,
              mipLevel,
              jitter
            )
            const { extinction } = computeMediaOutputs(
              mediaDensity,
              scatteringCoefficient,
              absorptionCoefficient
            )
            opticalDepth.addAssign(extinction.mul(stepSize))
            nextDistance.addAssign(stepSize)
            stepSize.mulAssign(secondaryStepScale)
          }
        )
      })

      // (opticalDepth, rayDistance) packed as vec2, a Fn returns one node
      return vec2(opticalDepth, rayDistance)
    }
  )
}

// CPU twin: iteration count formula
export function iterationCountCPU(
  maxIterationCount: number,
  mipLevel: number,
  jitter: number
): number {
  const remapped = maxIterationCount + 1 - maxIterationCount * mipLevel
  return Math.max(0, Math.trunc(remapped - jitter))
}

// CPU twin: OD accumulation with constant extinction (no texture sampling)
export function marchOpticalDepthCPU(
  extinction: number,
  maxIterationCount: number,
  mipLevel: number,
  jitter: number,
  minSecondaryStepSize: number,
  secondaryStepScale: number
): { opticalDepth: number; rayDistance: number } {
  const count = iterationCountCPU(maxIterationCount, mipLevel, jitter)

  if (count === 0) {
    return { opticalDepth: 0.5, rayDistance: 0 }
  }

  let stepSize = minSecondaryStepSize / count
  let nextDistance = stepSize * jitter
  let opticalDepth = 0
  let rayDistance = 0

  for (let i = 0; i < count; i++) {
    rayDistance = nextDistance
    opticalDepth += extinction * stepSize
    nextDistance += stepSize
    stepSize *= secondaryStepScale
  }

  return { opticalDepth, rayDistance }
}

// Closed-form geometric series for verification
export function geometricSeriesOD(
  extinction: number,
  iterationCount: number,
  minSecondaryStepSize: number,
  secondaryStepScale: number
): number {
  if (iterationCount === 0) return 0.5
  const s = minSecondaryStepSize / iterationCount
  if (secondaryStepScale === 1) {
    return extinction * s * iterationCount
  }
  return (
    (extinction * s * (Math.pow(secondaryStepScale, iterationCount) - 1)) /
    (secondaryStepScale - 1)
  )
}
