// Behaviour-free refactor proof: every pass graph variant compiles to the SAME
// WGSL it compiled to on main, per graphVariantDigest.baseline.json. CPU only:
// compileWGSL builds over a stub renderer, so no GPU (test/helpers/compileWGSL)
// RECORD after a change that moves a digest, and only then:
//   CLOUDS_WGSL_DIGEST_RECORD=1 pnpm test -- src/pass/graphVariantDigest.test.ts

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Data3DTexture, DepthTexture, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { PerspectiveCamera, WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import {
  experimentalDefaults,
  SECONDARY_GRAPH_EXPERIMENTAL,
  type ExperimentalCloudOptions
} from '../experimental/options'
import BASELINE from './graphVariantDigest.baseline.json'

interface GraphVariant {
  name: string
  /** Applied to the context before the graph builds */
  knobs?: (ctx: CloudsContext) => void
  /** Device features compileWGSL's stub reports (subgroups for quad marches) */
  features?: string[]
  /** A scene depth node, so the scene-depth march branch builds */
  sceneDepth?: boolean
  /**
   * The experimental options this variant turns on, or undefined for a
   * variant that leaves them alone. Read by expectedBuildErrors() so a claim
   * about which variants fail to build is derived from the settings rather
   * than matched against the variant's name
   */
  experimentalOn?: readonly (keyof ExperimentalCloudOptions)[]
}

/**
 * Derived from `experimentalDefaults`, never written out by hand.
 *
 * A hardcoded list went stale the moment `distantShapeDetailFade` landed: the
 * cartesian covered 32 of 64 combinations and the suite stayed green, because
 * a variant never enumerated cannot fail a coverage check. Reading the keys off
 * the frozen defaults object makes that impossible
 *
 * SECONDARY_GRAPH_EXPERIMENTAL is the one subtraction, and it is read off the
 * options module rather than written out here: those options cannot change the
 * pass's programs, so each combination would record a digest the off case already
 * records. Their identity is asserted where it is claimed,
 * src/experimental/cloudEnvironment.digest.test.ts
 */
const EXPERIMENTAL_KEYS = (
  Object.keys(experimentalDefaults) as Array<keyof ExperimentalCloudOptions>
).filter(key => !SECONDARY_GRAPH_EXPERIMENTAL.has(key))

/**
 * The pairs whose compiled graph is not the union of the two alone-on graphs,
 * because one option reads what the other built. Every other pair's digest
 * equals one of its singles and records the same WGSL twice.
 *
 * What couples each pair is written out in docs/graph-variant-matrix.md, which
 * also carries the recording procedure. A new option that reads another
 * option's output adds an entry here and a row there
 */
const INTERACTING_PAIRS: ReadonlyArray<
  readonly [keyof ExperimentalCloudOptions, keyof ExperimentalCloudOptions]
> = [
  ['convectiveProfile', 'rainShafts'],
  ['moonlight', 'distantCloudShadows'],
  ['cloudTypeMap', 'evolvingWeather'],
  ['proceduralWeather', 'cloudTypeMap'],
  ['windReprojection', 'moonlight'],
  ['lightning', 'rainShafts'],
  ['cloudFrontRefinement', 'distantShapeDetailFade']
]

/** The option settings for a set of options on and every other one off */
function settingsWith(
  on: readonly (keyof ExperimentalCloudOptions)[]
): ExperimentalCloudOptions {
  // Built from the defaults object rather than from {} with a cast: the spread
  // is already the right type, so nothing here needs asserting
  const settings: ExperimentalCloudOptions = { ...experimentalDefaults }
  for (const key of Object.keys(settings) as (keyof ExperimentalCloudOptions)[])
    settings[key] = false
  for (const key of on) settings[key] = true
  return settings
}

/**
 * The experimental matrix: all options off, each option alone on, and the
 * known interacting pairs.
 *
 * It was the full 2^N cross product, so one more option doubled the file: 13
 * keys meant 8192 experimental variants, 8230 in all, and lightning and
 * moonlight took it there over two days. The baseline doubled with it, so
 * every option PR re-recorded megabytes and every concurrent option PR
 * conflicted on the same lines.
 *
 * What the byte-identical-off proof needs is linear, and 21 experimental rows
 * is what it got. Every digest here is one main already recorded for the same
 * settings, so the baseline is a subset of main's rather than a re-recording,
 * and `experimental/off` still equals main by construction.
 * docs/graph-variant-matrix.md has the table and the numbers
 */
function experimentalVariants(): GraphVariant[] {
  const out: GraphVariant[] = [
    {
      name: 'experimental/off',
      experimentalOn: [],
      knobs: ctx => void (ctx.experimental = settingsWith([]))
    }
  ]
  for (const key of EXPERIMENTAL_KEYS)
    out.push({
      name: `experimental/only/${key}`,
      experimentalOn: [key],
      knobs: ctx => void (ctx.experimental = settingsWith([key]))
    })
  for (const [a, b] of INTERACTING_PAIRS)
    out.push({
      name: `experimental/pair/${a}+${b}`,
      experimentalOn: [a, b],
      knobs: ctx => void (ctx.experimental = settingsWith([a, b]))
    })
  return out
}

// Every remaining graph-time switch, flipped one at a time from the default
function switchVariants(): GraphVariant[] {
  const out: GraphVariant[] = []
  const switches: Array<[string, (ctx: CloudsContext) => void]> = [
    ['shapeDetail', c => void (c.shapeDetail = !c.shapeDetail)],
    ['turbulence', c => void (c.turbulence = !c.turbulence)],
    ['lightShafts', c => void (c.lightShafts = !c.lightShafts)],
    [
      'lightShaftsHalfResolution',
      c => void (c.lightShaftsHalfResolution = !c.lightShaftsHalfResolution)
    ],
    ['haze', c => void (c.haze = !c.haze)],
    ['temporalUpscale', c => void (c.temporalUpscale = !c.temporalUpscale)],
    [
      'accurateSunSkyLight',
      c => void (c.accurateSunSkyLight = !c.accurateSunSkyLight)
    ],
    ['accuratePhaseFunction', c => void (c.accuratePhaseFunction = true)],
    ['groundBounce', c => void (c.groundBounceScale = 0)],
    ['multiScatteringOctaves=1', c => void (c.multiScatteringOctaves = 1)],
    ['scatterAnisotropy1', c => void (c.scatterAnisotropy1 = 0.35)],
    ['scatterAnisotropy2', c => void (c.scatterAnisotropy2 = 0.1)],
    ['scatterAnisotropyMix', c => void (c.scatterAnisotropyMix = 0.9)],
    // Lane 4 is the dead lane in DEFAULT, so it is the one that changes the key
    [
      'layerStructure',
      c =>
        void c.cloudLayers[3]!.set({
          channel: 'a',
          altitude: 9000,
          height: 400,
          densityScale: 0.1
        })
    ],
    ['localWeatherChannels', c => void (c.cloudLayers[3]!.channel = 'g')],
    ['logarithmicDepthBuffer', c => void (c.logarithmicDepthBuffer = true)],
    // One per shape control, so each seam's graph is recorded rather than the
    // four sharing one row
    [
      'cloudShape.baseShadow',
      c => void (c.cloudShape.baseShadowStrength = 1.4)
    ],
    [
      'cloudShape.horizonCoverage',
      c => void (c.cloudShape.horizonCoverageAmount = 0.25)
    ],
    ['cloudShape.windSkew', c => void (c.cloudShape.windSkewEast = 260)],
    ['cloudShape.erosion', c => void (c.cloudShape.erosionShape = 0.8)],
    // The pass refuses outright, so this variant's composite is a bare dst
    ['enabled=false', c => void (c.enabled = false)],
    ['shadowTemporalPass', c => void (c.shadow.temporalPass = false)],
    ['shadowTemporalJitter', c => void (c.shadow.temporalJitter = false)],
    [
      'noCasters',
      c => void c.cloudLayers.forEach(l => void (l.shadow = false))
    ],
    ['allCasters', c => void c.cloudLayers.forEach(l => void (l.shadow = true))]
  ]
  for (const [name, knobs] of switches)
    out.push({ name: `switch/${name}`, knobs })
  return out
}

// The cascade counts, both device branches, scene depth and every debug view
function branchVariants(): GraphVariant[] {
  const out: GraphVariant[] = []
  for (const n of [0, 1, 4]) {
    out.push({
      name: `shadow/cascadeCount=${n}`,
      knobs: c => void (c.shadow.cascadeCount = n)
    })
  }

  // The two device branches: quad operations need `subgroups`
  out.push({
    name: 'device/quads',
    features: ['subgroups'],
    knobs: c => void (c.lightShaftsHalfResolution = true)
  })

  out.push({ name: 'sceneDepth/on', sceneDepth: true })
  out.push({
    name: 'sceneDepth/on+quads',
    sceneDepth: true,
    features: ['subgroups']
  })

  // Every debug view, and the one that must work with no shadow casters
  const views = [
    'none',
    'cascades',
    'shadowMap',
    'uv',
    'sampleCount',
    'frontDepth',
    'shadowLength',
    'velocity',
    'marchIntervals'
  ] as const
  for (const view of views) {
    out.push({ name: `debug/${view}`, knobs: c => void (c.debug = view) })
  }
  out.push({
    name: 'debug/cascades-noCasters',
    knobs: c => {
      c.debug = 'cascades'
      c.cloudLayers.forEach(l => void (l.shadow = false))
    }
  })

  return out
}

/** The parity harness's side-B defaults: nothing set, so everything is default */
function variants(): GraphVariant[] {
  return [
    { name: 'default' },
    ...experimentalVariants(),
    ...switchVariants(),
    ...branchVariants()
  ]
}

interface PassMaterials {
  composite: string
  march: string
  shadow: string
  shadowResolve: string
  resolve: string
}

/** Every program the pass owns, as normalized WGSL. Missing stages are '' */
function compilePass(variant: GraphVariant): PassMaterials {
  const pass: CloudsPassNode = clouds({
    sceneDepth: variant.sceneDepth ? texture(new DepthTexture(4, 4)) : null
  })
  const ctx = pass.cloudsContext
  variant.knobs?.(ctx)

  // Builds the whole pass graph: setup() reaches every material
  const dst = texture(new Texture())

  // The march, the resolve and the skylight read the atmosphere through the
  // builder context, as the aerial tests set it up. Every stage below needs it
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({}) as never
  })

  const out: PassMaterials = {
    composite: normalizeWGSL(
      compileWGSL(pass.composite(dst), {
        contextNode,
        features: variant.features ?? []
      }).fragment
    ),
    march: '',
    shadow: '',
    shadowResolve: '',
    resolve: ''
  }

  const anyPass = pass as unknown as {
    material: { fragmentNode: Node | null }
    shadowMaterial: { fragmentNode: Node | null }
    shadowResolveMaterial: { fragmentNode: Node | null }
    resolveMaterial: { fragmentNode: Node | null }
    shadowRT: unknown
  }

  if (anyPass.material.fragmentNode != null) {
    out.march = normalizeWGSL(
      compileWGSL(anyPass.material.fragmentNode, {
        renderTarget: pass.layerRT,
        contextNode,
        features: variant.features ?? []
      }).fragment
    )
  }
  if (anyPass.shadowMaterial.fragmentNode != null) {
    out.shadow = normalizeWGSL(
      compileWGSL(anyPass.shadowMaterial.fragmentNode, {
        renderTarget: anyPass.shadowRT,
        contextNode,
        features: variant.features ?? []
      }).fragment
    )
  }
  if (anyPass.shadowResolveMaterial.fragmentNode != null) {
    out.shadowResolve = normalizeWGSL(
      compileWGSL(anyPass.shadowResolveMaterial.fragmentNode, {
        renderTarget: anyPass.shadowRT,
        contextNode,
        features: variant.features ?? []
      }).fragment
    )
  }
  if (anyPass.resolveMaterial.fragmentNode != null) {
    out.resolve = normalizeWGSL(
      compileWGSL(anyPass.resolveMaterial.fragmentNode, {
        renderTarget: pass.resolveRT,
        contextNode,
        features: variant.features ?? []
      }).fragment
    )
  }
  pass.dispose()
  return out
}

