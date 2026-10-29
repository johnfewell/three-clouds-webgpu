// the flag has to reach the two density samplers, in the march AND
// in the shadow cascades. These tests go through the real CloudsPassNode,
// because a graph built by hand in a test proves the blend and not the wiring,
// and a wiring regression is the failure that would leave the feature inert
// with every other test still green

import { Data3DTexture, PerspectiveCamera, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { WebGPUBackend, type Node, type NodeMaterial } from 'three/webgpu'
import { describe, expect, test, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import type { CloudsContext } from '../CloudsContext'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import {
  CLOUD_TYPE_PARAMS,
  CLOUD_TYPE_TENT_SCOPES,
  cloudTypeAnchors,
  cloudTypeTentNames,
  createCloudTypeMap
} from './cloudTypeMap'

// The march reads the atmosphere through the builder context, the way the
// aerial and lightShafts tests in CloudsPassNode.test.ts set it up
function atmosphereContext(): Node {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({})
  })
  if (contextNode == null) throw new Error('tslContext returned null')
  return contextNode
}

interface PassInternals {
  material: { fragmentNode: NodeMaterial['fragmentNode'] }
  shadowMaterial: { fragmentNode: Node }
  shadowRT: unknown
}

const internals = (p: CloudsPassNode): PassInternals =>
  p as unknown as PassInternals

// The march fragment reaches the atmosphere's LUT builder, which asks the
// backend for a device feature the stub does not have. Same stub the PCF test
// in CloudsPassNode.test.ts uses
function withoutDevice<T>(run: () => T): T {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  const original = backend.hasFeature
  backend.hasFeature = () => false
  const stbnLoad = vi
    .spyOn(STBNLoader.prototype, 'loadAsync')
    .mockResolvedValue(new Data3DTexture())
  try {
    return run()
  } finally {
    backend.hasFeature = original
    stbnLoad.mockRestore()
  }
}

function buildMarch(enabled: boolean): string {
  return withoutDevice(() => {
    const pass = clouds({ sceneDepth: null })
    const ctx = pass.cloudsContext
    fullLayerStructure(ctx)
    if (enabled) {
      ctx.cloudTypes.setMap(createCloudTypeMap({ size: 32, cells: 2 }))
    }
    ctx.experimental = { cloudTypeMap: enabled }
    // Builds the whole pass graph
    compileWGSL(pass.composite(texture(new Texture())))
    const anyPass = internals(pass)
    const fragmentNode = anyPass.material.fragmentNode
    if (fragmentNode == null) throw new Error('the march has no fragment')
    return compileWGSL(fragmentNode, {
      renderTarget: pass.layerRT,
      contextNode: atmosphereContext()
    }).fragment
  })
}

function buildShadowAtlas(enabled: boolean): string {
  const pass = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  ctx.cloudLayers[0]!.shadow = true
  fullLayerStructure(ctx)
  if (enabled) {
    ctx.cloudTypes.setMap(createCloudTypeMap({ size: 32, cells: 2 }))
  }
  ctx.experimental = { cloudTypeMap: enabled }
  compileWGSL(pass.composite(texture(new Texture())))
  const anyPass = internals(pass)
  return compileWGSL(anyPass.shadowMaterial.fragmentNode, {
    renderTarget: anyPass.shadowRT
  }).fragment
}

const CLOUD_TYPE_ID = /cloudType_(\w+)_(\w+)\b/g

/**
 * Every blend identifier the samplers read, as `param:anchor`. The weather
 * sampler owns one parameter and the media sampler the other seven, so an
 * unwired sampler shows up as missing names
 */
function deltaNames(wgsl: string): string[] {
  return [
    ...new Set([...wgsl.matchAll(CLOUD_TYPE_ID)].map(m => `${m[1]}:${m[2]}`))
  ].sort()
}

// Every modulated parameter at every anchor. A lane's expTerm of 0 lets the
// sampler drop its exp term at graph time, so the harness gives every lane a
// non-zero one
const EXPECTED_DELTAS = CLOUD_TYPE_PARAMS.flatMap(param =>
  cloudTypeAnchors.map(anchor => `${param}:${anchor.name}`)
).sort()

function fullLayerStructure(ctx: CloudsContext): void {
  for (const layer of ctx.cloudLayers) {
    if (layer.height > 0) layer.densityProfile.expTerm = 1
    if (layer.weatherExponent === 1) layer.weatherExponent = 1.5
  }
}

function expectFullBlend(wgsl: string, label: string): void {
  const names = deltaNames(wgsl)
  const missing = EXPECTED_DELTAS.filter(name => !names.includes(name))
  // The tent weights are checked by name, not through deltaNames: they are not
  // param:anchor pairs, and a blend that dropped an anchor would still name
  // every delta it kept
  const tents = CLOUD_TYPE_TENT_SCOPES.flatMap(scope =>
    cloudTypeTentNames(scope)
  )
  const missingTents = tents.filter(name => !wgsl.includes(name))
  log(`cloud-type blend in the ${label}`, [
    { field: 'deltas', expected: EXPECTED_DELTAS.length, actual: names.length },
    {
      field: 'missing deltas',
      expected: 0,
      actual: missing.join(',') || 'none'
    },
    {
      field: 'missing tent weights',
      expected: 0,
      actual: missingTents.join(',') || 'none'
    }
  ])
  expect(missing).toEqual([])
  expect(missingTents).toEqual([])
}

describe('the cloud-type flag reaches the graph', () => {
  setCurrentSpec('cloudTypeMap-wiring')

  test('the march fragment reads the map only with the flag on', () => {
    const off = normalizeWGSL(buildMarch(false))
    const on = normalizeWGSL(buildMarch(true))
    log('cloud-type deltas with the flag off', [
      { field: 'found', expected: 0, actual: deltaNames(off).length }
    ])
    expect(deltaNames(off)).toEqual([])
    expectFullBlend(on, 'march')
    // One map read per sampler per step: the weather and media graphs each
    // sample it, and the blend is inline rather than a WGSL call
    expect(on.match(/textureSampleLevel/g)?.length).toBeGreaterThan(
      off.match(/textureSampleLevel/g)?.length ?? 0
    )
  })

  test('the shadow atlas reads the same map', () => {
    // A cumulus that casts a stratus shadow is worse than no variety at all,
    // and it is the failure a march-only check would miss
    const off = normalizeWGSL(buildShadowAtlas(false))
    const on = normalizeWGSL(buildShadowAtlas(true))
    expect(deltaNames(off)).toEqual([])
    expectFullBlend(on, 'shadow atlas')
  })

  test('the flag enters the program cache key', () => {
    // graphVersion alone only sets needsUpdate, and three can then serve the
    // old program: the flag has to move the hashed flags
    const pass = clouds({ sceneDepth: null })
    const before = pass.customCacheKey()
    const versionBefore = pass.cloudsContext.graphVersion
    pass.cloudsContext.experimental = { cloudTypeMap: true }
    const after = pass.customCacheKey()
    log('graph flags', [
      { field: 'cache key moved', expected: true, actual: before !== after },
      {
        field: 'graphVersion moved',
        expected: true,
        actual: versionBefore !== pass.cloudsContext.graphVersion
      }
    ])
    expect(after).not.toBe(before)
    expect(pass.cloudsContext.graphVersion).not.toBe(versionBefore)
  })

  test('the flag is off by default', () => {
    // A new flag that started true would put the blend into every existing
    // scene, which is exactly what this epic forbids
    const ctx = clouds({ sceneDepth: null }).cloudsContext
    expect(ctx.experimental.cloudTypeMap).toBe(false)
  })
})
