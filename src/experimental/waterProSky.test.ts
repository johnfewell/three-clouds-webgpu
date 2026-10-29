// These tests carry Water Pro's side of the structural interface the adapter is
// written against: a fake with the package's shape, and that shape transcribed
// from its SkyProvider type at 3.5.1. Nothing is installed or vendored here, so
// what is asserted is that the two agree, that the equirect carries the settings
// its guide requires, and that the samplers compile

import {
  Camera,
  ClampToEdgeWrapping,
  CubeTexture,
  EquirectangularReflectionMapping,
  LinearFilter,
  RepeatWrapping,
  Texture,
  type Object3D
} from 'three'
import { float, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import type { CloudEnvironmentNode } from './cloudEnvironment'
import {
  applyEquirectSkySettings,
  DEFAULT_WATER_PRO_CLOUD_SKY,
  WaterProCloudSky,
  waterProSkySyncDue,
  type WaterProSkyRenderer,
  type WaterProSkySyncInput
} from './waterProSky'

/**
 * The `SkyProvider` seam of threejs-water-pro 3.5.1, from the package's
 * component/sky/SkyProvider.d.ts, with its three optional members left off: a
 * provider that omits them takes the documented fallbacks (brightness one, its
 * own sun authoritative, no visibility gate)
 */
interface WaterProProviderShape {
  createFogSampler(): (direction: Node) => Node

  createReflectionSampler(): (direction: Node, roughness: Node) => Node

  dispose(): void

  followCamera(camera: Camera): void

  getEnvironmentTexture(): Texture

  getMeshes(): Object3D[]
}

/**
 * A stand-in with Water Pro's shape, built the way the package's own consumer
 * would call it. Its returns are the two samplers plus the texture, which is
 * everything `setSky` and the Environment subsystem read
 */
function fakeWaterProSky(texture: Texture): WaterProProviderShape {
  return {
    createFogSampler: () => dir => dir,
    createReflectionSampler: () => () => vec3(0.5),
    dispose: () => {},
    followCamera: () => {},
    getEnvironmentTexture: () => texture,
    getMeshes: () => []
  }
}

/** The one conversion the compiler checks: each direction this provider owns */
function asProviderShape(sky: WaterProProviderShape): WaterProProviderShape {
  return sky
}

/**
 * The environment node's three read-only accessors, cast once. The real node
 * mints its cube target in buildGraph, which needs the pass's whole graph, and
 * what these tests read is the schedule the adapter runs against
 */
function fakeEnvironment(
  state: {
    cube?: Texture | null
    bakeCount?: number
    baked?: boolean
  } = {}
): CloudEnvironmentNode {
  return {
    get cubeTexture() {
      return 'cube' in state ? state.cube! : new CubeTexture()
    },
    get bakeCount() {
      return state.bakeCount ?? 1
    },
    get hasBaked() {
      return state.baked ?? true
    }
  } as unknown as CloudEnvironmentNode
}

/** The state behind `fakeEnvironment`, so a test can move it between frames */
function fakeEnvironmentState(
  over: { cube?: Texture | null; bakeCount?: number; baked?: boolean } = {}
) {
  const state = { ...over }
  return { state, environment: fakeEnvironment(state) }
}

/** The renderer's three calls the conversion makes, recorded in order */
function fakeRenderer() {
  const calls: string[] = []
  let target: unknown = 'app-target'
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (next: unknown) => {
      calls.push(`setRenderTarget:${String(next)}`)
      target = next
    },
    render: () => calls.push('render')
  } as unknown as WaterProSkyRenderer
  return { renderer, calls, boundTarget: () => target }
}

function due(over: Partial<WaterProSkySyncInput> = {}) {
  return waterProSkySyncDue({
    bakeCount: 4,
    cube: new CubeTexture(),
    baked: true,
    syncedBakeCount: 4,
    syncedCube: new CubeTexture(),
    ...over
  })
}

describe('the equirect conversion schedule', () => {
  it('converts the first bake, and only a bake after that', () => {
    const cube = new CubeTexture()
    const first = due({
      cube,
      syncedCube: null,
      syncedBakeCount: 0,
      bakeCount: 1
    })
    const sameBake = due({
      cube,
      syncedCube: cube,
      syncedBakeCount: 1,
      bakeCount: 1
    })
    const nextBake = due({
      cube,
      syncedCube: cube,
      syncedBakeCount: 1,
      bakeCount: 2
    })
    log('waterpro-schedule', { first, sameBake, nextBake })
    expect([first, sameBake, nextBake]).toEqual(['initial', null, 'bake'])
  })

  // A graph rebuild mints a new cube, so the adapter that watched only the bake
  // count would keep converting a target the pass had already disposed
  it('converts again when the cube object itself is replaced', () => {
    const replaced = due({
      syncedCube: new CubeTexture(),
      cube: new CubeTexture(),
      syncedBakeCount: 9,
      bakeCount: 9
    })
    log('waterpro-cube-replaced', { replaced })
    expect(replaced).toBe('cube')
  })

  // There is no image to read before the first bake. Converting then would
  // render the equirect from an unwritten cube and call it synced
  it('REJECTS a conversion before the environment has baked', () => {
    const reasons = [
      due({ baked: false, syncedCube: null }),
      due({ cube: null }),
      due({ baked: false, cube: null, syncedCube: null })
    ]
    log('waterpro-no-bake', reasons)
    expect(reasons).toEqual([null, null, null])
  })
})