function digestOf(materials: PassMaterials): string {
  return createHash('sha256')
    .update(
      (Object.keys(materials) as Array<keyof PassMaterials>)
        .map(k => `${k} ${materials[k]}`)
        .join('')
    )
    .digest('hex')
    .slice(0, 16)
}

/**
 * The recorded value for a variant that does not build in the stub harness, with
 * the analysis and repro in the pull request. Recorded rather than excluded, so
 * a refactor cannot quietly turn one green.
 *
 * No error text, because it would be order-dependent and flaky: the same skylight
 * variant reports a TypeError compiled first and a TSL struct error afterwards,
 * since the failure poisons the atmosphere node for every later pass.
 */
const BUILD_ERROR = 'build-error'

/**
 * Variants the stub cannot build, and which cause owns each. Derived from the
 * variants rather than listed by name, so a new unbuildable variant cannot slip
 * in beside them and a fixed one cannot pass unnoticed.
 *
 * Every one is a stub artefact, so none of them is a defect to fix here. They
 * read AtmosphereParameters members the compile stub's fresh context has not
 * registered, so a standalone compile fails where a real renderer, which has
 * already built the atmosphere's own program, does not.
 *
 * `debug/uv` and `switch/accurateSunSkyLight` reach them directly. Every
 * variant with `directionalSkylight` on reaches them through the term's two
 * indirect-luminance samples, which the stub cannot type at build time. That
 * used to be 512 rows of the cross product and is 1 alone-on row now, since
 * no listed pair pairs it with anything.
 *
 * The hardware fleet settled all three on 2026-10-03, twice and independently:
 * with the option on, main builds, renders a correct clouds frame and logs no
 * error, and on-vs-off is below the frame-to-frame noise floor at these
 * settings. So the option is invisible there, not broken.
 *
 * An earlier reading of the stub's throw as a real defect was wrong, and a fix
 * built on it shipped a struct the shader could not parse. That was a black
 * canvas, and this file's digests could not see it: they hash WGSL they never
 * validate. compileWGSL now fails that build outright
 */
