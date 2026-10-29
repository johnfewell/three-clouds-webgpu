// The point of an opt-in feature is that the graph it is off must be the graph
// that shipped, and a digest of the compiled shader is the only evidence that
// holds. Both halves of the proof, why the primary march rather than a sampler,
// and how the literal was taken: docs/design/cloud-types.md §7

// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Vector3 } from 'three'
import { float, Fn, struct, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'
import { buildLightningExperiment } from '../pass/marchGraph'
import {
  buildLightningDeps,
  createLightningUniforms,
  lightningParamsDefault
} from './lightning'

// Main's primary march under the stub deps below, taken from origin/main at
// c4a7b346. Recompute from main, never from this branch
const MAIN_MARCH_SHA256 =
  '18ec0b78e9f7e4174dc693e707f369d3918bd38eaa358cd6240b01a81d8937b5'

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

const irradianceStruct = struct(
  { direct: 'vec3', indirect: 'vec3' },
  'MockIrradiance'
)

// The stub deps every arm shares, so a difference in a digest is a difference in
// the emitted graph and not in the inputs. Same shape as debugCascadeColor.test.ts
function stubDeps(withLightning: boolean): Record<string, unknown> {
  const deps: Record<string, unknown> = {
    sampleWeather: Fn(() => vec4(0.6, 0.2, 0.1, 0.05)),
    sampleMedia: Fn(() => float(0.4)),
    getCloudsSunSkyIrradiance: Fn(() =>
      irradianceStruct(vec3(1, 1, 1), vec3(0.2, 0.2, 0.3))
    ),
    marchOpticalDepth: Fn(() => vec2(0.7, 1200)),
    approxMultiScatter: Fn(() => vec3(0.5, 0.5, 0.5)),
    bottomRadius: uniform(6360000),
    sunDirection: uniform(vec3(0, 0, 1)),
    minHeight: uniform(750),
    maxHeight: uniform(1400),
    minIntervalHeights: uniform(vec3(0, 0, 0)),
    maxIntervalHeights: uniform(vec3(0, 0, 0)),
    minLayerHeights: uniform(vec4(750, 0, 0, 0)),
    maxLayerHeights: uniform(vec4(1400, 0, 0, 0)),
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
    shadowTopHeight: uniform(3000)
  }

  if (withLightning) {
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    deps.lightningInScatter = buildLightningDeps({
      marchOpticalDepth: Fn(() => vec2(0.7, 1200)),
      cameraPosition: ctx.cameraUniforms.cameraPositionECEF,
      accuratePhaseFunction: ctx.accuratePhaseFunction,
      scatterAnisotropy1: ctx.scatterAnisotropy1,
      scatterAnisotropy2: ctx.scatterAnisotropy2,
      scatterAnisotropyMix: ctx.scatterAnisotropyMix,
      uniforms: createLightningUniforms({
        position: new Vector3(1000, 6361400, 0),
        intensity: 1,
        colour: new Vector3(1, 0.9, 0.8)
      }),
      params: lightningParamsDefault
    }).inScatter
  }

  return deps
}

async function compileMarch(withLightning: boolean): Promise<string> {
  const { createMarchClouds } = await import('../march/primaryMarch')
  const marchClouds = createMarchClouds(stubDeps(withLightning) as never)
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
  return normalizeWGSL(compileWGSL(node).fragment)
}

interface PassInternals {
  lightningUniforms: (ctx: unknown) => unknown
}

describe('lightning is gated on the flag, not on a zero', () => {
  setCurrentSpec('lightning-gate')

  it('the graph builder emits no in-scatter until the option is on', () => {
    // The digests below prove the shader. This proves the gate the real graph
    // reads through, since buildLightningExperiment is what marchGraph calls
    // A zeroed dep instead of an absent one would leave every digest passing
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    const internals = pass as unknown as PassInternals
    const marchOpticalDepth = Fn(() => vec2(0.7, 1200)) as never
    const uniforms = () =>
      internals.lightningUniforms(ctx) as Parameters<
        typeof buildLightningExperiment
      >[2]

    const wasDefault = ctx.experimental.lightning
    const off = buildLightningExperiment(ctx, marchOpticalDepth, uniforms())
    ctx.experimental = { lightning: true }
    const on = buildLightningExperiment(ctx, marchOpticalDepth, uniforms())

    log('lightning seam', {
      defaultOff: wasDefault,
      offKeys: Object.keys(off).length,
      offSeam: off.lightningInScatter === undefined,
      onSeam: typeof on.lightningInScatter
    })

    expect(wasDefault).toBe(false)
    // An empty object, not a zeroed dep: empty is what makes the off graph the
    // graph that shipped
    expect(Object.keys(off)).toEqual([])
    expect(off.lightningInScatter).toBeUndefined()
    expect(typeof on.lightningInScatter).toBe('function')
  })

  it('holds one uniform bag across the toggle, so no captured node is orphaned', () => {
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    const internals = pass as unknown as PassInternals
    const before = internals.lightningUniforms(ctx)
    ctx.experimental = { lightning: true }
    const after = internals.lightningUniforms(ctx)
    log('uniform stability', {
      stable: before === after,
      intensity: (before as { intensity: { value: number } }).intensity.value
    })
    expect(after).toBe(before)
    // Dark at construction, so a pass built with the option on and no flash
    // rendered nothing on its first frame
    expect((before as { intensity: { value: number } }).intensity.value).toBe(0)
  })
})

describe('lightning is byte-identical to main when off', () => {
  setCurrentSpec('lightning-digest')

  it("the primary march without lightning is main's primary march", async () => {
    const digest = sha256(await compileMarch(false))
    log('lightning off, march digest', {
      digest,
      matchesMain: digest === MAIN_MARCH_SHA256
    })
    expect(MAIN_MARCH_SHA256).not.toBe('')
    expect(digest).toBe(MAIN_MARCH_SHA256)
  })

  it('the primary march with lightning emits a different graph', async () => {
    // Without this the test above could be passing because the argument is
    // dropped on the way in, or because the guarded block emits nothing
    const digest = sha256(await compileMarch(true))
    log('lightning on, march digest', {
      digest,
      differsFromMain: digest !== MAIN_MARCH_SHA256
    })
    expect(digest).not.toBe(MAIN_MARCH_SHA256)
  })

  it('adds the flash before the scattering coefficient, so it is scattered', () => {
    // Placement is the difference between lighting a cloud from within and
    // washing the finished layer colour. No digest sees it, the in-scatter
    // being uniform-driven, so the order of two lines is read off the source
    const source = readFileSync(
      resolve(import.meta.dirname, '../march/primaryMarch.ts'),
      'utf8'
    )
    const added =
      source.indexOf('radiance.addAssign(\n      lightningInScatter') > 0
        ? source.indexOf('radiance.addAssign(\n      lightningInScatter')
        : source.indexOf('lightningInScatter(position, mipLevel, jitter)')
    const scattered = source.indexOf('radiance.mulAssign(mediaScattering)')
    const skyLight = source.indexOf(
      'radiance.addAssign(\n        skyIrradiance'
    )

    log('term placement', {
      afterSkyLight: added > skyLight,
      beforeScattering: added < scattered,
      addedAt: added,
      skyLightAt: skyLight,
      scatteredAt: scattered
    })

    // Between the sky light and the medium's scattering coefficient, exactly as
    // the sun and ground terms are. After the multiply it would be added to a
    // radiance already divided by scattering, and would not be powder-darkened
    expect(added).toBeGreaterThan(skyLight)
    expect(added).toBeLessThan(scattered)

    // Exactly once. A second add is invisible to the off digest (which does not
    // contain the term at all) and invisible to the on digest (which only has
    // to differ), so nothing else here would notice a doubled flash
    const shade = source.slice(
      source.indexOf('function createShadeSample'),
      source.indexOf('function createSampleStep')
    )
    const adds = shade.match(
      /lightningInScatter\(position, mipLevel, jitter\)/g
    )
    log('term count in the shade', { adds: adds?.length ?? 0 })
    expect(adds).toHaveLength(1)
  })
})
