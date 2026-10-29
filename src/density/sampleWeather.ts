// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.glsl:63–103
// Coverage modulation: https://github.com/Prograda/Skybolt/blob/master/Assets/Core/Shaders/Clouds.h#L63

import { float, Fn, mix, pow, remapClamp, vec4 } from 'three/tsl'
import type { Node, TextureNode } from 'three/webgpu'

import { GENERIC_LAYER_STRUCTURE, type LayerStructure } from '../CloudLayers'
import {
  blendCloudTypeParameter,
  cloudTypeTentWeights,
  type CloudTypeBlendNodes
} from '../experimental/cloudTypeMap'
import type { ConvectiveDeps } from '../experimental/convectiveProfile'
import { cpuShapeAltering, shapeAlteringFunction } from './shapeAltering'

const rgbaToXyzw: Record<string, string> = {
  r: 'x',
  g: 'y',
  b: 'z',
  a: 'w'
}

function convertSwizzle(channels: string): string {
  return channels
    .split('')
    .map(c => rgbaToXyzw[c] ?? c)
    .join('')
}

// an empty layer lane (height <= 0) is compiled as a literal 0, so
// the compiler can drop that lane's work upstream. Its value was already 0 for
// every height but the layer's own altitude (see CloudLayers.structure)
export function zeroInactiveLanes(
  value: Node<'vec4'>,
  active: LayerStructure['active']
): Node<'vec4'> {
  if (active.every(Boolean)) return value
  const lane = (i: number, c: Node<'float'>) => (active[i] ? c : float(0))
  return vec4(
    lane(0, value.x),
    lane(1, value.y),
    lane(2, value.z),
    lane(3, value.w)
  )
}

// Replaces the weather texture read outright. Used by the opt-in experiments
// that evolve the map, so the read below stays the single call site
export type WeatherSampler = (
  texCoord: Node<'vec2'>,
  mipLevel: Node<'float'>
) => Node<'vec4'>

export function createSampleWeather(
  localWeatherTexture: TextureNode,
  localWeatherRepeat: Node<'vec2'>,
  localWeatherOffset: Node<'vec2'>,
  minLayerHeights: Node<'vec4'>,
  maxLayerHeights: Node<'vec4'>,
  weatherExponents: Node<'vec4'>,
  shapeAlteringBiases: Node<'vec4'>,
  coverage: Node<'float'>,
  coverageFilterWidths: Node<'vec4'>,
  shadowLayerMask: Node<'vec4'>,
  channels: string,
  shadow: boolean,
  structure: LayerStructure = GENERIC_LAYER_STRUCTURE,
  // Both seams are null by default and emit nothing, so the remap below is the
  // one that shipped with either flag off, and each digest pins that
  weatherSampler: WeatherSampler | null = null,
  convective: ConvectiveDeps | null = null,
  // Opt-in regional cloud-type map. Absent means every lane reads
  // the base uniform, which is the reference graph exactly
  cloudTypes?: CloudTypeBlendNodes
) {
  return Fn(
    // heightFractionIn: the step's height fraction when the caller already
    // computed it, one .toVar() per step. Computed here when it is absent
    ([uv, height, mipLevel, heightFractionIn]: [
      Node<'vec2'>,
      Node<'float'>,
      Node<'float'>,
      Node<'vec4'>?
    ]) => {
      const heightFraction =
        heightFractionIn ??
        remapClamp(vec4(height), minLayerHeights, maxLayerHeights)

      // TODO(port): Define in physical length. (clouds.glsl:129)
      const texCoord = uv.mul(localWeatherRepeat).add(localWeatherOffset)
      // graph-time: null emits the plain read, so the default graph compiles
      // exactly as it did before the hook existed
      const texSample =
        weatherSampler == null
          ? localWeatherTexture.sample(texCoord).level(mipLevel)
          : weatherSampler(texCoord, mipLevel)
      const swizzle = convertSwizzle(channels)
      // The swizzle is data (CloudLayer.channel), but TSL types swizzles as
      // fixed properties. The keyed view bridges the two, and convertSwizzle()
      // constrains it to xyzw
      const swizzled = (texSample as unknown as Record<string, Node<'vec4'>>)[
        swizzle
      ]!
      // The coverage threshold's height skew is the one weather-side parameter
      // a cloud type owns: it decides whether the layer reads as towers or as
      // a flat deck. The other two shape the channel's contrast, not the form
      const biases =
        cloudTypes == null
          ? shapeAlteringBiases
          : blendCloudTypeParameter(
              shapeAlteringBiases,
              // The map rides the weather channel's own uv transform, so a type
              // region and a weather system share a scale
              // (docs/design/cloud-types.md 3.4)
              cloudTypeTentWeights(
                cloudTypes.sampleMorph(
                  uv.mul(localWeatherRepeat).add(localWeatherOffset)
                ),
                'weather'
              ),
              ...cloudTypes.deltas.shapeAlteringBias
            )
      // pow(x, 1) is the identity; skipped when every active lane's exponent
      // is 1 (graph-time, CloudLayers.structure)
      let localWeather: Node<'vec4'> = structure.weatherExponentOne
        ? swizzled
        : pow(swizzled, weatherExponents)

      if (shadow) {
        localWeather = localWeather.mul(shadowLayerMask)
      }

      const heightScale = shapeAlteringFunction(heightFraction, biases)
      let factor = vec4(1).sub(coverage.mul(heightScale))
      // Opt-in coverage concentration. A threshold of 1 admits nothing the map
      // holds, so a masked-out location erases every lane at once. The whole
      // drop carries the lane's height weight, so it floors nothing
      if (convective != null) {
        const cells = convective.cellMask(uv)
        factor = vec4(1).sub(
          cells.mul(heightScale).mul(coverage.add(convective.cellDensity))
        )
      }
      const density = remapClamp(
        // Component-wise mix(): one filter width per layer lane. TSL's
        // overloads only model a scalar interpolant (see sampleShape.ts)
        mix(
          localWeather,
          vec4(1),
          coverageFilterWidths as unknown as Node<'float'>
        ),
        factor,
        factor.add(coverageFilterWidths)
      )

      return zeroInactiveLanes(density, structure.active)
    }
  )
}

