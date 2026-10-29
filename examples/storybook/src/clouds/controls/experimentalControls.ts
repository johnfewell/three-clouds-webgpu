import type { ArgTypes } from '@storybook/react-vite'
import type { DataTexture } from 'three'
import {
  applyReferenceMode,
  cloudShapeDefaults,
  createCloudTypeMap,
  experimentalDefaults,
  type CloudsContext,
  type CloudShapeParams,
  type ExperimentalCloudOptions
} from 'three-clouds-webgpu'

// The four shape knobs. Not experimentalOptions keys: they are magnitudes, so
// they get their own number controls rather than a boolean each
export const shapeLabels = {
  baseShadow: 'Base shadow strength',
  baseShadowHeight: 'Base shadow depth',
  horizonCoverage: 'Horizon coverage bank',
  windSkewEast: 'Wind skew east (m)',
  windSkewNorth: 'Wind skew north (m)',
  erosionShape: 'Erosion shape'
} as const

export type ShapeKey = keyof typeof shapeLabels

export const shapeArgs = (): Record<ShapeKey, number> => ({
  baseShadow: 0,
  baseShadowHeight: 0.3,
  horizonCoverage: 0,
  windSkewEast: 0,
  windSkewNorth: 0,
  erosionShape: 0
})

export const experimentLabels = {
  cloudFrontRefinement: 'Cloud-front refinement',
  computeResolve: 'Compute resolve',
  windReprojection: 'Wind reprojection',
  distantCloudShadows: 'Distant-cloud shadows',
  directionalSkylight: 'Directional skylight',
  distantShapeDetailFade: 'Distant shape-detail fade',
  cloudTypeMap: 'Cloud-type map',
  evolvingWeather: 'Evolving weather',
  proceduralWeather: 'Procedural weather map',
  convectiveProfile: 'Convective anvil and cells',
  rainShafts: 'Rain shafts under cells',
  moonlight: 'Moonlight',
  lightning: 'Storm lightning flashes',
  cloudEnvironment: 'Cloud environment map',
  staticMode: 'Static rendering mode (skip unchanged)',
  cirrusDeck: 'Cirrus deck (2D texture)',
  shadowRoundRobin: 'Shadow cascades round-robin'
} satisfies Record<keyof ExperimentalCloudOptions, string>

type ExperimentKey = keyof ExperimentalCloudOptions
export type ExperimentalArgs = {
  [K in ExperimentKey as `experimental-${K}`]: boolean
} & {
  experimentMode: 'baseline' | 'experiments'
  cloudMotion: 'weather' | 'shape'
  baseShadow: number
  baseShadowHeight: number
  horizonCoverage: number
  windSkewEast: number
  windSkewNorth: number
  erosionShape: number
  // How many type regions fit across one weather tiling. The map rides
  // localWeatherRepeat, so this is the only scale knob there is
  cloudTypeRegions: number
}

/**
 * The library default for every switch, never a hand-typed literal: a promoted
 * option must show what a consumer actually gets, and Baseline shows the
 * reference with it off
 */
export const experimentalArgs = (): ExperimentalArgs => ({
  experimentMode: 'experiments',
  cloudMotion: 'weather',
  'experimental-cloudFrontRefinement':
    experimentalDefaults.cloudFrontRefinement,
  'experimental-computeResolve': experimentalDefaults.computeResolve,
  'experimental-windReprojection': experimentalDefaults.windReprojection,
  'experimental-distantCloudShadows': experimentalDefaults.distantCloudShadows,
  'experimental-directionalSkylight': experimentalDefaults.directionalSkylight,
  'experimental-distantShapeDetailFade':
    experimentalDefaults.distantShapeDetailFade,
  'experimental-cloudTypeMap': experimentalDefaults.cloudTypeMap,
  'experimental-convectiveProfile': experimentalDefaults.convectiveProfile,
  'experimental-rainShafts': experimentalDefaults.rainShafts,
  'experimental-proceduralWeather': experimentalDefaults.proceduralWeather,
  'experimental-evolvingWeather': experimentalDefaults.evolvingWeather,
  'experimental-moonlight': experimentalDefaults.moonlight,
  'experimental-lightning': experimentalDefaults.lightning,
  'experimental-cloudEnvironment': experimentalDefaults.cloudEnvironment,
  'experimental-staticMode': experimentalDefaults.staticMode,
  'experimental-cirrusDeck': experimentalDefaults.cirrusDeck,
  'experimental-shadowRoundRobin': experimentalDefaults.shadowRoundRobin,
  cloudTypeRegions: 4,
  ...shapeArgs()
})

