// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.glsl:112–190
// TODO(port): Define evolution in physical length. (:129)

import {
  clamp,
  dot,
  float,
  Fn,
  length,
  max,
  mix,
  normalize,
  pow,
  remapClamp,
  saturate,
  vec3,
  vec4
} from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

import { GENERIC_LAYER_STRUCTURE, type LayerStructure } from '../CloudLayers'
import {
  cpuErosionShapeAmount,
  type CloudShapeDeps
} from '../experimental/cloudShape'
import {
  blendCloudTypeParameter,
  cloudTypeTentWeights,
  type CloudTypeBlendNodes,
  type CloudTypeDeltas
} from '../experimental/cloudTypeMap'
import type { ConvectiveDeps } from '../experimental/convectiveProfile'
import { getLayerDensity, getLayerDensityCPU } from './layerDensity'
import { zeroInactiveLanes } from './sampleWeather'

export function createSampleMedia(
  shapeTexture: TextureNode,
  shapeRepeat: Node<'vec3'>,
  shapeOffset: Node<'vec3'>,
  shapeAmounts: Node<'vec4'>,
  shapeDetailTexture: TextureNode,
  shapeDetailRepeat: Node<'vec3'>,
  shapeDetailOffset: Node<'vec3'>,
  shapeDetailAmounts: Node<'vec4'>,
  turbulenceTexture: TextureNode,
  turbulenceRepeat: Node<'vec2'>,
  turbulenceDisplacement: Node<'float'>,
  localWeatherRepeat: Node<'vec2'>,
  localWeatherOffset: Node<'vec2'>,
  densityScales: Node<'vec4'>,
  densityProfileExpTerms: Node<'vec4'>,
  densityProfileExponents: Node<'vec4'>,
  densityProfileLinearTerms: Node<'vec4'>,
  densityProfileConstantTerms: Node<'vec4'>,
  turbulenceFlag: boolean,
  shapeDetailFlag: boolean,
  shapeDetailFadeFlag: boolean,
  structure: LayerStructure = GENERIC_LAYER_STRUCTURE,
  // null is the default and emits nothing, so the profile call below is the
  // one that shipped with the flag off (convectiveProfile.digest.test.ts)
  convective: ConvectiveDeps | null = null,
  // Opt-in regional cloud-type morph. Absent means every lane
  // reads the base uniform, which is the reference graph exactly
  cloudTypes?: CloudTypeBlendNodes,
  // The opt-in wind shear and edge control. Null emits neither, which is what
  // keeps the default graph the one that shipped (cloudShape.digest.test.ts)
  cloudShape?: CloudShapeDeps | null
) {
  return Fn(
    ([weatherDensity, weatherHeightFraction, position, uv, mipLevel, jitter]: [
      Node<'vec4'>,
      Node<'vec4'>,
      Node<'vec3'>,
      Node<'vec2'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      let density = weatherDensity

      const surfaceNormal = normalize(position)
      const localWeatherSpeed = length(localWeatherOffset)
      const evolution = surfaceNormal
        .negate()
        .mul(localWeatherSpeed)
        .mul(float(2e4))

      // Every modulated parameter starts at its base uniform. The morph branch
      // is graph time, so with the flag off these are the reference expressions
      let amounts = shapeAmounts
      let detailAmounts = shapeDetailAmounts
      let scales = densityScales
      let expTerms = densityProfileExpTerms
      let profileExponents = densityProfileExponents
      let linearTerms = densityProfileLinearTerms
      let constantTerms = densityProfileConstantTerms
      if (cloudTypes != null) {
        // The map rides the weather channel's uv transform, so a type region
        // and a weather system share a scale. One weight set per step: one
        // call per parameter would emit seven copies of the same three
        const weights = cloudTypeTentWeights(
          cloudTypes.sampleMorph(
            uv.mul(localWeatherRepeat).add(localWeatherOffset)
          ),
          'media'
        )
        const deltas: CloudTypeDeltas = cloudTypes.deltas
        amounts = blendCloudTypeParameter(
          shapeAmounts,
          weights,
          ...deltas.shapeAmount
        )
        detailAmounts = blendCloudTypeParameter(
          shapeDetailAmounts,
          weights,
          ...deltas.shapeDetailAmount
        )
        scales = blendCloudTypeParameter(
          densityScales,
          weights,
          ...deltas.densityScale
        )
        expTerms = blendCloudTypeParameter(
          densityProfileExpTerms,
          weights,
          ...deltas.expTerm
        )
        profileExponents = blendCloudTypeParameter(
          densityProfileExponents,
          weights,
          ...deltas.exponent
        )
        linearTerms = blendCloudTypeParameter(
          densityProfileLinearTerms,
          weights,
          ...deltas.linearTerm
        )
        constantTerms = blendCloudTypeParameter(
          densityProfileConstantTerms,
          weights,
          ...deltas.constantTerm
        )
      }

      let turbulenceVec: Node<'vec3'> = vec3(0, 0, 0)
      if (turbulenceFlag) {
        const turbulenceUv = uv.mul(localWeatherRepeat).mul(turbulenceRepeat)
        // TODO(port): The reference uses implicit gradients for turbulence
        // Every explicit level tried changed the turbulence cases, so
        // keep this until equivalent explicit gradients exist
        const turbSample = turbulenceTexture.sample(turbulenceUv)
        turbulenceVec = turbSample.rgb
          .mul(2)
          .sub(1)
          .mul(turbulenceDisplacement)
          .mul(
            dot(density, remapClamp(weatherHeightFraction, vec4(0.3), vec4(0)))
          )
      }

      let shapePosition = position.add(evolution).add(turbulenceVec)

      // The lean grows with height, so the tops move downwind and the bases
      // stay put. The four lanes' height fractions collapse to one height,
      // weighted by the density each owns, for a lookup all four share
      if (cloudShape?.windSkew != null) {
        const windSkew = cloudShape.windSkew
        const densitySum = density.x
          .add(density.y)
          .add(density.z)
          .add(density.w)
        const height = dot(
          density.div(max(densitySum, float(1e-4))),
          weatherHeightFraction
        )
        shapePosition = shapePosition.add(windSkew(surfaceNormal, height))
      }

      const shapeUv = shapePosition.mul(shapeRepeat).add(shapeOffset)

      // Read off the morph's `amounts`, not the base uniform, so a cloud-type
      // region and an edge control compose instead of overwriting
      let carve = amounts
      if (cloudShape?.erosion != null) {
        const erosion = cloudShape.erosion
        carve = erosion(carve)
      }

      // This runs inside the march loops, where WGSL cannot derive an implicit
      // LOD under non-uniform flow. The baked volumes have no mips, so level 0
      // is the intended sample
      const shape = shapeTexture.sample(shapeUv).level(float(0)).r
      // A toVar, not a plain node: three emits no select, it emits an if/else,
      // so a value the branch below reads is rematerialised on both arms, and
      // that duplicated the shape fetch and its remap
      const shapedDensity = remapClamp(
        density,
        vec4(float(1).sub(shape)).mul(carve),
        vec4(1)
      ).toVar()
      density = shapedDensity

      if (shapeDetailFlag) {
        const detailPosition = position
          .add(turbulenceVec)
          .mul(shapeDetailRepeat)
          .add(shapeDetailOffset)
        const detail = shapeDetailTexture
          .sample(detailPosition)
          .level(float(0)).r
        const hfBlend = remapClamp(weatherHeightFraction, vec4(0.2), vec4(0.4))
        // A per-component vec4 mix (one lane per layer), as clouds.glsl:112-190
        // does. TSL's typings only model a scalar interpolant, so the assertion
        // restores the component-wise overload
        const modifier0 = mix(
          vec4(pow(detail, float(6))),
          vec4(float(1).sub(detail)),
          hfBlend as unknown as Node<'float'>
        )
        // Same component-wise mix() gap as above: shapeDetailAmounts is one
        // lane per layer
        const modifier = mix(
          vec4(0),
          modifier0,
          detailAmounts as unknown as Node<'float'>
        )
        const detailDensity = remapClamp(
          shapedDensity.mul(2),
          modifier.mul(0.5),
          vec4(1)
        )
        if (shapeDetailFadeFlag) {
          // The detail volume has no mip chain, so past DETAIL_FADE_MIP it is
          // aliasing. Fade it toward its mean, not zero, and keep the
          // reference's expected detail weight so the mean depth is unchanged
          const meanModifier = mix(
            vec4(0),
            mix(
              vec4(DETAIL_POW6_MEAN),
              vec4(1 - DETAIL_MEAN),
              hfBlend as unknown as Node<'float'>
            ),
            detailAmounts as unknown as Node<'float'>
          )
          const meanDetailDensity = remapClamp(
            shapedDensity.mul(2),
            meanModifier.mul(0.5),
            vec4(1)
          )
          const fade = clamp(
            float(DETAIL_FADE_MIP).sub(mipLevel).div(DETAIL_FADE_MIP),
            float(0),
            float(1)
          )
          density = mix(
            shapedDensity,
            mix(meanDetailDensity, detailDensity, fade),
            clamp(float(1.5).sub(mipLevel), float(0), float(1))
          )
        } else {
          const lodCheck = mipLevel
            .mul(0.5)
            .add(jitter.sub(0.5).mul(0.5))
            .lessThan(0.5)
          density = lodCheck.select(detailDensity, shapedDensity)
        }
      }

      // The terms are BLENDED locals, so the morph's deltas reach the density
      // A separate law replaces the profile rather than joining it, because the
      // four-term family is convex: cloud-types 1/3.3

      // The convective law reads the same four terms, so it takes the blended
      // ones. Order is morph then law: that law is this family plus a shoulder
      // and a gain on the same sum, and a per-term delta has nowhere to go

      const layerDensity =
        convective != null
          ? convective.heightProfile(weatherHeightFraction, {
              expTerms,
              exponents: profileExponents,
              linearTerms,
              constantTerms
            })
          : structure.expTermZero
            ? linearTerms.mul(weatherHeightFraction).add(constantTerms)
            : getLayerDensity(
                weatherHeightFraction,
                expTerms,
                profileExponents,
                linearTerms,
                constantTerms
              )
      density = saturate(density.mul(scales).mul(layerDensity))

      return zeroInactiveLanes(density, structure.active)
    }
  )
}

export function computeMediaOutputs(
  densityVec4: Node<'vec4'>,
  scatteringCoefficient: Node<'float'>,
  absorptionCoefficient: Node<'float'>
) {
  const densitySum = densityVec4.x
    .add(densityVec4.y)
    .add(densityVec4.z)
    .add(densityVec4.w)
  const weight = densityVec4.div(densitySum)
  const scattering = densitySum.mul(scatteringCoefficient)
  const extinction = densitySum.mul(absorptionCoefficient).add(scattering)
  return { densitySum, weight, scattering, extinction }
}

function cpuRemapClamped(x: number, low: number, high: number): number {
  const range = high - low
  if (Math.abs(range) < 1e-10) return x >= high ? 1 : 0
  return Math.max(0, Math.min(1, (x - low) / range))
}

export interface MediaSample {
  density: number
  weight: [number, number, number, number]
  scattering: number
  extinction: number
}

// The detail volume has no mips, so it has to be faded out by footprint rather
// than filtered. 1 at mipLevel 0, 0 from mipLevel 0.5 up
export const DETAIL_FADE_MIP = 0.5

export function detailFadeStrength(mipLevel: number): number {
  return Math.max(0, Math.min(1, 1 - mipLevel / DETAIL_FADE_MIP))
}

// The reference applies detail when mipLevel * 0.5 + (jitter - 0.5) * 0.5 is
// below 0.5, so its expected weight over a uniform jitter is this
export function detailLotteryWeight(mipLevel: number): number {
  return Math.max(0, Math.min(1, 1.5 - mipLevel))
}

// Statistics of the baked shape_detail.bin under trilinear sampling, E[v] and
// E[v^6]. sampleShape.test.ts recomputes both from the asset
export const DETAIL_MEAN = 0.7147
export const DETAIL_POW6_MEAN = 0.1657

// clouds.glsl:112-190, the CPU twin of the shapeDetailFlag block above
function cpuApplyShapeDetail(
  d: [number, number, number, number],
  weatherHeightFraction: [number, number, number, number],
  options: {
    shapeDetailFade?: boolean
    detailValue?: number
    shapeDetailAmounts?: [number, number, number, number]
    mipLevel: number
    jitter: number
  }
): void {
  // The TSL branch is a lottery on the jitter. The fade replaces it with its
  // expectation, and the aliased detail with its mean
  const fade = options.shapeDetailFade
    ? detailFadeStrength(options.mipLevel)
    : 1
  const weight = options.shapeDetailFade
    ? detailLotteryWeight(options.mipLevel)
    : options.mipLevel * 0.5 + (options.jitter - 0.5) * 0.5 < 0.5
      ? 1
      : 0
  if (weight <= 0) return

  const detail = options.detailValue ?? 0
  const sda = options.shapeDetailAmounts ?? [1, 1, 1, 1]
  for (let i = 0; i < 4; i++) {
    const hfRemap = cpuRemapClamped(weatherHeightFraction[i]!, 0.2, 0.4)
    const modifier0 =
      Math.pow(detail, 6) * (1 - hfRemap) + (1 - detail) * hfRemap
    const meanModifier0 =
      DETAIL_POW6_MEAN * (1 - hfRemap) + (1 - DETAIL_MEAN) * hfRemap
    const detailDensity = cpuRemapClamped(
      d[i]! * 2,
      modifier0 * sda[i]! * 0.5,
      1
    )
    const meanDensity = cpuRemapClamped(
      d[i]! * 2,
      meanModifier0 * sda[i]! * 0.5,
      1
    )
    const faded = meanDensity + (detailDensity - meanDensity) * fade
    d[i] = d[i]! + (faded - d[i]!) * weight
  }
}

export function cpuSampleMedia(
  weatherDensity: [number, number, number, number],
  weatherHeightFraction: [number, number, number, number],
  shapeValue: number,
  shapeAmounts: [number, number, number, number],
  densityScales: [number, number, number, number],
  densityProfileExpTerms: [number, number, number, number],
  densityProfileExponents: [number, number, number, number],
  densityProfileLinearTerms: [number, number, number, number],
  densityProfileConstantTerms: [number, number, number, number],
  scatteringCoefficient: number,
  absorptionCoefficient: number,
  options: {
    shapeDetail: boolean
    shapeDetailFade?: boolean
    detailValue?: number
    shapeDetailAmounts?: [number, number, number, number]
    mipLevel: number
    jitter: number
    structure?: LayerStructure
    // Scales the carve, as the optional erosion seam does. The shear is not
    // here: it picks which texel the caller reads, so it moves shapeValue
    erosionShape?: number
  }
): MediaSample {
  const structure = options.structure ?? GENERIC_LAYER_STRUCTURE
  const d: [number, number, number, number] = [...weatherDensity]

  for (let i = 0; i < 4; i++) {
    const carve = cpuErosionShapeAmount(
      shapeAmounts[i]!,
      options.erosionShape ?? 0
    )
    d[i] = cpuRemapClamped(d[i]!, (1 - shapeValue) * carve, 1)
  }

  if (options.shapeDetail) {
    cpuApplyShapeDetail(d, weatherHeightFraction, options)
  }

  for (let i = 0; i < 4; i++) {
    const layerD = structure.expTermZero
      ? densityProfileLinearTerms[i]! * weatherHeightFraction[i]! +
        densityProfileConstantTerms[i]!
      : getLayerDensityCPU(
          weatherHeightFraction[i]!,
          densityProfileExpTerms[i]!,
          densityProfileExponents[i]!,
          densityProfileLinearTerms[i]!,
          densityProfileConstantTerms[i]!
        )
    d[i] = Math.max(0, Math.min(1, d[i]! * densityScales[i]! * layerD))
    if (!structure.active[i]) d[i] = 0
  }

  const densitySum = d[0] + d[1] + d[2] + d[3]
  const weight: [number, number, number, number] =
    densitySum > 0
      ? [
          d[0] / densitySum,
          d[1] / densitySum,
          d[2] / densitySum,
          d[3] / densitySum
        ]
      : [0, 0, 0, 0]
  const scattering = densitySum * scatteringCoefficient
  const extinction = densitySum * absorptionCoefficient + scattering

  return { density: densitySum, weight, scattering, extinction }
}
