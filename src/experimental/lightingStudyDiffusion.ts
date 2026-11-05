// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Alternative to clouds.frag:397-415 for controlled lighting studies
// https://github.com/mjurczyk/openvdb/blob/30468122517807d41c666363ec39636a150db91a/src/three-openvdb/frame/webgpu/frameShaderChunks.js

import { exp, float, Fn, max, sqrt } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { phaseFunction, phaseFunctionTSL } from '../lighting/phaseFunction'

export function diffusionSource(
  opticalDepth: number,
  cosine: number,
  scattering: number,
  absorption: number,
  phase: readonly [number, number, number]
): number {
  if (
    ![opticalDepth, cosine, scattering, absorption, ...phase].every(
      Number.isFinite
    )
  )
    throw new RangeError('Diffusion inputs must be finite')
  if (
    opticalDepth < 0 ||
    scattering < 0 ||
    absorption < 0 ||
    Math.abs(cosine) > 1
  )
    throw new RangeError('Invalid diffusion coefficients or angle')
  if (
    Math.abs(phase[0]) >= 1 ||
    Math.abs(phase[1]) >= 1 ||
    phase[2] < 0 ||
    phase[2] > 1
  )
    throw new RangeError('Invalid phase mixture')
  const extinction = scattering + absorption
  const g = phase[0] * (1 - phase[2]) + phase[1] * phase[2]
  const reduced = (1 - g) * scattering
  const scale = extinction > 0 ? opticalDepth / extinction : 0
  const direct = Math.exp(-opticalDepth)
  const diffuse =
    Math.exp(-scale * Math.sqrt(3 * absorption * (absorption + reduced))) /
    (1 + 0.75 * scale * reduced)
  return (
    phaseFunction(cosine, 1, ...phase) * direct +
    Math.max(0, diffuse - direct) / (4 * Math.PI)
  )
}

export function createDiffusionSource(
  scattering: Node<'float'>,
  absorption: Node<'float'>,
  phase: readonly [number, number, number]
) {
  const g = phase[0] * (1 - phase[2]) + phase[1] * phase[2]
  return Fn(([opticalDepth, cosine]: [Node<'float'>, Node<'float'>]) => {
    const reduced = scattering.mul(1 - g)
    const scale = opticalDepth.div(
      max(scattering.add(absorption), float(1e-30))
    )
    const direct = exp(opticalDepth.negate())
    const diffuse = exp(
      scale.mul(sqrt(absorption.mul(absorption.add(reduced)).mul(3))).negate()
    ).div(float(1).add(scale.mul(reduced).mul(0.75)))
    return phaseFunctionTSL(
      cosine,
      float(1),
      float(phase[0]),
      float(phase[1]),
      float(phase[2])
    )
      .mul(direct)
      .add(max(float(0), diffuse.sub(direct)).mul(1 / (4 * Math.PI)))
  })
}