function expectedBuildErrors(): string[] {
  return [
    'debug/uv',
    'switch/accurateSunSkyLight',
    // directionalSkylight fails through the term's two indirect-luminance
    // samples. Read off the settings, not the name, so a rename cannot drop it
    ...VARIANTS.filter(v =>
      v.experimentalOn?.includes('directionalSkylight')
    ).map(v => v.name)
  ].sort()
}

const VARIANTS = variants()
const RECORDING = process.env.CLOUDS_WGSL_DIGEST_RECORD === '1'

describe("every pass graph variant compiles to main's WGSL", () => {
  // The atmosphere LUT accessors ask the BACKEND for float-linear support and
  // the stub backend has no device, so every march compile reports garbage
  // (aerialShadowAdapter.test.ts does the same)
  let originalHasFeature: () => boolean
  beforeAll(() => {
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    originalHasFeature = backend.hasFeature
    backend.hasFeature = () => false
    // geospatial's STBN node fetches stbn.bin from GitHub, and in Node the
    // stream throws "ProgressEvent is not defined"
    vi.spyOn(STBNLoader.prototype, 'loadAsync').mockResolvedValue(
      new Data3DTexture()
    )
  })
  afterAll(() => {
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    backend.hasFeature = originalHasFeature
  })

  const recorded: Record<string, string> = {}

  // The serial project in vitest.config.ts still runs this file alone, which
  // the 2^N matrix needed and 59 variants no longer do
  it('digests every variant', () => {
    const rows: Array<{ variant: string; digest: string; bytes: number }> = []
    for (const variant of VARIANTS) {
      let value: string
      try {
        const materials = compilePass(variant)
        const present = (
          Object.keys(materials) as Array<keyof PassMaterials>
        ).filter(k => materials[k].length > 0)
        if (present.length === 0) {
          // A variant that compiles to nothing measured nothing
          throw new Error('produced no WGSL at all')
        }
        value = digestOf(materials)
        rows.push({
          variant: variant.name,
          digest: value,
          bytes: materials[present[0]!].length
        })
      } catch (error) {
        const message = String(error)
        rows.push({ variant: variant.name, digest: BUILD_ERROR, bytes: 0 })
        if (message.includes('produced no WGSL')) throw error
        value = BUILD_ERROR
      }
      recorded[variant.name] = value
    }
    log('graph-variant-digests', {
      variants: rows.length,
      programsPerVariant: 5,
      digests: Object.keys(recorded).length
    })

    if (RECORDING) {
      const target = fileURLToPath(
        new URL('./graphVariantDigest.baseline.json', import.meta.url)
      )
      const ordered = Object.fromEntries(
        Object.entries(recorded).sort(([a], [b]) => a.localeCompare(b))
      )
      writeFileSync(target, `${JSON.stringify(ordered, null, 2)}\n`)
      expect(rows.length).toBeGreaterThan(0)
      return
    }

    expect(recorded).toEqual(BASELINE)
  })

  it('every experimental option has an alone-on variant', () => {
    // The reduced matrix trades coverage for cost, so what it must never lose
    // is an option being observable. Derived from the options module, so an
    // option landing without a row fails here
    const alone = new Set(
      VARIANTS.filter(v => v.experimentalOn?.length === 1).map(
        v => v.experimentalOn![0]!
      )
    )
    const uncovered = EXPERIMENTAL_KEYS.filter(k => !alone.has(k))
    log('graph-variant-experimental-coverage', {
      options: EXPERIMENTAL_KEYS.length,
      aloneOn: alone.size,
      pairs: INTERACTING_PAIRS.length,
      uncovered
    })
    expect(
      uncovered,
      `no variant turns these on alone, so the matrix cannot see them: ` +
        `${uncovered.join(', ')}. Add an experimental/only/<key> row`
    ).toEqual([])
  })

  it('every recorded pair is a pair, and none is listed twice', () => {
    // A pair row claims two options interact. A self-paired or duplicated row
    // would record one graph twice and read as coverage that is not there
    for (const [a, b] of INTERACTING_PAIRS) {
      expect(a, `${a} is not an experimental option`).not.toBe(b)
      expect(EXPERIMENTAL_KEYS).toContain(a)
      expect(EXPERIMENTAL_KEYS).toContain(b)
    }
    const names = INTERACTING_PAIRS.map(([a, b]) => `${a}+${b}`)
    expect([...new Set(names)].sort()).toEqual([...names].sort())
    const enumerated = VARIANTS.filter(v =>
      v.name.startsWith('experimental/pair/')
    )
    expect(enumerated.length).toBe(INTERACTING_PAIRS.length)
  })

  it('every graph-time switch varies across the matrix', () => {
    // The assertion a variant-count check cannot make: a switch NO variant sets
    // takes one value everywhere, so it is indistinguishable from a switch that
    // does not exist. graphFlags() declares what is graph-time, so read it
    const observed = new Map<string, Set<string>>()
    const note = (key: string, value: unknown): void => {
      const seen = observed.get(key) ?? new Set<string>()
      seen.add(JSON.stringify(value))
      observed.set(key, seen)
    }
    for (const variant of VARIANTS) {
      // A bare context: graphFlags() is pure bookkeeping, so nothing needs to
      // build and no render target is allocated per variant
      const ctx = new CloudsContext()
      variant.knobs?.(ctx)
      ctx.checkShadowStructure()
      ctx.checkGroundBounce()
      for (const [key, value] of Object.entries(ctx.graphFlags())) {
        note(key, value)
      }
      note('enabled', ctx.enabled)
      note('sceneDepthNull', variant.sceneDepth !== true)
    }

    const flat = [...observed.values()].every(v => v.size > 1)
    const uncovered = [...observed]
      .filter(([, v]) => v.size <= 1)
      .map(([k]) => k)
    log('graph-variant-switch-coverage', {
      switches: observed.size,
      variants: VARIANTS.length,
      uncovered
    })
    expect(
      uncovered,
      `no variant moves these, so the matrix proves nothing about them: ` +
        `${uncovered.join(', ')}. Add a variant that sets each one`
    ).toEqual([])
    expect(flat, 'every switch takes more than one value').toBe(true)
  })

  it('the baseline covers exactly the variants this file enumerates', () => {
    // Catches a switch added to the enumeration without a digest recorded, and
    // a digest left behind for a variant that no longer builds. Otherwise the
    // assertion above could pass over a shrinking set
    const names = VARIANTS.map(v => v.name).sort()
    expect(Object.keys(BASELINE).sort()).toEqual(names)
    for (const name of names) {
      const value = BASELINE[name as keyof typeof BASELINE]
      expect(
        typeof value === 'string' &&
          (value === BUILD_ERROR || /^[0-9a-f]{16}$/.test(value)),
        `${name} recorded as ${JSON.stringify(value)}, expected a 16-hex ` +
          `digest or the ${BUILD_ERROR} sentinel`
      ).toBe(true)
    }
  })

  it('records a build error only for the variants this stub cannot build', () => {
    // A build-error line in the baseline is a claim about the harness, so it has
    // to be one a reader can check: it must name a variant, and the count is
    // pinned so a refactor cannot quietly turn one green, or a green one red
    const failed = Object.entries(BASELINE).filter(([, v]) => v === BUILD_ERROR)
    log('graph-variant-build-errors', {
      failed: failed.map(([k]) => k),
      building: Object.keys(BASELINE).length - failed.length
    })
    expect(failed.map(([k]) => k).sort()).toEqual(expectedBuildErrors())
  })
})
