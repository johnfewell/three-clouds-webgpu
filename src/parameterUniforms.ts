// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Maps the non-layer portion of parameters.glsl to TSL uniform nodes

import {
  Data3DTexture,
  DataTexture,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  type Texture,
  type Vector3
} from 'three'
import {
  texture as tslTexture,
  texture3D as tslTexture3D,
  uniform
} from 'three/tsl'
import type { Storage3DTexture, TextureNode, UniformNode } from 'three/webgpu'

import type { CloudsContext } from './CloudsContext'
import { defaults } from './qualityPresets'

// A placeholder's filters decide the compiled sampling instruction for good:
// WGSLNodeBuilder.isUnfilterable() emits `textureLoad` for Nearest/Nearest, and
// a later `.value` swap to a Linear texture never recompiles

// DataTexture and Data3DTexture default to Nearest, so every cloud read loaded
// without filtering. Each placeholder now carries the filters of the
// texture it stands in for
function createPlaceholder2D(): Texture {
  const data = new Uint8Array(4)
  const tex = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType)
  // localWeather (512²) and turbulence (128²) are both linearly sampled
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

function createPlaceholder3D(): Data3DTexture {
  const data = new Uint8Array(4)
  const tex = new Data3DTexture(data, 1, 1, 1)
  tex.format = RGBAFormat
  tex.type = UnsignedByteType
  // shape (128³) and shapeDetail (32³) are linearly sampled, the detail volume
  // especially, where one texel is 1/32 of the cube
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

// STBN keeps Nearest deliberately, matching createJitterTexture()
// (loadBakedCloudTextures.ts:124-125): interpolating blue noise would blend
// away its decorrelation, so `textureLoad` is correct here
function createStbnPlaceholder(): Data3DTexture {
  const tex = new Data3DTexture(new Uint8Array(4), 1, 1, 1)
  tex.format = RGBAFormat
  tex.type = UnsignedByteType
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.needsUpdate = true
  return tex
}

export interface ParameterUniforms {
  resolution: UniformNode<'vec2', Vector2>
  frame: UniformNode<'float', number>
  temporalJitter: UniformNode<'vec2', Vector2>
  targetUvScale: UniformNode<'vec2', Vector2>
  mipLevelScale: UniformNode<'float', number>
  stbnTexture: TextureNode

  scatteringCoefficient: UniformNode<'float', number>
  absorptionCoefficient: UniformNode<'float', number>

  minDensity: UniformNode<'float', number>
  minExtinction: UniformNode<'float', number>
  minTransmittance: UniformNode<'float', number>

  localWeatherTexture: TextureNode
  localWeatherRepeat: UniformNode<'vec2', Vector2>
  localWeatherOffset: UniformNode<'vec2', Vector2>
  coverage: UniformNode<'float', number>

  shapeTexture: TextureNode
  shapeRepeat: UniformNode<'vec3', Vector3>
  shapeOffset: UniformNode<'vec3', Vector3>

  shapeDetailTexture: TextureNode
  shapeDetailRepeat: UniformNode<'vec3', Vector3>
  shapeDetailOffset: UniformNode<'vec3', Vector3>

  turbulenceTexture: TextureNode
  turbulenceRepeat: UniformNode<'vec2', Vector2>
  turbulenceDisplacement: UniformNode<'float', number>

  hazeDensityScale: UniformNode<'float', number>
  hazeExponent: UniformNode<'float', number>
  hazeScatteringCoefficient: UniformNode<'float', number>
  hazeAbsorptionCoefficient: UniformNode<'float', number>
}

// One placeholder per slot: nodes with the same value uuid share a
// binding (TextureNode.getUniformHash), so shared placeholders merged slots
// permanently, since the texture setters do not rebuild the graph
export interface OwnedPlaceholders {
  localWeather: Texture
  turbulence: Texture
  shape: Data3DTexture
  shapeDetail: Data3DTexture
  stbn: Data3DTexture
}

// 3D samples take a vec3 uv, and a node created without a uv applies the 2D uv
// matrix (a JoinNode arity error). Any 3D texture, including a procedural
// Storage3DTexture
function texture3DNode(tex: Data3DTexture | Storage3DTexture) {
  const node = tslTexture3D(tex)
  node.updateMatrix = false
  return node
}

export function createParameterUniforms(
  ctx: CloudsContext
): ParameterUniforms & { placeholders: OwnedPlaceholders } {
  const placeholders: OwnedPlaceholders = {
    localWeather: createPlaceholder2D(),
    turbulence: createPlaceholder2D(),
    shape: createPlaceholder3D(),
    shapeDetail: createPlaceholder3D(),
    stbn: createStbnPlaceholder()
  }

  return {
    resolution: uniform(new Vector2()).setName('parameter_resolution'),
    frame: uniform(0).setName('parameter_frame'),
    temporalJitter: uniform(new Vector2()).setName('parameter_temporalJitter'),
    targetUvScale: uniform(new Vector2(1, 1)).setName(
      'parameter_targetUvScale'
    ),
    mipLevelScale: uniform(1).setName('parameter_mipLevelScale'),
    stbnTexture: tslTexture3D(ctx.stbnTexture ?? placeholders.stbn),

    scatteringCoefficient: uniform(ctx.scatteringCoefficient).setName(
      'parameter_scatteringCoefficient'
    ),
    absorptionCoefficient: uniform(ctx.absorptionCoefficient).setName(
      'parameter_absorptionCoefficient'
    ),

    minDensity: uniform(defaults.clouds.minDensity).setName(
      'parameter_minDensity'
    ),
    minExtinction: uniform(defaults.clouds.minExtinction).setName(
      'parameter_minExtinction'
    ),
    minTransmittance: uniform(defaults.clouds.minTransmittance).setName(
      'parameter_minTransmittance'
    ),

    localWeatherTexture: tslTexture(
      ctx.resolvedLocalWeatherTexture ?? placeholders.localWeather
    ),
    localWeatherRepeat: uniform(ctx.localWeatherRepeat).setName(
      'parameter_localWeatherRepeat'
    ),
    localWeatherOffset: uniform(ctx.derivedLocalWeatherOffset).setName(
      'parameter_localWeatherOffset'
    ),
    coverage: uniform(ctx.coverage).setName('parameter_coverage'),

    shapeTexture: texture3DNode(ctx.resolvedShapeTexture ?? placeholders.shape),
    shapeRepeat: uniform(ctx.shapeRepeat).setName('parameter_shapeRepeat'),
    shapeOffset: uniform(ctx.derivedShapeOffset).setName(
      'parameter_shapeOffset'
    ),

    shapeDetailTexture: texture3DNode(
      ctx.resolvedShapeDetailTexture ?? placeholders.shapeDetail
    ),
    shapeDetailRepeat: uniform(ctx.shapeDetailRepeat).setName(
      'parameter_shapeDetailRepeat'
    ),
    shapeDetailOffset: uniform(ctx.derivedShapeDetailOffset).setName(
      'parameter_shapeDetailOffset'
    ),

    turbulenceTexture: tslTexture(
      ctx.resolvedTurbulenceTexture ?? placeholders.turbulence
    ),
    turbulenceRepeat: uniform(ctx.turbulenceRepeat).setName(
      'parameter_turbulenceRepeat'
    ),
    turbulenceDisplacement: uniform(ctx.turbulenceDisplacement).setName(
      'parameter_turbulenceDisplacement'
    ),

    hazeDensityScale: uniform(3e-5).setName('parameter_hazeDensityScale'),
    hazeExponent: uniform(1e-3).setName('parameter_hazeExponent'),
    hazeScatteringCoefficient: uniform(0.9).setName(
      'parameter_hazeScatteringCoefficient'
    ),
    hazeAbsorptionCoefficient: uniform(0.5).setName(
      'parameter_hazeAbsorptionCoefficient'
    ),

    placeholders
  }
}

export function updateParameterUniforms(
  uniforms: ParameterUniforms & { placeholders: OwnedPlaceholders },
  ctx: CloudsContext
): void {
  ctx.updateOffsets()
  uniforms.frame.value = ctx.frame
  uniforms.scatteringCoefficient.value = ctx.scatteringCoefficient
  uniforms.absorptionCoefficient.value = ctx.absorptionCoefficient
  uniforms.coverage.value = ctx.coverage
  uniforms.turbulenceDisplacement.value = ctx.turbulenceDisplacement

  uniforms.minDensity.value = ctx.clouds.minDensity
  uniforms.minExtinction.value = ctx.clouds.minExtinction
  uniforms.minTransmittance.value = ctx.clouds.minTransmittance

  // without these the haze uniforms kept their creation literals, so a
  // runtime change of ctx.clouds.haze* never reached the haze march
  uniforms.hazeDensityScale.value = ctx.clouds.hazeDensityScale
  uniforms.hazeExponent.value = ctx.clouds.hazeExponent
  uniforms.hazeScatteringCoefficient.value =
    ctx.clouds.hazeScatteringCoefficient
  uniforms.hazeAbsorptionCoefficient.value =
    ctx.clouds.hazeAbsorptionCoefficient

  const p = uniforms.placeholders
  uniforms.localWeatherTexture.value =
    ctx.resolvedLocalWeatherTexture ?? p.localWeather
  uniforms.shapeTexture.value = ctx.resolvedShapeTexture ?? p.shape
  uniforms.shapeDetailTexture.value =
    ctx.resolvedShapeDetailTexture ?? p.shapeDetail
  uniforms.turbulenceTexture.value =
    ctx.resolvedTurbulenceTexture ?? p.turbulence
  uniforms.stbnTexture.value = ctx.stbnTexture ?? p.stbn
}

export function disposePlaceholders(placeholders: OwnedPlaceholders): void {
  for (const placeholder of Object.values(placeholders)) {
    placeholder.dispose()
  }
}
