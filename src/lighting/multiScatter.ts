// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// clouds.frag:397–415
// Reference: https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf

import { exp, float, Fn } from 'three/tsl'
import type { Node } from 'three/webgpu'

import {
  accuratePhaseFunction,
  accuratePhaseFunctionTSL,
  phaseFunction,
  phaseFunctionTSL
} from './phaseFunction'

// a: attenuation, b: contribution, c: phase attenuation
// Should satisfy a <= b
const ATTENUATION_A = 0.5
const ATTENUATION_B = 0.5
const ATTENUATION_C = 0.5

// In the TSL graph this becomes a JS for-loop emitting octave nodes
// (multiScatteringOctaves is a graph-time integer; rebuilds on change)
export function approximateMultipleScattering(
  opticalDepth: number,
  cosTheta: number,
  multiScatteringOctaves: number,
  scatterAnisotropy1: number,
  scatterAnisotropy2: number,
  scatterAnisotropyMix: number,
  accurate = false
): number {
  let coeffA = 1
  let coeffB = 1
  let coeffC = 1
  let scattering = 0

  for (let i = 0; i < multiScatteringOctaves; i++) {
    const beerLambert = Math.exp(-opticalDepth * coeffB)
    const phase = accurate
      ? accuratePhaseFunction(cosTheta, coeffC)
      : phaseFunction(
          cosTheta,
          coeffC,
          scatterAnisotropy1,
          scatterAnisotropy2,
          scatterAnisotropyMix
        )
    scattering += coeffA * beerLambert * phase
    coeffA *= ATTENUATION_A
    coeffB *= ATTENUATION_B
    coeffC *= ATTENUATION_C
  }

  return scattering
}

// A JS for-loop unrolls the octaves at graph time (multiScatteringOctaves bumps
// graphVersion). prepare() hoists the phase terms, which depend only on the
// ray, out of the march loop, and evaluate() sums 8 exponentials per step

// Inline, the GPU recomputed 2 pow + 1 div per octave per step: 5.8 ms against
// the reference's 0.4 at 2880x1800. Same values and
// summation order
export interface ApproxMultiScatterTSL {
  prepare: (cosTheta: Node<'float'>) => void
  evaluate: (
    opticalDepth: Node<'float'>,
    cosTheta: Node<'float'>
  ) => Node<'float'>
}

export function createApproxMultiScatterTSL(
  multiScatteringOctaves: number,
  scatterAnisotropy1: Node<'float'>,
  scatterAnisotropy2: Node<'float'>,
  scatterAnisotropyMix: Node<'float'>,
  accurate = false
): ApproxMultiScatterTSL {
  const phaseAt = (cosTheta: Node<'float'>, i: number): Node<'float'> => {
    const cC = Math.pow(ATTENUATION_C, i)
    return accurate
      ? accuratePhaseFunctionTSL(cosTheta, float(cC))
      : phaseFunctionTSL(
          cosTheta,
          float(cC),
          scatterAnisotropy1,
          scatterAnisotropy2,
          scatterAnisotropyMix
        )
  }
  let prepared: Node<'float'>[] | null = null
  return {
    prepare(cosTheta) {
      prepared = Array.from({ length: multiScatteringOctaves }, (_, i) =>
        phaseAt(cosTheta, i).toVar()
      )
    },
    evaluate: Fn(([opticalDepth, cosTheta]: [Node<'float'>, Node<'float'>]) => {
      const scattering = float(0).toVar()
      for (let i = 0; i < multiScatteringOctaves; i++) {
        const cA = Math.pow(ATTENUATION_A, i)
        const cB = Math.pow(ATTENUATION_B, i)
        const beerLambert = exp(opticalDepth.negate().mul(cB))
        const phase = prepared?.[i] ?? phaseAt(cosTheta, i)
        scattering.addAssign(float(cA).mul(beerLambert).mul(phase))
      }
      return scattering
    })
  }
}
