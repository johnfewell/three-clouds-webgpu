// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: cloudsResolve.frag SHADOW_LENGTH branches
//
// The GPU resolve of the shadow length lives in cloudsResolve.ts
// (buildCloudsResolve): one pass writes colour and shadow length, as the
// reference does. This file keeps the CPU twin of the shadow-length branch.
import { varianceClippingCPU } from './varianceClipping'

export function shadowLengthResolveCPU(opts: {
  current: [number, number, number, number]
  history: [number, number, number, number]
  prevUvInBounds: boolean
  isCurrentFrame: boolean
  neighbours: [number, number, number, number][]
  gamma: number
}): [number, number, number, number] {
  const {
    current,
    history,
    prevUvInBounds,
    isCurrentFrame,
    neighbours,
    gamma
  } = opts

  if (isCurrentFrame) {
    return [...current]
  }

  if (!prevUvInBounds) {
    return [...current]
  }

  return varianceClippingCPU(current, neighbours, history, gamma)
}
