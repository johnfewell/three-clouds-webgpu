// Two experimental options substitute into the same seam: convectiveProfile
// replaces getLayerDensity in createSampleMedia, and cloudTypeMap blends the
// four packed profile terms before that call

// Both are null-gated, so the combination builds, and until this file nothing
// else built it with both on. The order is morph then law, and this file is
// where that is pinned

// The graph assertion counts which of the morph's per-term deltas reached the
// shader, the CPU twin composes the two in that order and shows the other order
// differs, and the digests prove only the both-on pair moved

// Why that order and not the reverse: the convective law is not a second family,
// it is this one plus a shoulder and a gain on the same sum, so it consumes the
// four terms. The morph's deltas are per term, so none is left to apply after

// Dropping the morph's terms under convection is the third option, and it is
// what the code did: the law read the graph-time terms, so four of the morph's
// eight parameters vanished whenever convection was on

// ONE test builds the pass, on purpose. Building leaves residue a second test in
// this file inherits, and a literal recorded from one order never reproduces
// under another, since three names generated structs from a per-process counter

// The digests below are measured in this order: both, convective only, cloudType
// map only, both off

import { createHash } from 'node:crypto'
import {
  Data3DTexture,
  NearestFilter,
  RGBAFormat,
  Texture,
  UnsignedByteType
} from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { PerspectiveCamera, WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import type { CloudsContext } from '../CloudsContext'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import {
  CLOUD_TYPE_PARAMS,
  cloudTypeAnchors,
  cpuCloudTypeTentWeights,
  createCloudTypeMap,
  type CloudTypeParam
} from './cloudTypeMap'
import { convectiveHeightProfileCPU } from './convectiveProfile'

// sha256 of normalizeWGSL(fragment), one pair per flag state. Both carry the
// stbn rename and core intersection helper, shadow the fused ray projection
const MAIN_CONVECTIVE_ONLY = {
  march: '81028e2b9daa3648806c3f5a41384f3a842690cf829d178718a7b270cdbcc80d',
  shadow: 'ba4797e3f34d8c00a73cd3fd872946f68a7330b1eadf6ec0434d3865a48fc128'
} as const
const MAIN_CLOUD_TYPE_MAP_ONLY = {
  march: '8edf3a05fb3421d98f2d7261c7714fe0d9348d0435d2760a81321f3618eb58b7',
  shadow: '49b5e068bf793f0d03f6968333df8a5e7c8b02c2d5d452cfc0bbf4f7432b84e2'
} as const
const MAIN_BOTH_OFF = {
  march: 'fef872c2f458dd73a99e2d2969439c023cb7184a9ed91f3dc32f2cf6770e34aa',
  shadow: '460bd79155c4e810684c3c86fee3bb6a24303bca328a7c75c8b7702d05d0e51d'
} as const
const BOTH_ON_AFTER_FIX = {
  march: 'ed4e44cbcaeff2f3b5dbfcfbc83837f6f2d6c02cd0e395351439c1ecf1f16ef1',
  shadow: 'eeab9423e1a3e974155934252c70773fdc71679f99417166b78c33f7fb9ce633'
} as const

interface PassInternals {
  material: { fragmentNode: Node | null }
  shadowMaterial: { fragmentNode: Node | null }
  layerRT: unknown
  shadowRT: unknown
}

const internals = (p: CloudsPassNode): PassInternals =>
  p as unknown as PassInternals

// A lane whose expTerm is 0 lets the sampler drop its exp term at graph time, so
// the harness gives every lane one. Otherwise a missing delta name could be that
// drop rather than the composition, which is the whole question
function fullLayerStructure(ctx: CloudsContext): void {
  for (const layer of ctx.cloudLayers) {
    if (layer.height > 0) layer.densityProfile.expTerm = 1
    if (layer.weatherExponent === 1) layer.weatherExponent = 1.5
  }
}

// A local jitter volume, so a compile never reaches for STBNLoader and the
// network. Same shape and filters as parameterUniforms' placeholder
function localJitter(ctx: CloudsContext): void {
  const stbn = new Data3DTexture(new Uint8Array(4), 1, 1, 1)
  stbn.format = RGBAFormat
  stbn.type = UnsignedByteType
  stbn.minFilter = NearestFilter
  stbn.magFilter = NearestFilter
  ctx.stbnTexture = stbn
}

function atmosphereContext(): Node {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  return tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({})
  })
}

