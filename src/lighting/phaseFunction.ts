// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// clouds.frag:298–344
// Draine (Phase 4): https://research.nvidia.com/labs/rtr/approximate-mie/

import { float, Fn, max, mix, mul, pow } from 'three/tsl'
import type { Node } from 'three/webgpu'

const RECIPROCAL_PI4 = 1 / (4 * Math.PI)

// Reference: Frostbite "Physically Based and Unified Volumetric Rendering"
// https://www.ea.com/frostbite/news/physically-based-unified-volumetric-rendering-in-frostbite
// https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf

// Dual-lobe Henyey–Greenstein evaluated for two g values at once
// Returns [lobe1, lobe2] for the given cosTheta
export function henyeyGreenstein(
  g1: number,
  g2: number,
  cosTheta: number
): [number, number] {
  const g1sq = g1 * g1
  const g2sq = g2 * g2
  const denom1 = Math.max(1e-7, Math.pow(1 + g1sq - 2 * g1 * cosTheta, 1.5))
  const denom2 = Math.max(1e-7, Math.pow(1 + g2sq - 2 * g2 * cosTheta, 1.5))
  return [
    (RECIPROCAL_PI4 * (1 - g1sq)) / denom1,
    (RECIPROCAL_PI4 * (1 - g2sq)) / denom2
  ]
}

// Dual-lobe HG phase function with a weighted mix, on uniforms (const-folding
// is a possible 2–4 fps optimisation for later). Frostbite's similar
// approximation attenuates the phase angle instead of the anisotropy
export function phaseFunction(
  cosTheta: number,
  attenuation: number,
  scatterAnisotropy1: number,
  scatterAnisotropy2: number,
  scatterAnisotropyMix: number
): number {
  const g1 = scatterAnisotropy1 * attenuation
  const g2 = scatterAnisotropy2 * attenuation
  const [lobe1, lobe2] = henyeyGreenstein(g1, g2, cosTheta)
  const w1 = 1 - scatterAnisotropyMix
  const w2 = scatterAnisotropyMix
  return lobe1 * w1 + lobe2 * w2
}

// Cite: clouds.frag:307–313 (Draine phase function, approximate Mie)
// Reference: https://research.nvidia.com/labs/rtr/approximate-mie/
export function draine(u: number, g: number, a: number): number {
  const g2 = g * g
  return (
    ((1 - g2) * (1 + a * u * u)) /
    (4 *
      (1 + (a * (1 + 2 * g2)) / 3) *
      Math.PI *
      Math.pow(1 + g2 - 2 * g * u, 1.5))
  )
}

// Cite: clouds.frag:318–328 (numerically fitted d=10 phase function)
const G_HG = 0.988176691700256
const G_D = 0.5556712547839497
const ALPHA = 21.995520856274638
const WEIGHT = 0.4819554318404214

export function accuratePhaseFunction(
  cosTheta: number,
  attenuation: number
): number {
  const [hgLobe] = henyeyGreenstein(
    G_HG * attenuation,
    G_HG * attenuation,
    cosTheta
  )
  return (
    hgLobe * (1 - WEIGHT) + draine(cosTheta, G_D * attenuation, ALPHA) * WEIGHT
  )
}

// Convenience overload with attenuation = 1
export function phaseFunctionDefault(
  cosTheta: number,
  scatterAnisotropy1: number,
  scatterAnisotropy2: number,
  scatterAnisotropyMix: number
): number {
  return phaseFunction(
    cosTheta,
    1,
    scatterAnisotropy1,
    scatterAnisotropy2,
    scatterAnisotropyMix
  )
}

// TSL versions

const hgTSL = /*#__PURE__*/ Fn(
  ([g, cosTheta]: [Node<'float'>, Node<'float'>]) => {
    const g2 = g.mul(g)
    const denom = float(1).add(g2).sub(g.mul(2).mul(cosTheta))
    return float(RECIPROCAL_PI4)
      .mul(float(1).sub(g2))
      .div(max(pow(denom, 1.5), 1e-7))
  }
)

export const phaseFunctionTSL = /*#__PURE__*/ Fn(
  ([
    cosTheta,
    attenuation,
    scatterAnisotropy1,
    scatterAnisotropy2,
    scatterAnisotropyMix
  ]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const g1 = scatterAnisotropy1.mul(attenuation)
    const g2 = scatterAnisotropy2.mul(attenuation)
    const lobe1 = hgTSL(g1, cosTheta)
    const lobe2 = hgTSL(g2, cosTheta)
    return mix(lobe1, lobe2, scatterAnisotropyMix)
  }
)

// Cite: clouds.frag:307–313 (Draine phase, TSL)
const draineTSL = /*#__PURE__*/ Fn(
  ([u, g, a]: [Node<'float'>, Node<'float'>, Node<'float'>]) => {
    const g2 = g.mul(g)
    const numerator = float(1)
      .sub(g2)
      .mul(float(1).add(a.mul(u).mul(u)))
    const normFactor = mul(
      4,
      float(1)
        .add(a.mul(float(1).add(g2.mul(2)).div(3)))
        .mul(Math.PI)
    )
    const denom = pow(float(1).add(g2).sub(g.mul(2).mul(u)), 1.5)
    return numerator.div(normFactor.mul(denom))
  }
)

// Cite: clouds.frag:318–328 (accurate phase, TSL)
export const accuratePhaseFunctionTSL = /*#__PURE__*/ Fn(
  ([cosTheta, attenuation]: [Node<'float'>, Node<'float'>]) => {
    const hgLobe = hgTSL(float(G_HG).mul(attenuation), cosTheta)
    const draineLobe = draineTSL(
      cosTheta,
      float(G_D).mul(attenuation),
      float(ALPHA)
    )
    return mix(hgLobe, draineLobe, WEIGHT)
  }
)