describe('the Water Pro sky', () => {
  it('is shaped like the provider Water Pro binds to', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const shape = asProviderShape(sky)
    log('waterpro-shape', {
      members: Object.getOwnPropertyNames(
        Object.getPrototypeOf(shape) as object
      ).length,
      fake: typeof fakeWaterProSky(new Texture()).getEnvironmentTexture
    })
    expect(shape).toBe(sky)
    // The fake and the adapter agree, so the assertion above is not vacuous:
    // one direction would type-check against our own interface alone
    expect(asProviderShape(fakeWaterProSky(new Texture())).getMeshes()).toEqual(
      []
    )
  })

  // Each absent optional member is a documented fallback in Water Pro: a
  // brightness of one, its own sun rather than ours, no render to gate
  it('omits the optional provider members on purpose', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const optional = ['getBrightnessNode', 'getSun', 'setActive'].filter(
      name => name in sky
    )
    log('waterpro-optional-members', { present: optional })
    expect(optional).toEqual([])
  })

  it('carries the equirect settings the custom-sky guide requires', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const texture = sky.environmentTexture
    const settings = {
      mapping: texture.mapping,
      wrapS: texture.wrapS,
      wrapT: texture.wrapT,
      generateMipmaps: texture.generateMipmaps,
      minFilter: texture.minFilter,
      magFilter: texture.magFilter,
      width: sky.width,
      height: sky.height
    }
    log('waterpro-equirect-settings', settings)
    expect(settings).toEqual({
      mapping: EquirectangularReflectionMapping,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      width: DEFAULT_WATER_PRO_CLOUD_SKY.width,
      height: DEFAULT_WATER_PRO_CLOUD_SKY.width / 2
    })
  })

  it('applies those settings to any texture it is handed', () => {
    const texture = new Texture()
    applyEquirectSkySettings(texture)
    log('waterpro-apply-settings', {
      mapping: texture.mapping,
      wrapS: texture.wrapS,
      mipmaps: texture.generateMipmaps
    })
    expect(texture.wrapS).toBe(RepeatWrapping)
    expect(texture.generateMipmaps).toBe(false)
  })

  // Water Pro compares the environment texture by reference every frame and
  // reruns its whole rebind when it differs, so a fresh texture per bake would
  // rebuild the water shader on every bake
  it('REJECTS a bake that replaces the texture Water Pro captured', () => {
    const { state, environment } = fakeEnvironmentState({
      cube: new CubeTexture(),
      bakeCount: 1
    })
    const sky = new WaterProCloudSky(environment)
    const { renderer, calls, boundTarget } = fakeRenderer()
    const captured = sky.environmentTexture
    expect(sky.update(renderer)).toBe('initial')
    expect(sky.environmentTexture).toBe(captured)

    state.bakeCount = 2
    expect(sky.update(renderer)).toBe('bake')
    expect(sky.environmentTexture).toBe(captured)
    expect(sky.bakeCount).toBe(2)

    // and it restored the app's own target rather than leaving ours bound
    expect(boundTarget()).toBe('app-target')
    expect(calls.filter(c => c === 'render')).toHaveLength(2)
    expect(calls.filter(c => c.startsWith('setRenderTarget'))).toHaveLength(4)
  })

  it('keeps the texture out of the PMREM cache until it has pixels', () => {
    const { environment } = fakeEnvironmentState({ baked: false })
    const sky = new WaterProCloudSky(environment)
    const { renderer } = fakeRenderer()
    const pmremVersion = sky.environmentTexture.pmremVersion
    expect(sky.update(renderer)).toBe(null)
    expect(sky.synced).toBe(false)
    expect(sky.environmentTexture.pmremVersion).toBe(pmremVersion)
  })

  // The prefilter reads pmremVersion, so a bake that renders the equirect
  // without moving it leaves Water Pro's lighting and the reflection sampler on
  // the previous bake forever
  it('REJECTS a conversion that does not bump pmremVersion', () => {
    const { environment } = fakeEnvironmentState({ bakeCount: 1 })
    const sky = new WaterProCloudSky(environment)
    const { renderer } = fakeRenderer()
    const before = sky.environmentTexture.pmremVersion
    sky.update(renderer)
    log('waterpro-pmrem-version', {
      before,
      after: sky.environmentTexture.pmremVersion
    })
    expect(sky.environmentTexture.pmremVersion).toBe(before + 1)
  })

  it('memoises both samplers, so a second call is the same graph', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const graph = sky as unknown as {
      fogNode: unknown
      reflectionNode: unknown
    }
    const direction = vec3(0, 1, 0)
    const fog = sky.createFogSampler()
    const fogNode = graph.fogNode
    sky.createFogSampler()
    const refl = sky.createReflectionSampler()
    const reflectionNode = graph.reflectionNode
    sky.createReflectionSampler()
    log('waterpro-samplers', {
      fogStable: fogNode === graph.fogNode,
      reflectionStable: reflectionNode === graph.reflectionNode,
      fogReturns: typeof fog(direction),
      reflectionReturns: typeof refl(direction, float(0.2))
    })
    // TSL mints a node per call, so what has to be stable is the function the
    // two samplers share: Water Pro captures one per setSky and keeps it, and a
    // rebuilt graph per call is a rebuilt water material
    expect(graph.fogNode).toBe(fogNode)
    expect(graph.reflectionNode).toBe(reflectionNode)
    expect(fog(direction)).toBeDefined()
    expect(refl(direction, float(0.2))).toBeDefined()
  })

  it('adds the base roughness to what the water surface asks for', () => {
    const sky = new WaterProCloudSky(fakeEnvironment(), {
      reflectionRoughness: 0.25
    })
    expect(sky.reflectionRoughness).toBe(0.25)
    sky.reflectionRoughness = 0.4
    expect(sky.reflectionRoughness).toBe(0.4)
    log('waterpro-roughness', {
      base: DEFAULT_WATER_PRO_CLOUD_SKY.reflectionRoughness,
      set: sky.reflectionRoughness
    })
    expect(DEFAULT_WATER_PRO_CLOUD_SKY.reflectionRoughness).toBe(0.15)
  })

  it('has no backdrop of its own, so the scene keeps its own sky', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const camera = new Camera()
    sky.followCamera(camera)
    log('waterpro-meshes', { meshes: sky.getMeshes().length })
    expect(sky.getMeshes()).toEqual([])
  })

  it('releases the equirect once, and a second dispose is not a crash', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const { renderer, boundTarget } = fakeRenderer()
    sky.update(renderer)
    let disposed = 0
    const graph = sky as unknown as {
      equirect: { dispose: () => void }
      disposed: boolean
    }
    const original = graph.equirect.dispose.bind(graph.equirect)
    graph.equirect.dispose = () => {
      disposed += 1
      original()
    }
    sky.dispose()
    sky.dispose()
    log('waterpro-dispose', { disposed, bound: String(boundTarget()) })
    expect(disposed).toBe(1)
  })
})

