// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

/**
 * The vanilla WebGPU surface. Start at {@link clouds}, configure
 * {@link CloudsContext}, composite through {@link CloudsPassNode.composite},
 * and read the outputs for shadow consumers.
 *
 * Three more entry points sit alongside this one. `three-clouds-webgpu/webgpu`
 * re-exports exactly these, the React bindings are at
 * `three-clouds-webgpu/r3f`, and the procedurally generated textures stand in
 * for the four baked assets when you do not ship them.
 *
 * The complete 1:1 mapping from the WebGL `CloudsEffect` is in
 * `docs/MIGRATION.md`, and the opt-in experiments are in
 * `docs/EXPERIMENTAL.md`.
 */

export { CameraUniforms } from './CameraUniforms'
export {
  createCloudsIntegration,
  type CloudsIntegration,
  type CloudsIntegrationOptions,
  type CloudsIntegrationTextures,
  type CloudsIntegrationUpdate
} from './integration'
export {
  inspectCloudsSetup,
  type CloudSetupDiagnostic,
  type CloudsSetupInspection,
  type InspectCloudsSetupOptions
} from './diagnostics'
export {
  CloudsContext,
  getCloudsContext,
  type DebugView
} from './CloudsContext'
export {
  assertWebGPUSupported,
  CloudsPassNode,
  clouds,
  type CloudsOptions,
  type CloudShadowDescriptor
} from './CloudsPassNode'
export {
  CloudLayer,
  type CloudLayerLike,
  type TextureChannel
} from './CloudLayer'
export { CloudLayers } from './CloudLayers'
export { DensityProfile, type DensityProfileLike } from './DensityProfile'
export type {
  CloudShapeDeps,
  CloudShapeParams
} from './experimental/cloudShape'
export { cloudShapeDefaults } from './experimental/cloudShape'
export type {
  ConvectiveProfileParams,
  ConvectiveUniforms
} from './experimental/convectiveProfile'
export {
  CONVECTIVE_TOWER_MIN_HEIGHT,
  CONVECTIVE_TOWER_RAMP,
  convectiveProfileDefaults
} from './experimental/convectiveProfile'
export type { CloudEnvironmentSettings } from './experimental/cloudEnvironment'
export {
  DEFAULT_WATER_PRO_CLOUD_SKY,
  WaterProCloudSky,
  type WaterProCloudSkyOptions,
  type WaterProSkyProvider
} from './experimental/waterProSky'
export { experimentalDefaults } from './experimental/options'
export {
  FULL_MOON_IRRADIANCE_RATIO,
  illuminatedFractionCPU,
  moonlightCPU,
  twilightBlendCPU,
  TWILIGHT_SIN_ELEVATION,
  type MoonlightNodes
} from './experimental/moonlight'
// The scheduler a consumer needs to run a storm, and nothing else: the CPU
// twins of the shader terms and the hash behind them are the tests' business,
// so they are imported from ./experimental/lightning by the tests that use them
export {
  flashEnvelopeCPU,
  flashPositionCPU,
  flashScheduleDefaults,
  lightningParamsDefault
} from './experimental/lightning'
export type {
  FlashSample,
  FlashScheduleOptions,
  LightningParams,
  LightningState
} from './experimental/lightning'
export type { EvolvingWeatherParams } from './experimental/evolvingWeather'
export { evolvingWeatherDefaults } from './experimental/evolvingWeather'
export type {
  RainShaftParams,
  RainShaftUniforms
} from './experimental/rainShafts'
export { rainShaftDefaults } from './experimental/rainShafts'
export type { CirrusDeckParams } from './experimental/cirrusDeck'
export { cirrusDeckDefaults } from './experimental/cirrusDeck'
export {
  createCirrusStreaksTexture,
  generateCirrusStreaks
} from './experimental/cirrusStreaks'
export type { ExperimentalCloudOptions } from './experimental/options'
export {
  applyCloudTypePreset,
  cloudTypePresetNames,
  cloudTypePresets,
  cloudTypeProfileAt,
  isCloudTypePresetName,
  type CloudTypeLayers,
  type CloudTypePreset,
  type CloudTypePresetName,
  type CloudTypePresetTarget
} from './experimental/cloudTypePresets'
export {
  applyPortDefaults,
  applyReferenceMode,
  PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION,
  REFERENCE_MODE,
  REFERENCE_MODE_PORT_ONLY_PATHS,
  REFERENCE_SHADOW_UPDATE_INTERVAL,
  referenceModePins,
  type ReferenceModePins
} from './referenceMode'
export {
  createLayerUniforms,
  updateLayerUniforms,
  type LayerUniforms
} from './layerUniforms'
export {
  applyQualityPreset,
  cloudsMaterialParameterKeys,
  cloudsUniformKeys,
  defaults,
  qualityPresets,
  shadowMapsParameterKeys,
  shadowMaterialParameterKeys,
  shadowPassParameterKeys,
  shadowUniformKeys,
  type CloudsPresetFields,
  type QualityPreset,
  type QualityPresetTarget,
  type QualityPresetValues,
  writeQualityPresetValues,
  type ShadowPresetFields
} from './qualityPresets'
export {
  createQualityGovernor,
  QUALITY_GOVERNOR_LEVEL_1,
  QualityGovernor,
  qualityGovernorDefaults,
  type QualityGovernorLevel,
  type QualityGovernorOptions,
  type QualityGovernorStepEvent,
  type QualityGovernorTarget
} from './QualityGovernor'
export {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL
} from './constants'
export {
  cloudShadowAtlasResolution,
  createCloudShadowNode,
  cpuCloudShadowTransmittance,
  type CloudShadowAtOptions,
  type CloudShadowNodeDeps,
  type CloudShadowNodeOptions
} from './shadow/cloudShadowNode'
export {
  createSampleCloudShadowOpticalDepth,
  createCloudShadowTransmittance,
  type GroundShadowExtraDeps
} from './shadow/sampleCloudShadowOpticalDepth'
export {
  createGetShadowRadius,
  DEFAULT_SHADOW_RADIUS,
  // the parity harness's radius receipt uses the shipped
  // footprint->radius law. The parity example imports this package only by
  // name (dogfooding.test.ts), so the CPU twin is exported
  shadowRadiusFromFootprintCPU,
  type ShadowRadiusDeps
} from './shadow/shadowRadius'
export { getSTBN } from './march/jitter'
export { CloudShadowedAtmosphereLightNode } from './shadow/CloudShadowedAtmosphereLightNode'
export { aerialPerspectiveWithCloudShadow } from './shadow/aerialShadowAdapter'
export {
  createHashJitterTexture,
  createJitterTexture,
  CloudTextureLoadError,
  loadBakedCloudTextures,
  type BakedCloudTextures,
  type BakedCloudTextureUrls,
  type CloudTextureAsset,
  type LoadBakedCloudTexturesOptions
} from './textures/loadBakedCloudTextures'

