// The clouds control panel in Storybook-args form: the port of the WebGL
// storybook's leva panel, which is three-geospatial storybook/src/clouds/
// helpers/useCloudsControls.ts @ b012ad06 (MIT, Copyright (c) 2024 Shota
// Matsuda), vendored verbatim at clouds-webgl/vendor/useCloudsControls.ts

// Knob names are the CloudsContext keys (1:1 with CloudsEffect), and one
// table drives args, argTypes and the hook, so a knob cannot exist in the
// panel without reaching the context

import type { ArgTypes } from '@storybook/react-vite'
import { useContext } from 'react'
import {
  qualityPresets,
  REFERENCE_MODE_PORT_ONLY_PATHS,
  type CloudsContext,
  type DebugView,
  type QualityPreset
} from 'three-clouds-webgpu'

import { StoryContext } from '../../vendor/helpers/StoryContext'
import { useTransientControl } from '../../vendor/hooks/useTransientControl'
import {
  applyCloudMotion,
  applyCloudTypes,
  applyComparisonMode,
  experimentalArgs,
  experimentalArgTypes,
  type ExperimentalArgs
} from './experimentalControls'

// A knob is a scalar the panel edits, with the context read/write it maps to
// `log10` knobs are edited as exponents, `scale` knobs pre-multiplied
// (shapeRepeat is 3e-4 in the context and "3" in the panel, as upstream)
interface Knob {
  key: string
  name: string
  category: string
  control:
    | { type: 'range'; min: number; max: number; step?: number }
    | { type: 'boolean' }
    | { type: 'select'; options: readonly (string | number)[] }
  get: (ctx: CloudsContext) => number | boolean | string
  set: (ctx: CloudsContext, value: never) => void
  log10?: boolean
  scale?: number
}

const range = (min: number, max: number, step?: number): Knob['control'] => ({
  type: 'range',
  min,
  max,
  step
})
const bool = (): Knob['control'] => ({ type: 'boolean' })

function ctxKnob<K extends keyof CloudsContext>(
  key: K,
  category: string,
  control: Knob['control'],
  name: string = key
): Knob {
  return {
    key,
    name,
    category,
    control,
    get: ctx => ctx[key] as number | boolean | string,
    set: (ctx, value) => {
      ;(ctx as unknown as Record<string, unknown>)[key] = value
    }
  }
}

function cloudsKnob<K extends keyof CloudsContext['clouds']>(
  key: K,
  category: string,
  control: Knob['control'],
  options: { log10?: boolean; name?: string } = {}
): Knob {
  return {
    key: `clouds-${key}`,
    name: options.name ?? key,
    category,
    control,
    get: ctx => ctx.clouds[key],
    set: (ctx, value) => {
      ;(ctx.clouds as unknown as Record<string, unknown>)[key] = value
    },
    log10: options.log10
  }
}

function shadowKnob<K extends keyof CloudsContext['shadow']>(
  key: K,
  category: string,
  control: Knob['control'],
  options: { log10?: boolean; name?: string } = {}
): Knob {
  return {
    key: `shadow-${key}`,
    name: options.name ?? key,
    category,
    control,
    get: ctx => ctx.shadow[key] as number | boolean,
    set: (ctx, value) => {
      ;(ctx.shadow as unknown as Record<string, unknown>)[key] = value
    },
    log10: options.log10
  }
}

// The cirrus deck's scalars. Read only with experimental.cirrusDeck on
function cirrusKnob(
  key: 'strength' | 'altitude' | 'scale' | 'velocityU',
  control: Knob['control']
): Knob {
  return {
    key: `cirrusDeck-${key}`,
    name: key,
    category: CIRRUS,
    control,
    get: ctx => ctx.cirrusDeck[key],
    set: (ctx, value: number) => {
      ctx.cirrusDeck[key] = value
    }
  }
}

// Vector components edited as separate args, e.g. localWeatherOffset.x.
function vectorKnob(
  key: 'localWeatherOffset' | 'shapeOffset' | 'shapeDetailOffset',
  axis: 'x' | 'y' | 'z',
  category: string
): Knob {
  return {
    key: `${key}-${axis}`,
    name: `${key} ${axis}`,
    category,
    control: range(0, 1),
    get: ctx => (ctx[key] as unknown as Record<string, number>)[axis] ?? 0,
    set: (ctx, value) => {
      ;(ctx[key] as unknown as Record<string, number>)[axis] = value
    }
  }
}