export interface FlagDigests {
  march: string
  shadow: string
}

function digest(wgsl: string): string {
  return createHash('sha256').update(normalizeWGSL(wgsl)).digest('hex')
}

/** The march and shadow programs of one pass, in the flag state given */
function compileBothPrograms(opts: {
  convective: boolean
  cloudTypeMap: boolean
}): { digests: FlagDigests; marchWGSL: string } {
  const pass = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  if (opts.cloudTypeMap) {
    ctx.cloudTypes.setMap(createCloudTypeMap({ size: 32, cells: 2 }))
  }
  fullLayerStructure(ctx)
  localJitter(ctx)
  ctx.experimental = {
    convectiveProfile: opts.convective,
    cloudTypeMap: opts.cloudTypeMap
  }
  const contextNode = atmosphereContext()
  // Builds the whole pass graph, which mints both march materials
  compileWGSL(pass.composite(texture(new Texture())), { contextNode })
  const anyPass = internals(pass)
  const marchFragment = anyPass.material.fragmentNode
  const shadowFragment = anyPass.shadowMaterial.fragmentNode
  if (marchFragment == null) throw new Error('the march has no fragment')
  if (shadowFragment == null) throw new Error('the shadow has no fragment')
  const march = compileWGSL(marchFragment, {
    renderTarget: anyPass.layerRT,
    contextNode
  }).fragment
  const shadow = compileWGSL(shadowFragment, {
    renderTarget: anyPass.shadowRT,
    contextNode
  }).fragment
  pass.dispose()
  return {
    digests: { march: digest(march), shadow: digest(shadow) },
    marchWGSL: march
  }
}

// Every blend uniform the compiled march reads, as `param:anchor`. A delta the
// composition drops never enters the graph, so its uniform is never declared
const CLOUD_TYPE_ID = /cloudType_(\w+)_(\w+)\b/g

function deltaNames(wgsl: string): string[] {
  return [
    ...new Set([...wgsl.matchAll(CLOUD_TYPE_ID)].map(m => `${m[1]}:${m[2]}`))
  ].sort()
}

// All eight parameters. The march program carries BOTH density samplers, so
// weather's shapeAlteringBias is in the same WGSL as the media sampler's seven
const EXPECTED_DELTAS = CLOUD_TYPE_PARAMS.flatMap(param =>
  cloudTypeAnchors.map(anchor => `${param}:${anchor.name}`)
).sort()