/**
 * The shape knobs, read from the library defaults rather than restated, so a
 * promoted default would show what a consumer actually gets. Every magnitude is
 * a graph-time literal, so this write rebuilds the march
 */
export function selectedCloudShape(args: ExperimentalArgs): CloudShapeParams {
  return {
    ...cloudShapeDefaults,
    baseShadowStrength: args.baseShadow,
    baseShadowHeight: args.baseShadowHeight,
    horizonCoverageAmount: args.horizonCoverage,
    windSkewEast: args.windSkewEast,
    windSkewNorth: args.windSkewNorth,
    erosionShape: args.erosionShape
  }
}

export function selectedExperiments(
  args: ExperimentalArgs
): ExperimentalCloudOptions {
  const enabled = args.experimentMode === 'experiments'
  return {
    cloudFrontRefinement: enabled && args['experimental-cloudFrontRefinement'],
    computeResolve: enabled && args['experimental-computeResolve'],
    windReprojection: enabled && args['experimental-windReprojection'],
    distantCloudShadows: enabled && args['experimental-distantCloudShadows'],
    directionalSkylight: enabled && args['experimental-directionalSkylight'],
    distantShapeDetailFade:
      enabled && args['experimental-distantShapeDetailFade'],
    cloudTypeMap: enabled && args['experimental-cloudTypeMap'],
    evolvingWeather: enabled && args['experimental-evolvingWeather'],
    proceduralWeather: enabled && args['experimental-proceduralWeather'],
    convectiveProfile: enabled && args['experimental-convectiveProfile'],
    rainShafts: enabled && args['experimental-rainShafts'],
    moonlight: enabled && args['experimental-moonlight'],
    lightning: enabled && args['experimental-lightning'],
    cloudEnvironment: enabled && args['experimental-cloudEnvironment'],
    staticMode: enabled && args['experimental-staticMode'],
    cirrusDeck: enabled && args['experimental-cirrusDeck'],
    shadowRoundRobin: enabled && args['experimental-shadowRoundRobin']
  }
}

// Baseline is the reference, not merely "the experiments off": clearing the
// switches leaves the port defaults in place, so before reference mode this
// comparison was already against something the original does not do
export function applyComparisonMode(
  ctx: CloudsContext,
  args: ExperimentalArgs
): void {
  // Experiments writes the panel's switches, not the port defaults. Applied
  // after the switches, those defaults put back every default-on one set off
  if (args.experimentMode === 'baseline') applyReferenceMode(ctx)
  else ctx.experimental = selectedExperiments(args)
  // The shape magnitudes win in both modes, so switching to Baseline pins the
  // shape and these values win straight back
  ctx.cloudShape = selectedCloudShape(args)
}

/**
 * Author the map the flag turns on: a regional weight texture on the
 * stratiform-to-cumuliform axis, whose anchors the flag blends against. Called
 * on every transient change, so a map swap is a uniform update and not a graph
 * rebuild
 */
const regionMaps = new Map<number, DataTexture>()

export function applyCloudTypes(ctx: CloudsContext, regions: number): void {
  // Cached per region count: the map is noise over a fixed lattice, and
  // regenerating it on every transient change would allocate a texture per
  // frame while a knob is dragged
  const cells = Math.max(1, Math.round(regions))
  let map = regionMaps.get(cells)
  if (map == null) {
    map = createCloudTypeMap({ cells })
    regionMaps.set(cells, map)
  }
  ctx.cloudTypes.setMap(map)
}