// Uniform-repeat vectors edited as one scalar (setScalar), as the WebGL panel
// does: localWeatherRepeat, shapeRepeat, shapeDetailRepeat, turbulenceRepeat
function repeatKnob(
  key:
    | 'localWeatherRepeat'
    | 'shapeRepeat'
    | 'shapeDetailRepeat'
    | 'turbulenceRepeat',
  category: string,
  control: Knob['control'],
  scale = 1
): Knob {
  return {
    key,
    name: scale === 1 ? key : `${key} ×${scale.toExponential(0)}`,
    category,
    control,
    get: ctx => ctx[key].x,
    set: (ctx, value) => {
      ctx[key].setScalar(value)
    },
    scale
  }
}

// CloudsContext.ts SPLIT_MODE_NAMES: the context stores the index
const SPLIT_MODE_NAMES = ['uniform', 'logarithmic', 'practical'] as const

const RENDERING = 'clouds rendering'
const SCATTERING = 'clouds scattering'
const WEATHER = 'clouds weather and shape'
const CSM = 'clouds cascaded shadow maps'
const ADVANCED_CLOUDS = 'clouds advanced'
const ADVANCED_SHADOW = 'clouds advanced shadow'
const CIRRUS = 'clouds cirrus deck'

// The panel, in the WebGL storybook's folder order
export const cloudsKnobs: readonly Knob[] = [
  // rendering
  ctxKnob('resolutionScale', RENDERING, {
    type: 'select',
    options: [0.5, 0.75, 1]
  }),
  ctxKnob('temporalUpscale', RENDERING, bool()),
  ctxKnob('lightShafts', RENDERING, bool()),
  // WebGPU-only: the shafts' shadow length marched once per 2x2 block of
  // march fragments (quad operations). No WebGL counterpart in the reference
  // panel
  ctxKnob(
    'lightShaftsHalfResolution',
    RENDERING,
    bool(),
    'lightShafts half resolution'
  ),
  ctxKnob('shapeDetail', RENDERING, bool()),
  ctxKnob('turbulence', RENDERING, bool()),
  ctxKnob('haze', RENDERING, bool()),
  // scattering
  ctxKnob('scatteringCoefficient', SCATTERING, range(0, 5)),
  ctxKnob('absorptionCoefficient', SCATTERING, range(0, 5)),
  ctxKnob('scatterAnisotropy1', SCATTERING, range(0, 1)),
  ctxKnob('scatterAnisotropy2', SCATTERING, range(-1, 0)),
  ctxKnob('scatterAnisotropyMix', SCATTERING, range(0, 1)),
  ctxKnob('skyLightScale', SCATTERING, range(0, 5)),
  ctxKnob('groundBounceScale', SCATTERING, range(0, 10)),
  ctxKnob('powderScale', SCATTERING, range(0, 1)),
  ctxKnob('powderExponent', SCATTERING, range(1, 1000)),
  // weather and shape
  repeatKnob('localWeatherRepeat', WEATHER, range(1, 200, 1)),
  vectorKnob('localWeatherOffset', 'x', WEATHER),
  vectorKnob('localWeatherOffset', 'y', WEATHER),
  repeatKnob('shapeRepeat', WEATHER, range(1, 10), 1e4),
  vectorKnob('shapeOffset', 'x', WEATHER),
  vectorKnob('shapeOffset', 'y', WEATHER),
  vectorKnob('shapeOffset', 'z', WEATHER),
  repeatKnob('shapeDetailRepeat', WEATHER, range(1, 10), 1e3),
  vectorKnob('shapeDetailOffset', 'x', WEATHER),
  vectorKnob('shapeDetailOffset', 'y', WEATHER),
  vectorKnob('shapeDetailOffset', 'z', WEATHER),
  repeatKnob('turbulenceRepeat', WEATHER, range(1, 50, 1)),
  ctxKnob('turbulenceDisplacement', WEATHER, range(1, 1000)),
  // cascaded shadow maps
  shadowKnob('cascadeCount', CSM, { type: 'select', options: [1, 2, 3, 4] }),
  {
    key: 'shadow-mapSize',
    name: 'mapSize',
    category: CSM,
    control: { type: 'select', options: [256, 512, 1024] },
    get: ctx => ctx.shadow.mapSize.x,
    set: (ctx, value: number) => {
      ctx.shadow.mapSize.setScalar(value)
    }
  },
  // splitMode is an index into ['uniform', 'logarithmic', 'practical'] on the
  // context (CloudsContext.ts SPLIT_MODE_NAMES); the panel shows the names
  {
    key: 'shadow-splitMode',
    name: 'splitMode',
    category: CSM,
    control: {
      type: 'select',
      options: ['practical', 'uniform', 'logarithmic']
    },
    get: ctx => SPLIT_MODE_NAMES[ctx.shadow.splitMode] ?? 'practical',
    set: (ctx, value: string) => {
      ctx.shadow.splitMode = Math.max(
        0,
        (SPLIT_MODE_NAMES as readonly string[]).indexOf(value)
      )
    }
  },
  shadowKnob('splitLambda', CSM, range(0, 1)),
  // advanced clouds: the three graph-shape parameters go through the
  // context's top-level setters (they bump graphVersion), the rest are
  // uniforms on context.clouds
  ctxKnob('multiScatteringOctaves', ADVANCED_CLOUDS, range(1, 12, 1)),
  ctxKnob('accurateSunSkyLight', ADVANCED_CLOUDS, bool()),
  ctxKnob('accuratePhaseFunction', ADVANCED_CLOUDS, bool()),
  cloudsKnob('maxIterationCount', ADVANCED_CLOUDS, range(10, 1000, 1)),
  cloudsKnob('minStepSize', ADVANCED_CLOUDS, range(10, 200, 1)),
  cloudsKnob('maxStepSize', ADVANCED_CLOUDS, range(200, 2000, 1)),
  cloudsKnob('maxRayDistance', ADVANCED_CLOUDS, range(1e4, 1e6)),
  cloudsKnob('perspectiveStepScale', ADVANCED_CLOUDS, range(1, 1.1, 0.001)),
  cloudsKnob('minDensity', ADVANCED_CLOUDS, range(-7, -1, 0.1), {
    log10: true,
    name: 'minDensity log10'
  }),
  cloudsKnob('minExtinction', ADVANCED_CLOUDS, range(-7, -1, 0.1), {
    log10: true,
    name: 'minExtinction log10'
  }),
  cloudsKnob('minTransmittance', ADVANCED_CLOUDS, range(-7, -1, 0.1), {
    log10: true,
    name: 'minTransmittance log10'
  }),
  cloudsKnob('maxIterationCountToSun', ADVANCED_CLOUDS, range(0, 10, 1)),
  cloudsKnob('maxIterationCountToGround', ADVANCED_CLOUDS, range(0, 10, 1)),
  cloudsKnob(
    'maxShadowLengthIterationCount',
    ADVANCED_CLOUDS,
    range(10, 1000, 1)
  ),
  cloudsKnob('minShadowLengthStepSize', ADVANCED_CLOUDS, range(50, 200, 1)),
  cloudsKnob('maxShadowLengthRayDistance', ADVANCED_CLOUDS, range(1e4, 1e6)),
  cloudsKnob('hazeDensityScale', ADVANCED_CLOUDS, range(-6, -3, 0.1), {
    log10: true,
    name: 'hazeDensityScale log10'
  }),
  cloudsKnob('hazeExponent', ADVANCED_CLOUDS, range(-3, -1, 0.1), {
    log10: true,
    name: 'hazeExponent log10'
  }),
  cloudsKnob('hazeScatteringCoefficient', ADVANCED_CLOUDS, range(0, 5)),
  cloudsKnob('hazeAbsorptionCoefficient', ADVANCED_CLOUDS, range(0, 5)),
  // advanced shadow
  // Port-only: the shadow map every N frames (default 2; 1 = the reference's
  // every frame). No WebGL counterpart in the reference panel.
  shadowKnob('updateInterval', ADVANCED_SHADOW, {
    type: 'select',
    options: [1, 2, 3, 4]
  }),
  shadowKnob('temporalPass', ADVANCED_SHADOW, bool()),
  shadowKnob('temporalJitter', ADVANCED_SHADOW, bool()),
  shadowKnob('maxIterationCount', ADVANCED_SHADOW, range(10, 100, 1)),
  shadowKnob('minStepSize', ADVANCED_SHADOW, range(10, 200, 1)),
  shadowKnob('maxStepSize', ADVANCED_SHADOW, range(200, 2000, 1)),
  shadowKnob('minDensity', ADVANCED_SHADOW, range(-7, -1, 0.1), {
    log10: true,
    name: 'minDensity log10'
  }),
  shadowKnob('minExtinction', ADVANCED_SHADOW, range(-7, -1, 0.1), {
    log10: true,
    name: 'minExtinction log10'
  }),
  shadowKnob('minTransmittance', ADVANCED_SHADOW, range(-7, -1, 0.1), {
    log10: true,
    name: 'minTransmittance log10'
  }),
  shadowKnob('opticalDepthTailScale', ADVANCED_SHADOW, range(0, 4)),
  // Port-only, with no WebGL counterpart: experimental.cirrusDeck's sheet
  cirrusKnob('strength', range(0, 1, 0.05)),
  cirrusKnob('altitude', range(6000, 14000, 100)),
  cirrusKnob('scale', range(5000, 120000, 1000)),
  cirrusKnob('velocityU', range(-60, 60, 1))
]

