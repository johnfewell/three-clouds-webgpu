// Compile the real density pipeline (sampleWeather -> sampleMedia ->
// primaryMarch) so a digest covers the code the cloud-type map touches
// Only the lighting callbacks are inert: they are not what these tests are
// about, and stubbing them keeps the graph stable across three.js churn

import {
  Data3DTexture,
  DataTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4
} from 'three'
import {
  float,
  Fn,
  struct,
  texture as tslTexture,
  texture3D as tslTexture3D,
  uniform,
  vec2,
  vec3
} from 'three/tsl'
import type { TextureNode } from 'three/webgpu'

import { GENERIC_LAYER_STRUCTURE } from '../../src/CloudLayers'
import { createSampleMedia } from '../../src/density/sampleShape'
import { createSampleWeather } from '../../src/density/sampleWeather'
import type { CloudTypeBlendNodes } from '../../src/experimental/cloudTypeMap'
import { createMarchClouds } from '../../src/march/primaryMarch'
import { compileWGSL, type CompileResult } from './compileWGSL'

export const LAYER_HEIGHTS = {
  min: new Vector4(750, 1000, 7500, 0),
  max: new Vector4(1400, 2200, 8000, 0)
} as const

export function createPlaceholder2D(rgba: number[] = [128, 128, 128, 255]) {
  const tex = new DataTexture(
    new Uint8Array(rgba),
    1,
    1,
    RGBAFormat,
    UnsignedByteType
  )
  tex.minFilter = LinearMipMapLinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

export function createPlaceholder3D() {
  const tex = new Data3DTexture(new Uint8Array([128]), 1, 1, 1)
  tex.format = RedFormat
  tex.type = UnsignedByteType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.wrapR = RepeatWrapping
  tex.needsUpdate = true
  return tex
}

function volume(): TextureNode {
  const node = tslTexture3D(createPlaceholder3D())
  // A uv-less 3D read: the vec2 uv transform would otherwise be applied to a
  // vec3 and the build fails
  ;(node as unknown as { updateMatrix: boolean }).updateMatrix = false
  return node
}

export interface DensityGraphOptions {
  cloudTypes?: CloudTypeBlendNodes
  shapeDetail?: boolean
  turbulence?: boolean
}

export interface DensityGraph {
  sampleWeather: ReturnType<typeof createSampleWeather>
  sampleMedia: ReturnType<typeof createSampleMedia>
}

/** The real density samplers, wired as CloudsPassNode.buildFactories wires them */
export function createDensityGraph(
  options: DensityGraphOptions = {}
): DensityGraph {
  const minLayerHeights = uniform(LAYER_HEIGHTS.min)
  const maxLayerHeights = uniform(LAYER_HEIGHTS.max)
  const localWeatherTexture = tslTexture(createPlaceholder2D())
  const localWeatherRepeat = uniform(new Vector2(100, 100))
  const localWeatherOffset = uniform(new Vector2(0, 0))

  const sampleWeather = createSampleWeather(
    localWeatherTexture,
    localWeatherRepeat,
    localWeatherOffset,
    minLayerHeights,
    maxLayerHeights,
    uniform(new Vector4(1, 1, 1, 1)),
    uniform(new Vector4(0.35, 0.35, 0.35, 0.35)),
    uniform(0.3),
    uniform(new Vector4(0.6, 0.6, 0.6, 0.5)),
    uniform(new Vector4(1, 1, 1, 1)),
    'rgba',
    false,
    GENERIC_LAYER_STRUCTURE,
    // other features' deps, off so the digest is this file's business only:
    // the evolving-weather sampler, then the convective deps
    null,
    null,
    options.cloudTypes
  )

  const sampleMedia = createSampleMedia(
    volume(),
    uniform(new Vector3(0.0003, 0.0003, 0.0003)),
    uniform(new Vector3(0, 0, 0)),
    uniform(new Vector4(1, 1, 1, 1)),
    volume(),
    uniform(new Vector3(0.001, 0.001, 0.001)),
    uniform(new Vector3(0, 0, 0)),
    uniform(new Vector4(1, 1, 1, 1)),
    tslTexture(createPlaceholder2D()),
    uniform(new Vector2(20, 20)),
    uniform(350),
    localWeatherRepeat,
    localWeatherOffset,
    uniform(new Vector4(0.2, 0.2, 0.003, 0.2)),
    uniform(new Vector4(0, 0, 0, 0)),
    uniform(new Vector4(0, 0, 0, 0)),
    uniform(new Vector4(0.75, 0.75, 0.75, 0.75)),
    uniform(new Vector4(0.25, 0.25, 0.25, 0.25)),
    options.turbulence ?? false,
    options.shapeDetail ?? true,
    // The shape-detail fade is another feature's flag and defaults off, so the
    // digest is this file's business only
    false,
    GENERIC_LAYER_STRUCTURE,
    // the convective deps, off so the digest is this file's business only
    // createSampleMedia has no weather-sampler seam, so one null here
    null,
    options.cloudTypes
  )

  return { sampleWeather, sampleMedia }
}

const irradianceStruct = struct(
  { direct: 'vec3', indirect: 'vec3' },
  'MockIrradiance'
)

/**
 * The whole compiled surface a cloud-type change can reach: weather sampling,
 * media sampling and the primary march that drives them, with turbulence and
 * shape detail on so every modulated parameter is in the graph
 */
export function compileDensity(
  options: DensityGraphOptions = {}
): CompileResult {
  const { sampleWeather, sampleMedia } = createDensityGraph({
    shapeDetail: true,
    turbulence: true,
    ...options
  })
  const marchClouds = createMarchClouds({
    sampleWeather,
    sampleMedia,
    getCloudsSunSkyIrradiance: Fn(() =>
      irradianceStruct(vec3(1, 1, 1), vec3(0.2, 0.2, 0.3))
    ),
    marchOpticalDepth: Fn(() => vec2(0.7, 1200)),
    approxMultiScatter: Fn(() => vec3(0.5, 0.5, 0.5)),
    bottomRadius: uniform(6360000),
    sunDirection: uniform(vec3(0, 0, 1)),
    minHeight: uniform(750),
    maxHeight: uniform(8000),
    minIntervalHeights: uniform(vec3(0, 0, 0)),
    maxIntervalHeights: uniform(vec3(0, 0, 0)),
    minLayerHeights: uniform(LAYER_HEIGHTS.min),
    maxLayerHeights: uniform(LAYER_HEIGHTS.max),
    maxIterationCount: 8,
    maxIterationCountToSun: 3,
    minStepSize: uniform(50),
    maxStepSize: uniform(1000),
    perspectiveStepScale: uniform(1.01),
    minDensity: uniform(1e-4),
    minExtinction: uniform(1e-4),
    minTransmittance: uniform(1e-3),
    skyLightScale: uniform(1),
    scatteringCoefficient: uniform(1),
    absorptionCoefficient: uniform(0.02),
    powderScale: uniform(0.8),
    powderExponent: uniform(150),
    worldToUnit: uniform(1 / 6360000),
    shadowTopHeight: uniform(3000),
    shapeDetail: true
  } as never)
  const node = Fn(() =>
    marchClouds(
      vec3(0, 0, 6361000),
      vec3(0, 0, 1),
      vec2(0, 5000),
      float(0.9),
      float(0.5),
      float(1)
    ).get('layer')
  )()
  return compileWGSL(node)
}

export function compileDensityWGSL(options: DensityGraphOptions = {}): string {
  return compileDensity(options).fragment
}