export function cpuSampleWeather(
  height: number,
  minLayerHeights: [number, number, number, number],
  maxLayerHeights: [number, number, number, number],
  weatherValues: [number, number, number, number],
  weatherExponents: [number, number, number, number],
  shapeAlteringBiases: [number, number, number, number],
  coverage: number,
  coverageFilterWidths: [number, number, number, number],
  shadowLayerMask: [number, number, number, number],
  shadow: boolean,
  structure: LayerStructure = GENERIC_LAYER_STRUCTURE,
  convective: ConvectiveWeatherCPU | null = null
): {
  heightFraction: [number, number, number, number]
  density: [number, number, number, number]
} {
  const heightFraction: [number, number, number, number] = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const range = maxLayerHeights[i]! - minLayerHeights[i]!
    if (range > 0) {
      heightFraction[i] = Math.max(
        0,
        Math.min(1, (height - minLayerHeights[i]!) / range)
      )
    }
  }

  const localWeather: [number, number, number, number] = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    localWeather[i] = structure.weatherExponentOne
      ? weatherValues[i]!
      : Math.pow(weatherValues[i]!, weatherExponents[i]!)
  }

  if (shadow) {
    for (let i = 0; i < 4; i++) {
      localWeather[i] = localWeather[i]! * shadowLayerMask[i]!
    }
  }

  const density: [number, number, number, number] = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const heightScale = cpuShapeAltering(
      heightFraction[i]!,
      shapeAlteringBiases[i]!
    )
    let factor = 1 - coverage * heightScale
    const cfw = coverageFilterWidths[i]!
    if (convective != null) {
      const cells = convective.cellMask
      factor = 1 - cells * heightScale * (coverage + convective.cellDensity)
    }
    const mixed = localWeather[i]! * (1 - cfw) + cfw
    if (cfw > 0) {
      density[i] = Math.max(0, Math.min(1, (mixed - factor) / cfw))
    }
    if (!structure.active[i]) density[i] = 0
  }

  return { heightFraction, density }
}

// The CPU twin's view of ConvectiveDeps: the mask is 2D on purpose, so one
// scalar serves every lane and every height
export interface ConvectiveWeatherCPU {
  cellMask: number
  cellDensity: number
}