// Panel value <-> context value
function toPanel(knob: Knob, value: number | boolean | string): unknown {
  if (typeof value === 'number') {
    if (knob.log10 === true) return Math.log10(value)
    if (knob.scale != null) return value * knob.scale
  }
  return value
}

function fromPanel(knob: Knob, value: unknown): unknown {
  if (typeof value === 'number') {
    if (knob.log10 === true) return 10 ** value
    if (knob.scale != null) return value / knob.scale
  }
  return value
}

// The panel knobs on paths reference mode pins, matched by path so a new knob
// on one of them is covered without an edit here
const referenceKnobs = cloudsKnobs.filter(knob =>
  REFERENCE_MODE_PORT_ONLY_PATHS.includes(knob.key.replace('-', '.'))
)

// Every arg the comparison reads, flat because a transient control compares
// one level deep
const comparisonArgKeys = [
  ...Object.keys(experimentalArgs()),
  ...referenceKnobs.map(knob => knob.key)
]

export const DEBUG_VIEWS: readonly DebugView[] = [
  'none',
  'uv',
  'sampleCount',
  'marchIntervals',
  'frontDepth',
  'cascades',
  'shadowMap',
  'shadowLength',
  'velocity'
]

export interface CloudsArgs extends ExperimentalArgs {
  cloudsEnabled: boolean
  coverage: number
  animate: boolean
  qualityPreset: QualityPreset
  debug: DebugView
  // Not a clouds knob: upstream's WebGPU stories end in TAA, the WebGL ones in
  // SMAA. Off by default: the clouds resolve is already temporal (ADR-008), and
  // a second filter softens the distant decks (0.85-0.9x edge energy on Basic)
  storyTaa: boolean
  // The WebGL clouds stories end in SMAA, this one in nothing. Off by default,
  // same reason as storyTaa, but SMAA is spatial, not temporal
  storySmaa: boolean
  // The tail's dither, which is in BOTH chains (the WebGL stories end in
  // Dithering too), so it is not a difference between them. Off only to take
  // it out of an A/B
  storyDithering: boolean
  // The jitter volume: the library's blue-noise default, NVIDIA's STBN from
  // the upstream URL (what the WebGL reference stories sample, ADR-009
  // Amendment 1) or the old hash. Read by useJitterTexture, not the context
  jitter: 'blue' | 'stbn' | 'hash'
  [knob: string]: unknown
}