const experimentControl = (key: ExperimentKey) => ({
  name: experimentLabels[key],
  control: { type: 'boolean' as const },
  table: { category: 'clouds experiments' }
})

export const experimentalArgTypes = (): ArgTypes<ExperimentalArgs> => ({
  experimentMode: {
    name: 'Comparison',
    control: {
      type: 'inline-radio',
      labels: { baseline: 'Baseline', experiments: 'Experiments' }
    },
    options: ['baseline', 'experiments'],
    table: { category: 'clouds experiments' }
  },
  'experimental-cloudFrontRefinement': experimentControl(
    'cloudFrontRefinement'
  ),
  'experimental-computeResolve': experimentControl('computeResolve'),
  'experimental-windReprojection': experimentControl('windReprojection'),
  'experimental-distantCloudShadows': experimentControl('distantCloudShadows'),
  'experimental-directionalSkylight': experimentControl('directionalSkylight'),
  'experimental-distantShapeDetailFade': experimentControl(
    'distantShapeDetailFade'
  ),
  'experimental-cloudTypeMap': experimentControl('cloudTypeMap'),
  'experimental-convectiveProfile': experimentControl('convectiveProfile'),
  'experimental-rainShafts': experimentControl('rainShafts'),
  'experimental-proceduralWeather': experimentControl('proceduralWeather'),
  'experimental-evolvingWeather': experimentControl('evolvingWeather'),
  'experimental-moonlight': experimentControl('moonlight'),
  'experimental-lightning': experimentControl('lightning'),
  'experimental-cloudEnvironment': experimentControl('cloudEnvironment'),
  'experimental-staticMode': experimentControl('staticMode'),
  'experimental-cirrusDeck': experimentControl('cirrusDeck'),
  'experimental-shadowRoundRobin': experimentControl('shadowRoundRobin'),
  cloudTypeRegions: {
    name: 'Type regions per weather tiling',
    control: { type: 'number' as const, min: 1, max: 24, step: 1 },
    table: { category: 'clouds experiments' }
  },
  baseShadow: {
    name: shapeLabels.baseShadow,
    control: { type: 'range' as const, min: 0, max: 4, step: 0.1 },
    table: { category: 'cloud shape' }
  },
  baseShadowHeight: {
    name: shapeLabels.baseShadowHeight,
    control: { type: 'range' as const, min: 0.05, max: 1, step: 0.05 },
    table: { category: 'cloud shape' }
  },
  horizonCoverage: {
    name: shapeLabels.horizonCoverage,
    control: { type: 'range' as const, min: -0.4, max: 0.6, step: 0.05 },
    table: { category: 'cloud shape' }
  },
  windSkewEast: {
    name: shapeLabels.windSkewEast,
    control: { type: 'range' as const, min: -800, max: 800, step: 20 },
    table: { category: 'cloud shape' }
  },
  windSkewNorth: {
    name: shapeLabels.windSkewNorth,
    control: { type: 'range' as const, min: -800, max: 800, step: 20 },
    table: { category: 'cloud shape' }
  },
  erosionShape: {
    name: shapeLabels.erosionShape,
    control: { type: 'range' as const, min: -1, max: 2, step: 0.05 },
    table: { category: 'cloud shape' }
  },
  cloudMotion: {
    name: 'Motion field',
    control: {
      type: 'select',
      labels: { weather: 'Weather evolution', shape: 'Shape advection' }
    },
    options: ['weather', 'shape'],
    table: { category: 'clouds' }
  }
})

export function applyCloudMotion(
  ctx: CloudsContext,
  animate: boolean,
  motion: ExperimentalArgs['cloudMotion']
): void {
  ctx.localWeatherVelocity.set(animate && motion === 'weather' ? 0.001 : 0, 0)
  // Equal world-space translation keeps base and detail density compatible
  // with reprojection. Weather evolution intentionally remains a separate mode.
  const speed = animate && motion === 'shape' ? 20 : 0
  ctx.shapeVelocity.set(speed * ctx.shapeRepeat.x, 0, 0)
  ctx.shapeDetailVelocity.set(speed * ctx.shapeDetailRepeat.x, 0, 0)
}
