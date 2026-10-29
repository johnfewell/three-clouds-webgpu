import { describe, expect, it } from 'vitest'

// On the package root because an embedder builds them: the shadow radius and
// STBN helpers, the parity receipt's footprint CPU twin,
// the generators, reference mode, the morph, procedural weather
const EXPECTED_EXPORTS = [
  'CONVECTIVE_TOWER_MIN_HEIGHT',
  'CONVECTIVE_TOWER_RAMP',
  'CLOUD_SHAPE_DETAIL_TEXTURE_SIZE',
  'CLOUD_SHAPE_TEXTURE_SIZE',
  'CLOUD_TYPE_PARAMS',
  'CLOUD_TYPE_TENT_SCOPES',
  'CameraUniforms',
  'CloudLayer',
  'CloudLayers',
  'CloudShadowedAtmosphereLightNode',
  'CloudShape',
  'CloudShapeDetail',
  'CloudTypes',
  'CloudTextureLoadError',
  'CloudsContext',
  'CloudsPassNode',
  'DEFAULT_LOCAL_WEATHER_URL',
  'DEFAULT_SHADOW_RADIUS',
  'DEFAULT_SHAPE_DETAIL_URL',
  'DEFAULT_SHAPE_URL',
  'DEFAULT_TURBULENCE_URL',
  'DensityProfile',
  'FULL_MOON_IRRADIANCE_RATIO',
  'LOCAL_WEATHER_SIZE',
  'LocalWeather',
  'Procedural3DTexture',
  'ProceduralTexture2D',
  'ProceduralWeather',
  'TURBULENCE_SIZE',
  'TWILIGHT_SIN_ELEVATION',
  'Turbulence',
  'aerialPerspectiveWithCloudShadow',
  'applyCloudTypePreset',
  'applyPortDefaults',
  'applyQualityPreset',
  'applyReferenceMode',
  // The WebGL2 refusal callers can actually catch. A setup() throw cannot
  // refuse construction, so this must be reachable
  // from the root or the guard is undiscoverable
  'assertWebGPUSupported',
  'blendCloudTypeParameter',
  'clouds',
  'cloudTypePresetNames',
  'cloudTypePresets',
  'cloudTypeProfileAt',
  'cloudsMaterialParameterKeys',
  'cloudsUniformKeys',
  // the public cloud shadow for a consumer's own materials
  'cloudShadowAtlasResolution',
  'cloudTypeAnchors',
  'cloudTypeArchetypes',
  'cloudTypeTentNames',
  'cloudTypeTentWeights',
  'cloudShapeDefaults',
  'convectiveProfileDefaults',
  'createCloudShadowNode',
  'createCloudsIntegration',
  'createCloudShadowTransmittance',
  'createCloudTypeMap',
  'createGetShadowRadius',
  'createHashJitterTexture',
  'illuminatedFractionCPU',
  'inspectCloudsSetup',
  'createJitterTexture',
  'createLayerUniforms',
  'createProceduralWeather',
  'createSampleCloudShadowOpticalDepth',
  'cpuBlendCloudTypeParameter',
  'cpuCloudShadowTransmittance',
  'cpuCloudTypeTentWeights',
  'defaults',
  'experimentalDefaults',
  'getCloudsContext',
  'getSTBN',
  'isCloudTypePresetName',
  'loadBakedCloudTextures',
  'moonlightCPU',
  'PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION',
  'qualityPresets',
  'QUALITY_GOVERNOR_LEVEL_1',
  'QualityGovernor',
  'qualityGovernorDefaults',
  'createQualityGovernor',
  'writeQualityPresetValues',
  'REFERENCE_MODE',
  'REFERENCE_MODE_PORT_ONLY_PATHS',
  'REFERENCE_SHADOW_UPDATE_INTERVAL',
  'rainShaftDefaults',
  'referenceModePins',
  'shadowMapsParameterKeys',
  'shadowMaterialParameterKeys',
  'shadowRadiusFromFootprintCPU',
  'shadowPassParameterKeys',
  'shadowUniformKeys',
  'twilightBlendCPU',
  'updateLayerUniforms',
  // The sun sync and the whole-scene presets: a time of day and a place in one
  // call, and the eight skies built on it
  'applyScenePreset',
  'celestialVector',
  'computeCelestialDirections',
  'isScenePresetName',
  'resolveTimeOfDay',
  'scenePresetNames',
  'scenePresets',
  'syncCelestialDirections',
  // The Water Pro custom-sky adapter: a sky provider that hands the environment
  // map to a third-party water system as the equirect it samples
  'DEFAULT_WATER_PRO_CLOUD_SKY',
  'WaterProCloudSky',
  // The storm scheduler: a discharge's envelope at a time the caller passes, and
  // a seeded strike on a shell. The CPU twins of the shader terms and the hash
  // behind them stay internal, since no consumer predicts a frame from them
  'flashEnvelopeCPU',
  'flashPositionCPU',
  'flashScheduleDefaults',
  'lightningParamsDefault',
  // The cirrus deck's knobs and its texture generator, for a custom sheet
  'cirrusDeckDefaults',
  'createCirrusStreaksTexture',
  'generateCirrusStreaks',
  // Evolving weather's knob defaults, in metres and seconds
  'evolvingWeatherDefaults'
].sort()

describe('exports', () => {
  it('src/index.ts exports match the expected list', async () => {
    const mod = await import('../src/index')
    const actual = Object.keys(mod).sort()
    console.table(
      EXPECTED_EXPORTS.map(name => ({
        name,
        exported: actual.includes(name)
      }))
    )
    expect(actual).toEqual(EXPECTED_EXPORTS)
  })

  it('src/webgpu re-exports the same objects', async () => {
    const main = await import('../src/index')
    const webgpu = await import('../src/webgpu/index')
    for (const key of EXPECTED_EXPORTS) {
      expect((webgpu as Record<string, unknown>)[key]).toBe(
        (main as Record<string, unknown>)[key]
      )
    }
  })
})