export interface CloudsArgsOptions {
  coverage?: number
  animate?: boolean
}

// A fresh context is what a story's clouds context looks like before the panel
// touches it, so the panel's initial values come from one: the same source the
// WebGL panel reads through `set({...effect})` once the effect mounts
export const cloudsArgs = (
  reference: CloudsContext,
  { coverage = 0.3, animate = false }: CloudsArgsOptions = {}
): CloudsArgs => ({
  ...experimentalArgs(),
  cloudsEnabled: true,
  coverage,
  animate,
  qualityPreset: reference.qualityPreset,
  debug: reference.debug,
  storyTaa: false,
  storySmaa: false,
  storyDithering: true,
  jitter: 'blue',
  ...Object.fromEntries(
    cloudsKnobs.map(knob => [knob.key, toPanel(knob, knob.get(reference))])
  )
})

export const cloudsArgTypes = (): ArgTypes<CloudsArgs> => ({
  ...experimentalArgTypes(),
  cloudsEnabled: {
    name: 'enabled',
    control: { type: 'boolean' },
    table: { category: 'clouds' }
  },
  coverage: {
    control: { type: 'range', min: 0, max: 1, step: 0.01 },
    table: { category: 'clouds' }
  },
  animate: {
    control: { type: 'boolean' },
    table: { category: 'clouds' }
  },
  qualityPreset: {
    name: 'quality preset',
    control: { type: 'select' },
    options: Object.keys(qualityPresets),
    table: { category: 'clouds' }
  },
  debug: {
    name: 'debug view',
    control: { type: 'select' },
    options: DEBUG_VIEWS,
    table: { category: 'clouds debug' }
  },
  storyTaa: {
    name: 'temporal antialias (story)',
    control: { type: 'boolean' },
    table: { category: 'clouds rendering' }
  },
  storySmaa: {
    name: 'SMAA (story)',
    control: { type: 'boolean' },
    table: { category: 'clouds rendering' }
  },
  storyDithering: {
    name: 'dithering (story)',
    control: { type: 'boolean' },
    table: { category: 'clouds rendering' }
  },
  jitter: {
    name: 'jitter volume',
    control: { type: 'select' },
    options: ['blue', 'stbn', 'hash'],
    table: { category: 'clouds rendering' }
  },
  ...Object.fromEntries(
    cloudsKnobs.map(knob => [
      knob.key,
      {
        name: knob.name,
        ...(knob.control.type === 'select'
          ? { control: { type: 'select' }, options: knob.control.options }
          : { control: knob.control }),
        table: { category: knob.category }
      }
    ])
  )
})