describe('convectiveProfile and cloudTypeMap together', () => {
  setCurrentSpec('convective-cloudtype-composition')

  // The march reaches the atmosphere LUT builder, which asks the backend for a
  // device feature the compile stub has no device for
  let originalHasFeature: () => boolean
  beforeAll(() => {
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    originalHasFeature = backend.hasFeature
    backend.hasFeature = () => false
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

  it('composes: both programs build, every delta reaches the law, only the both-on pair moves', () => {
    // The order the literals above were measured in. Both on first, because it
    // is the graph whose composition is in question
    const both = compileBothPrograms({ convective: true, cloudTypeMap: true })
    const conv = compileBothPrograms({ convective: true, cloudTypeMap: false })
    const types = compileBothPrograms({ convective: false, cloudTypeMap: true })
    const off = compileBothPrograms({ convective: false, cloudTypeMap: false })

    table('both-flags-digests', [
      {
        field: 'both on, march',
        expected: BOTH_ON_AFTER_FIX.march,
        actual: both.digests.march
      },
      {
        field: 'both on, shadow',
        expected: BOTH_ON_AFTER_FIX.shadow,
        actual: both.digests.shadow
      },
      {
        field: 'convective only, march',
        expected: MAIN_CONVECTIVE_ONLY.march,
        actual: conv.digests.march
      },
      {
        field: 'convective only, shadow',
        expected: MAIN_CONVECTIVE_ONLY.shadow,
        actual: conv.digests.shadow
      },
      {
        field: 'types only, march',
        expected: MAIN_CLOUD_TYPE_MAP_ONLY.march,
        actual: types.digests.march
      },
      {
        field: 'types only, shadow',
        expected: MAIN_CLOUD_TYPE_MAP_ONLY.shadow,
        actual: types.digests.shadow
      },
      {
        field: 'both off, march',
        expected: MAIN_BOTH_OFF.march,
        actual: off.digests.march
      },
      {
        field: 'both off, shadow',
        expected: MAIN_BOTH_OFF.shadow,
        actual: off.digests.shadow
      }
    ])

    const present = deltaNames(both.marchWGSL)
    const missing = EXPECTED_DELTAS.filter(name => !present.includes(name))
    table('both-flags-deltas', [
      {
        field: 'morph alone, present',
        expected: EXPECTED_DELTAS.length,
        actual: deltaNames(types.marchWGSL).length
      },
      {
        field: 'convective alone, present',
        expected: 0,
        actual: deltaNames(conv.marchWGSL).length
      },
      {
        field: 'both on, present',
        expected: EXPECTED_DELTAS.length,
        actual: present.length
      }
    ])
    log('both-flags-programs', {
      bothMarch: both.digests.march.slice(0, 16),
      bothShadow: both.digests.shadow.slice(0, 16)
    })

    // 1. Both programs build. A build that aborted reports no program at all
    expect(both.digests.march.length).toBe(64)
    expect(both.digests.shadow.length).toBe(64)
    // 2. The composition: every per-term delta the morph owns is in the graph
    //    carrying the convective law. Premises first, so a missing name cannot
    //    be the harness: alone the morph has all of them, alone convection none
    expect(deltaNames(types.marchWGSL)).toEqual(EXPECTED_DELTAS)
    expect(deltaNames(conv.marchWGSL)).toEqual([])
    expect(
      missing,
      `the convective law never reads these, so the morph's profile deltas ` +
        `are dropped for every layer: ${missing.join(', ')}`
    ).toEqual([])
    // 3. The combination is its own graph, not either single-flag graph wearing
    //    a flag. Without this, 4 could be satisfied by one graph
    expect(both.digests.march).not.toBe(conv.digests.march)
    expect(both.digests.march).not.toBe(types.digests.march)
    expect(both.digests.shadow).not.toBe(conv.digests.shadow)
    expect(both.digests.shadow).not.toBe(types.digests.shadow)
    // 4. The fix moves the both-on pair and nothing else. A change in a
    //    single-flag pair means one flag leaked into the other flag's graph, or
    //    a shared term moved under a graph meant to be untouched
    expect(both.digests).toEqual(BOTH_ON_AFTER_FIX)
    expect(conv.digests).toEqual(MAIN_CONVECTIVE_ONLY)
    expect(types.digests).toEqual(MAIN_CLOUD_TYPE_MAP_ONLY)
    expect(off.digests).toEqual(MAIN_BOTH_OFF)
  })
})

// The four packed terms, one lane per layer, as the twin consumes them
type Lane4 = [number, number, number, number]

const BASE_TERMS = {
  expTerms: [1, 1, 1, 1] as Lane4,
  exponents: [0.4, 0.5, 0.6, 0.7] as Lane4,
  linearTerms: [0.1, 0.15, 0.2, 0.25] as Lane4,
  constantTerms: [0.05, 0.06, 0.07, 0.08] as Lane4
}
const ANVIL = { center: 0.72, width: 0.18, strength: 1.2 }
const SAMPLE_HEIGHT = 0.62
const PROFILE_PARAMS = [
  'expTerm',
  'exponent',
  'linearTerm',
  'constantTerm'
] as const

const BASE_BY_PARAM = {
  expTerm: BASE_TERMS.expTerms,
  exponent: BASE_TERMS.exponents,
  linearTerm: BASE_TERMS.linearTerms,
  constantTerm: BASE_TERMS.constantTerms
} as const

/** The tent-weighted sum of the three anchors' deltas, per lane */
function blendLane(base: Lane4, morph: number, param: CloudTypeParam): Lane4 {
  const weights = cpuCloudTypeTentWeights(morph)
  const out: Lane4 = [0, 0, 0, 0]
  for (let lane = 0; lane < 4; lane++) {
    let sum = base[lane]!
    cloudTypeAnchors.forEach((anchor, index) => {
      sum += weights[index]! * (anchor.archetype[param]?.[lane] ?? 0)
    })
    out[lane] = sum
  }
  return out
}

function lawOver(
  exp: number,
  exponent: number,
  linear: number,
  constant: number
) {
  return convectiveHeightProfileCPU(
    SAMPLE_HEIGHT,
    exp,
    exponent,
    linear,
    constant,
    ANVIL.center,
    ANVIL.width,
    ANVIL.strength
  )
}

/** The order under test: the morph blends the terms, then the law consumes them */
function composedHeightProfile(morph: number, lane: number): number {
  return lawOver(
    blendLane(BASE_TERMS.expTerms, morph, 'expTerm')[lane]!,
    blendLane(BASE_TERMS.exponents, morph, 'exponent')[lane]!,
    blendLane(BASE_TERMS.linearTerms, morph, 'linearTerm')[lane]!,
    blendLane(BASE_TERMS.constantTerms, morph, 'constantTerm')[lane]!
  )
}

/** The law on the base terms alone, which is what the code did before the fix */
function lawOnBaseTerms(lane: number): number {
  return lawOver(
    BASE_TERMS.expTerms[lane]!,
    BASE_TERMS.exponents[lane]!,
    BASE_TERMS.linearTerms[lane]!,
    BASE_TERMS.constantTerms[lane]!
  )
}

/**
 * The other order, as close as the parameterisation allows: the law runs on the
 * base terms and the morph then scales its output by the mean relative change
 * of the four terms. Not what the shader does, and not equal to it, which is the
 * point of having it here
 */
function morphAfterLaw(morph: number, lane: number): number {
  const base = lawOnBaseTerms(lane)
  let total = 0
  for (const param of PROFILE_PARAMS) {
    const baseLane = BASE_BY_PARAM[param][lane]!
    const blendedLane = blendLane([baseLane, 0, 0, 0], morph, param)[0]
    total += blendedLane / Math.max(Math.abs(baseLane), 1e-6) - 1
  }
  return base * (1 + total / PROFILE_PARAMS.length)
}

describe('the composition order, on the CPU twin', () => {
  setCurrentSpec('convective-cloudtype-order')

  it('is morph then law, and the other order is a different number', () => {
    const lane = 0
    const stratiform = composedHeightProfile(0, lane)
    const cumuliform = composedHeightProfile(1, lane)
    const baseOnly = lawOnBaseTerms(lane)
    table('composition-order', [
      {
        field: 'morph 0, stratiform',
        expected: 'law on blended',
        actual: stratiform
      },
      {
        field: 'morph 1, cumuliform',
        expected: 'law on blended',
        actual: cumuliform
      },
      {
        field: 'law on base terms',
        expected: 'what the code did',
        actual: baseOnly
      },
      {
        field: 'morph after law, morph 1',
        expected: 'the other order',
        actual: morphAfterLaw(1, lane)
      }
    ])

    // 1. The morph has to move the law's answer. Otherwise blending the terms
    //    before the law would be pointless and the graph assertion above would
    //    be counting a dead expression
    expect(cumuliform).not.toBeCloseTo(baseOnly, 6)
    expect(stratiform).not.toBeCloseTo(cumuliform, 6)
    // 2. The order is pinned, not merely "they differ": the reverse does not
    //    reproduce this order at either end of the morph axis. At morph 0 the
    //    tent weights are the middle anchor's, so no arm is the base there
    expect(morphAfterLaw(0, lane)).not.toBeCloseTo(stratiform, 6)
    expect(morphAfterLaw(1, lane)).not.toBeCloseTo(cumuliform, 6)
    // 3. The shoulder still multiplies, so the composed value is strictly above
    //    the four-term sum it came from
    const fourTermSum =
      blendLane(BASE_TERMS.expTerms, 1, 'expTerm')[lane] *
        Math.exp(
          blendLane(BASE_TERMS.exponents, 1, 'exponent')[lane] * SAMPLE_HEIGHT
        ) +
      blendLane(BASE_TERMS.linearTerms, 1, 'linearTerm')[lane] * SAMPLE_HEIGHT +
      blendLane(BASE_TERMS.constantTerms, 1, 'constantTerm')[lane]
    expect(cumuliform).toBeGreaterThan(fourTermSum)
  })

  it('composes for every lane', () => {
    const rows = [0, 1, 2, 3].map(lane => ({
      lane,
      baseOnly: lawOnBaseTerms(lane),
      stratiform: composedHeightProfile(0, lane),
      cumuliform: composedHeightProfile(1, lane)
    }))
    table('composition-lanes', rows)
    for (const row of rows) {
      expect(row.cumuliform, `lane ${row.lane}`).not.toBeCloseTo(
        row.baseOnly,
        6
      )
      expect(row.stratiform, `lane ${row.lane}`).not.toBeCloseTo(
        row.cumuliform,
        6
      )
    }
  })
})
