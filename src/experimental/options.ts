// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

export interface ExperimentalCloudOptions {
  cloudFrontRefinement: boolean
  computeResolve: boolean
  windReprojection: boolean
  distantCloudShadows: boolean
  directionalSkylight: boolean
  distantShapeDetailFade: boolean
  // Blends cloudTypes' regional map into the per-lane density parameters
  // Needs context.cloudTypes.setMap() called; without a map it is inert
  cloudTypeMap: boolean
  convectiveProfile: boolean
  proceduralWeather: boolean
  evolvingWeather: boolean
  // Precipitation curtains hanging below convective cells. Shares the cell mask
  // convectiveProfile places, so read them together (docs/EXPERIMENTAL.md)
  rainShafts: boolean
  // Retargets the march's one light onto the moon after sunset
  moonlight: boolean
  lightning: boolean
  // Bakes the sky plus a low-resolution cloud march into a cube map, read by
  // scene.environmentNode. cloudsPass.environment is inert until a graph exists
  cloudEnvironment: boolean
  // Skips the cloud march, shadow pass and resolve while inputs are unchanged
  // and temporal history has converged
  staticMode: boolean
  // A textured high-altitude sheet behind the volumetric layers, read once per
  // pixel. Its knobs are CloudsContext.cirrusDeck
  cirrusDeck: boolean
  // Each shadow update re-renders one cascade in turn and reuses the others,
  // with a full update after a reset or a large camera or sun move
  shadowRoundRobin: boolean
}

export const experimentalDefaults: Readonly<ExperimentalCloudOptions> =
  Object.freeze({
    // Promoted 2026-10-02: every frame-time delta in the cost
    // measurement sat inside the inert-control noise floor, at most 0.6% of a
    // 15 ms frame. Reference mode pins it off, so the ladder is unaffected
    cloudFrontRefinement: true,
    computeResolve: false,
    windReprojection: false,
    distantCloudShadows: false,
    // Not promoted yet: with it on, building the composite and then the march in
    // two separate builders throws. One real renderer has rendered it cleanly,
    // and a hardware check of a double build is pending
    directionalSkylight: false,
    // Promoted from opt-in 2026-10-02, the only experiment with
    // both a quality and a cost measurement. Reference mode pins it off, so the
    // parity ladder is unaffected. Evidence: standalone-defaults.md 6.4
    distantShapeDetailFade: true,
    cloudTypeMap: false,
    evolvingWeather: false,
    proceduralWeather: false,
    convectiveProfile: false,
    rainShafts: false,
    moonlight: false,
    lightning: false,
    cloudEnvironment: false,
    staticMode: false,
    cirrusDeck: false,
    shadowRoundRobin: false
  })

// Options that build a separate graph or run host dispatch without modifying
// screen pass WGSL. The digest matrix skips them to avoid redundant records
export const SECONDARY_GRAPH_EXPERIMENTAL: ReadonlySet<
  keyof ExperimentalCloudOptions
> = new Set<keyof ExperimentalCloudOptions>(['cloudEnvironment', 'staticMode'])

// The slice of CloudsContext these checks read. Structural, so the bookkeeping
// tests can drive it with stubs and no GPU
export interface ExperimentalWarningInput {
  experimental: Readonly<ExperimentalCloudOptions>
  debug: string
  // cloudLayers.castsShadow, i.e. whether any of the four slots casts
  castsShadow: boolean
  localWeatherVelocity: { lengthSq(): number }
  // Whether the shadow-length march runs. The shafts read its result for the
  // sun transmittance, so without it they stay lit under the deck
  lightShafts: boolean
}

export interface ExperimentalWarning {
  id: string
  message: string
}

const WARNING_PREFIX = 'three-clouds-webgpu:'

// Warnings for experimental options that are on but cannot do anything. Each is
// a documented limitation, not a defect, so it is reported rather than fixed
// (docs/EXPERIMENTAL.md). Emitted once per id by CloudsPassNode
export function experimentalWarnings(
  input: ExperimentalWarningInput
): ExperimentalWarning[] {
  const { experimental } = input
  const warnings: ExperimentalWarning[] = []

  // Exact zero, not an epsilon: the option reprojects SHAPE-texture motion
  // only, so any weather velocity at all means there is nothing for it to
  // compensate and it renders exactly what the option-off path renders
  if (
    experimental.windReprojection &&
    input.localWeatherVelocity.lengthSq() > 0
  ) {
    warnings.push({
      id: 'windReprojection/localWeatherVelocity',
      message:
        `${WARNING_PREFIX} experimental.windReprojection is on but ` +
        'clouds.localWeatherVelocity is non-zero. The option reprojects ' +
        'shape-texture motion, not weather motion, so with the weather map ' +
        'advecting it has nothing to compensate and does nothing. Set ' +
        'localWeatherVelocity to zero and animate clouds.shapeVelocity, or ' +
        'turn the option off.'
    })
  }

  if (experimental.distantCloudShadows && !input.castsShadow) {
    warnings.push({
      id: 'distantCloudShadows/noShadowCastingLayer',
      message:
        `${WARNING_PREFIX} experimental.distantCloudShadows is on but no ` +
        'layer casts shadows, so there is no shadow map to read. Set shadow ' +
        'on at least one cloud layer.'
    })
  }

  // The compute resolve is skipped under any debug view, because the views read
  // intermediate state the compute path does not write
  if (experimental.computeResolve && input.debug !== 'none') {
    warnings.push({
      id: 'computeResolve/debugView',
      message:
        `${WARNING_PREFIX} experimental.computeResolve is on but the debug ` +
        `view is '${input.debug}', and the compute resolve is skipped while a ` +
        "debug view is active. Set clouds.debug to 'none' for the option to run."
    })
  }

  if (experimental.rainShafts && !input.lightShafts) {
    warnings.push({
      id: 'rainShafts/noLightShafts',
      message:
        `${WARNING_PREFIX} experimental.rainShafts is on but ` +
        'clouds.lightShafts is off, and the shafts take their sun ' +
        'transmittance from the marched cloud shadow length. They will be ' +
        'lit even under the cell that made them. Turn clouds.lightShafts on.'
    })
  }

  return warnings
}