export interface CloudsControlsOptions {
  // Story-level shadow extent, outside the panel (the WebGL stories' shadow
  // maxFar/farScale props). A quality preset rewrites every shadow field, so
  // these are re-applied after each preset change
  shadowMaxFar?: number
  shadowFarScale?: number
}

// Applies the panel to a context. The quality preset is written first, and a
// preset change reflects its values back into the args (as the WebGL panel
// does), so the other knobs show what the preset chose
export function useCloudsControls(
  context: CloudsContext,
  { shadowMaxFar, shadowFarScale }: CloudsControlsOptions = {}
): void {
  const { updateArgs } = useContext(StoryContext)

  useTransientControl(
    ({ qualityPreset }: CloudsArgs) => qualityPreset,
    (qualityPreset, prevQualityPreset) => {
      context.qualityPreset = qualityPreset
      if (shadowMaxFar != null) context.shadow.maxFar = shadowMaxFar
      if (shadowFarScale != null) context.shadow.farScale = shadowFarScale
      if (prevQualityPreset != null) {
        updateArgs?.(
          Object.fromEntries(
            cloudsKnobs.map(knob => [
              knob.key,
              toPanel(knob, knob.get(context))
            ])
          )
        )
      }
    }
  )

  useTransientControl(
    ({ cloudsEnabled, coverage, debug }: CloudsArgs) => ({
      cloudsEnabled,
      coverage,
      debug
    }),
    ({ cloudsEnabled, coverage, debug }) => {
      context.enabled = cloudsEnabled
      context.coverage = coverage
      context.debug = debug
    }
  )

  useTransientControl(
    (args: CloudsArgs) =>
      Object.fromEntries(cloudsKnobs.map(knob => [knob.key, args[knob.key]])),
    (values, prevValues) => {
      for (const knob of cloudsKnobs) {
        const value = values[knob.key]
        if (value === undefined) continue
        if (prevValues != null && prevValues[knob.key] === value) continue
        knob.set(context, fromPanel(knob, value) as never)
      }
    }
  )

  useTransientControl(
    (args: CloudsArgs) => ({
      animate: args.animate,
      motion: args.cloudMotion,
      shapeRepeat: args.shapeRepeat,
      shapeDetailRepeat: args.shapeDetailRepeat
    }),
    ({ animate, motion }) => applyCloudMotion(context, animate, motion)
  )
  // The type map's CONTENT is uniform-only, so it is authored on every
  // transient change while the flag in `experimental` is what the graph sees
  useTransientControl(
    (args: CloudsArgs) => args.cloudTypeRegions,
    regions => {
      applyCloudTypes(context, regions)
    }
  )
  // One control in a fixed order, so no path applies the mode after the panel,
  // and Baseline still means the reference, not only "the experiments off"
  useTransientControl(
    (args: CloudsArgs) =>
      Object.fromEntries(comparisonArgKeys.map(key => [key, args[key]])),
    selection => {
      const args = selection as CloudsArgs
      applyComparisonMode(context, args)
      if (args.experimentMode === 'baseline') return
      // Reference mode pins these knobs too, so leaving it restores the panel's
      for (const knob of referenceKnobs) {
        knob.set(context, fromPanel(knob, args[knob.key]) as never)
      }
    }
  )
}