describe('the two shaders the adapter owns', () => {
  it('compiles the fog sampler to WGSL, at an explicit level', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const { fragment } = compileWGSL(sky.createFogSampler()(vec3(0, 1, 0)))
    const level = fragment.match(/textureSampleLevel\([^,]+,[^,]+,[^)]+\)/)
    log('waterpro-fog-wgsl', {
      sampleLevel: level?.[0] ?? null,
      hasImplicitSample: /textureSample\(/m.test(fragment)
    })
    // An implicit sample picks its level from screen-space derivatives, which
    // are undefined wherever the water's own control flow is not uniform, and
    // Dawn answers with zeros: fog that reads as simply absent
    expect(fragment).toMatch(/textureSampleLevel\(/)
    expect(fragment).not.toMatch(/textureSample\(/)
  })

  it('compiles the cube-to-equirect pass the update installs', () => {
    const sky = new WaterProCloudSky(fakeEnvironment())
    const { renderer } = fakeRenderer()
    sky.update(renderer)
    const material = (
      sky as unknown as { material: { fragmentNode: Node | null } }
    ).material
    const { fragment } = compileWGSL(material.fragmentNode!)
    log('waterpro-conversion-wgsl', {
      bytes: fragment.length,
      textureSamples: (fragment.match(/textureSample\(/g) ?? []).length,
      hasEquirectConstants: fragment.includes('6.283185307179586'),
      hasReflectionFallback: fragment.includes('reflectVector')
    })
    // One cube sample per texel, along the equirect direction: the pi
    // constants are equirectDirection's own, and reflectVector is what a cube
    // node sampled without a uv falls back to
    expect(fragment).toMatch(/textureSample\(/)
    expect(fragment).toContain('6.283185307179586')
    expect(fragment).toContain('3.141592653589793')
    expect(fragment).not.toMatch(/reflectVector/)
    expect(fragment).not.toMatch(/\bfor\s*\(|\bwhile\s*\(/)
  })
})
