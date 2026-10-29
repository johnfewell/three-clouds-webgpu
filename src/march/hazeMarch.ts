// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:654–697 (approximateHaze)
// Cite: https://iquilezles.org/articles/fog/

import {
  dot,
  exp,
  float,
  Fn,
  If,
  max,
  mix,
  normalize,
  remapClamp,
  vec4
} from 'three/tsl'
import type { Node } from 'three/webgpu'

const RECIPROCAL_PI4 = 1 / (4 * Math.PI)

export interface HazeMarchDeps {
  coverage: Node<'float'>
  cameraHeight: Node<'float'>
  bottomRadius: Node<'float'>
  hazeDensityScale: Node<'float'>
  hazeExponent: Node<'float'>
  hazeScatteringCoefficient: Node<'float'>
  hazeAbsorptionCoefficient: Node<'float'>
  skyLightScale: Node<'float'>
  phaseFunction: (cosTheta: Node<'float'>) => Node<'float'>
  groundSunIrradiance: Node<'vec3'>
  groundSkyIrradiance: Node<'vec3'>
}

// Cite: clouds.frag:654–697
export function createApproximateHaze(deps: HazeMarchDeps) {
  return /*#__PURE__*/ Fn(
    ([rayOrigin, rayDirection, maxRayDistance, cosTheta, shadowLength]: [
      Node<'vec3'>,
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const result = vec4(0).toVar()

      const modulation = remapClamp(deps.coverage, float(0.2), float(0.4))

      const earlyOut = deps.cameraHeight
        .mul(modulation)
        .lessThan(0)
        .or(
          modulation
            .mul(deps.hazeDensityScale)
            .mul(exp(deps.cameraHeight.negate().mul(deps.hazeExponent)))
            .lessThan(1e-7)
        )

      If(earlyOut.not(), () => {
        const density = modulation
          .mul(deps.hazeDensityScale)
          .mul(exp(deps.cameraHeight.negate().mul(deps.hazeExponent)))

        // Cite: clouds.frag:672–675
        const normalAtOrigin = normalize(rayOrigin)
        const normalAtHorizon = rayOrigin
          .sub(dot(rayOrigin, rayDirection).mul(rayDirection))
          .div(deps.bottomRadius)
        const alpha = remapClamp(
          dot(normalAtOrigin, normalAtHorizon),
          float(0.9),
          float(1.0)
        )
        const normal = mix(normalAtOrigin, normalAtHorizon, alpha)

        // Cite: clouds.frag:678–681 (iquilezles fog)
        const angle = max(dot(normal, rayDirection), 1e-5)
        const exponent = angle.mul(deps.hazeExponent)
        const linearTerm = density.div(deps.hazeExponent).div(angle)

        // Cite: clouds.frag:684–689
        const expTerm = float(1).sub(exp(maxRayDistance.negate().mul(exponent)))
        const shadowExpTerm = float(1).sub(
          exp(maxRayDistance.min(shadowLength).negate().mul(exponent))
        )
        const opticalDepth = expTerm.mul(linearTerm)
        const shadowOpticalDepth = max(
          expTerm.sub(shadowExpTerm).mul(linearTerm),
          0
        )
        const transmittance = float(1)
          .sub(exp(opticalDepth.negate()))
          .clamp(0, 1)
        const shadowTransmittance = float(1)
          .sub(exp(shadowOpticalDepth.negate()))
          .clamp(0, 1)

        // Cite: clouds.frag:691–695
        const inscatter = deps.groundSunIrradiance
          .mul(deps.phaseFunction(cosTheta))
          .mul(shadowTransmittance)
          .add(
            deps.groundSkyIrradiance
              .mul(RECIPROCAL_PI4)
              .mul(deps.skyLightScale)
              .mul(transmittance)
          )
          .mul(
            deps.hazeScatteringCoefficient.div(
              deps.hazeAbsorptionCoefficient.add(deps.hazeScatteringCoefficient)
            )
          )

        result.assign(vec4(inscatter, transmittance))
      })

      return result
    }
  )
}

// Cite: clouds.frag:994–995
export function blendHaze(color: Node<'vec4'>, haze: Node<'vec4'>) {
  const rgb = mix(color.xyz, haze.xyz, haze.w)
  const a = color.w.mul(float(1).sub(haze.w)).add(haze.w)
  return vec4(rgb, a)
}

// CPU twins for testing

export function remapClampedCPU(
  value: number,
  inLow: number,
  inHigh: number
): number {
  return Math.max(0, Math.min(1, (value - inLow) / (inHigh - inLow)))
}

export function approximateHazeCPU(
  normalDotDir: number,
  maxRayDistance: number,
  _cosTheta: number,
  shadowLength: number,
  coverage: number,
  cameraHeight: number,
  hazeDensityScale: number,
  hazeExponent: number,
  _hazeScatteringCoefficient: number,
  _hazeAbsorptionCoefficient: number
): { transmittance: number; opticalDepth: number; shadowOpticalDepth: number } {
  const modulation = remapClampedCPU(coverage, 0.2, 0.4)
  if (cameraHeight * modulation < 0) {
    return { transmittance: 0, opticalDepth: 0, shadowOpticalDepth: 0 }
  }
  const density =
    modulation * hazeDensityScale * Math.exp(-cameraHeight * hazeExponent)
  if (density < 1e-7) {
    return { transmittance: 0, opticalDepth: 0, shadowOpticalDepth: 0 }
  }

  const angle = Math.max(normalDotDir, 1e-5)
  const exponent = angle * hazeExponent
  const linearTerm = density / hazeExponent / angle

  const expTerm = 1 - Math.exp(-maxRayDistance * exponent)
  const shadowExpTerm =
    1 - Math.exp(-Math.min(maxRayDistance, shadowLength) * exponent)
  const opticalDepth = expTerm * linearTerm
  const shadowOpticalDepth = Math.max((expTerm - shadowExpTerm) * linearTerm, 0)
  const transmittance = Math.max(0, Math.min(1, 1 - Math.exp(-opticalDepth)))

  return { transmittance, opticalDepth, shadowOpticalDepth }
}

export function blendHazeCPU(
  colorRgb: [number, number, number],
  colorA: number,
  hazeRgb: [number, number, number],
  hazeA: number
): { rgb: [number, number, number]; a: number } {
  const rgb: [number, number, number] = [
    colorRgb[0] + (hazeRgb[0] - colorRgb[0]) * hazeA,
    colorRgb[1] + (hazeRgb[1] - colorRgb[1]) * hazeA,
    colorRgb[2] + (hazeRgb[2] - colorRgb[2]) * hazeA
  ]
  const a = colorA * (1 - hazeA) + hazeA
  return { rgb, a }
}

export function getHazeRayNearFarCPU(
  cameraHeight: number,
  maxHeight: number,
  ground: boolean,
  cameraNear: number,
  firstX: number,
  secondZ: number
): [number, number] {
  if (cameraHeight < maxHeight) {
    if (ground) {
      return [cameraNear, firstX]
    }
    return [cameraNear, secondZ]
  }
  const nearFar: [number, number] = [cameraNear, secondZ]
  if (ground) {
    nearFar[1] = firstX
  }
  return nearFar
}