// Procedural texture generators
export {
  CloudShape,
  CloudShapeDetail,
  LocalWeather,
  Turbulence,
  LOCAL_WEATHER_SIZE,
  TURBULENCE_SIZE
} from './textures/generators'
export {
  Procedural3DTexture,
  ProceduralTexture2D,
  type ProceduralTextureLike
} from './textures/ProceduralTexture'
// Regional cloud-type morph (docs/design/cloud-types.md 3.4)
export {
  blendCloudTypeParameter,
  CLOUD_TYPE_PARAMS,
  CLOUD_TYPE_TENT_SCOPES,
  cloudTypeAnchors,
  cloudTypeArchetypes,
  cloudTypeTentNames,
  cloudTypeTentWeights,
  CloudTypes,
  cpuBlendCloudTypeParameter,
  cpuCloudTypeTentWeights,
  createCloudTypeMap,
  type CloudTypeAnchor,
  type CloudTypeAnchorDeltas,
  type CloudTypeArchetype,
  type CloudTypeBlendNodes,
  type CloudTypeDeltas,
  type CloudTypeParam,
  type CloudTypeTentScope
} from './experimental/cloudTypeMap'

export {
  createProceduralWeather,
  ProceduralWeather,
  type ProceduralWeatherParameters,
  type ProceduralWeatherGenerator,
  type WeatherChannel,
  type WeatherChannelNodes,
  type WeatherChannelParameters,
  type WeatherPattern
} from './experimental/proceduralWeather'

// The sun sync and whole-scene presets. Pure JS over the takram celestial
// helpers: no shader node, no graph change, and no clock of its own
export {
  celestialVector,
  computeCelestialDirections,
  resolveTimeOfDay,
  syncCelestialDirections,
  type CelestialDirections,
  type CelestialSink,
  type CelestialVector,
  type TimeOfDayLocation,
  type TimeOfDayRequest
} from './experimental/timeOfDay'
export {
  applyScenePreset,
  isScenePresetName,
  scenePresetNames,
  scenePresets,
  type AppliedScenePreset,
  type ScenePreset,
  type ScenePresetName,
  type ScenePresetRequest,
  type ScenePresetTarget
} from './experimental/scenePresets'
