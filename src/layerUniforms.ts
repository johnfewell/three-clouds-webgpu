// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Maps the cloud-layer portion of parameters.glsl to TSL uniform nodes
// Reference: uniforms.ts:77–186

import { Vector3, Vector4 } from 'three'
import { uniform } from 'three/tsl'
import type { UniformNode } from 'three/webgpu'

import type { CloudLayers } from './CloudLayers'
import type { CloudsContext } from './CloudsContext'

export interface LayerUniforms {
  minLayerHeights: UniformNode<'vec4', Vector4>
  maxLayerHeights: UniformNode<'vec4', Vector4>
  minIntervalHeights: UniformNode<'vec3', Vector3>
  maxIntervalHeights: UniformNode<'vec3', Vector3>
  densityScales: UniformNode<'vec4', Vector4>
  shapeAmounts: UniformNode<'vec4', Vector4>
  shapeDetailAmounts: UniformNode<'vec4', Vector4>
  weatherExponents: UniformNode<'vec4', Vector4>
  shapeAlteringBiases: UniformNode<'vec4', Vector4>
  coverageFilterWidths: UniformNode<'vec4', Vector4>
  minHeight: UniformNode<'float', number>
  maxHeight: UniformNode<'float', number>
  shadowTopHeight: UniformNode<'float', number>
  shadowBottomHeight: UniformNode<'float', number>
  shadowLayerMask: UniformNode<'vec4', Vector4>
  densityProfileExpTerms: UniformNode<'vec4', Vector4>
  densityProfileExponents: UniformNode<'vec4', Vector4>
  densityProfileLinearTerms: UniformNode<'vec4', Vector4>
  densityProfileConstantTerms: UniformNode<'vec4', Vector4>
}

export function createLayerUniforms(): LayerUniforms {
  return {
    minLayerHeights: uniform(new Vector4()).setName('layer_minLayerHeights'),
    maxLayerHeights: uniform(new Vector4()).setName('layer_maxLayerHeights'),
    minIntervalHeights: uniform(new Vector3()).setName(
      'layer_minIntervalHeights'
    ),
    maxIntervalHeights: uniform(new Vector3()).setName(
      'layer_maxIntervalHeights'
    ),
    densityScales: uniform(new Vector4()).setName('layer_densityScales'),
    shapeAmounts: uniform(new Vector4()).setName('layer_shapeAmounts'),
    shapeDetailAmounts: uniform(new Vector4()).setName(
      'layer_shapeDetailAmounts'
    ),
    weatherExponents: uniform(new Vector4()).setName('layer_weatherExponents'),
    shapeAlteringBiases: uniform(new Vector4()).setName(
      'layer_shapeAlteringBiases'
    ),
    coverageFilterWidths: uniform(new Vector4()).setName(
      'layer_coverageFilterWidths'
    ),
    minHeight: uniform(0).setName('layer_minHeight'),
    maxHeight: uniform(0).setName('layer_maxHeight'),
    shadowTopHeight: uniform(0).setName('layer_shadowTopHeight'),
    shadowBottomHeight: uniform(0).setName('layer_shadowBottomHeight'),
    shadowLayerMask: uniform(new Vector4()).setName('layer_shadowLayerMask'),
    densityProfileExpTerms: uniform(new Vector4()).setName(
      'layer_densityProfileExpTerms'
    ),
    densityProfileExponents: uniform(new Vector4()).setName(
      'layer_densityProfileExponents'
    ),
    densityProfileLinearTerms: uniform(new Vector4()).setName(
      'layer_densityProfileLinearTerms'
    ),
    densityProfileConstantTerms: uniform(new Vector4()).setName(
      'layer_densityProfileConstantTerms'
    )
  }
}

function packLayerVectors(uniforms: LayerUniforms, layers: CloudLayers): void {
  layers.packValues('altitude', uniforms.minLayerHeights.value)
  layers.packSums('altitude', 'height', uniforms.maxLayerHeights.value)
  layers.packIntervalHeights(
    uniforms.minIntervalHeights.value,
    uniforms.maxIntervalHeights.value
  )
  layers.packValues('densityScale', uniforms.densityScales.value)
  layers.packValues('shapeAmount', uniforms.shapeAmounts.value)
  layers.packValues('shapeDetailAmount', uniforms.shapeDetailAmounts.value)
  layers.packValues('weatherExponent', uniforms.weatherExponents.value)
  layers.packValues('shapeAlteringBias', uniforms.shapeAlteringBiases.value)
  layers.packValues('coverageFilterWidth', uniforms.coverageFilterWidths.value)
}

function packDensityProfile(
  uniforms: LayerUniforms,
  layers: CloudLayers
): void {
  layers.packDensityProfiles('expTerm', uniforms.densityProfileExpTerms.value)
  layers.packDensityProfiles('exponent', uniforms.densityProfileExponents.value)
  layers.packDensityProfiles(
    'linearTerm',
    uniforms.densityProfileLinearTerms.value
  )
  layers.packDensityProfiles(
    'constantTerm',
    uniforms.densityProfileConstantTerms.value
  )
}

const shadowLayerMaskScratch = [0, 0, 0, 0]

function computeHeightBounds(
  uniforms: LayerUniforms,
  layers: CloudLayers
): void {
  let totalMinHeight = Infinity
  let totalMaxHeight = 0
  let shadowBottom = Infinity
  let shadowTop = 0
  shadowLayerMaskScratch.fill(0)

  for (let i = 0; i < layers.length; ++i) {
    const layer = layers[i]!
    const { altitude, height, shadow } = layer
    const top = altitude + height
    if (height > 0) {
      if (altitude < totalMinHeight) {
        totalMinHeight = altitude
      }
      if (shadow && altitude < shadowBottom) {
        shadowBottom = altitude
      }
      if (top > totalMaxHeight) {
        totalMaxHeight = top
      }
      if (shadow && top > shadowTop) {
        shadowTop = top
      }
    }
    shadowLayerMaskScratch[i] = shadow ? 1 : 0
  }

  if (totalMinHeight !== Infinity) {
    uniforms.minHeight.value = totalMinHeight
    uniforms.maxHeight.value = totalMaxHeight
  } else {
    uniforms.minHeight.value = 0
  }
  if (shadowBottom !== Infinity) {
    uniforms.shadowBottomHeight.value = shadowBottom
    uniforms.shadowTopHeight.value = shadowTop
  } else {
    uniforms.shadowBottomHeight.value = 0
  }
  uniforms.shadowLayerMask.value.fromArray(shadowLayerMaskScratch)
}

export function updateLayerUniforms(
  uniforms: LayerUniforms,
  ctx: CloudsContext
): void {
  const layers = ctx.cloudLayers
  packLayerVectors(uniforms, layers)
  packDensityProfile(uniforms, layers)
  computeHeightBounds(uniforms, layers)
  ctx.checkLocalWeatherChannels()
  ctx.checkLayerStructure()
}
