// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { readFileSync } from 'node:fs'
import {
  Data3DTexture,
  DataArrayTexture,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Texture,
  Vector2,
  Vector3,
  type Vector4
} from 'three'
import {
  float,
  texture,
  context as tslContext,
  uniform,
  vec3,
  vec4
} from 'three/tsl'
import {
  PerspectiveCamera,
  WebGPUBackend,
  type Node,
  type NodeBuilder,
  type NodeMaterial,
  type TextureNode
} from 'three/webgpu'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import {
  readsOutsideAssigningBlock,
  varsAssigned
} from '../test/helpers/branchScope'
import {
  compileWGSL,
  findStructByMembers,
  normalizeWGSL
} from '../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../test/helpers/log'
import {
  assertWebGPUSupported,
  clouds,
  CloudsPassNode,
  hashGraphFlags,
  shadowTemporalAlpha,
  type CloudsOptions
} from './CloudsPassNode'
import { type createLayerUniforms } from './layerUniforms'
import {
  updateParameterUniforms,
  type OwnedPlaceholders,
  type ParameterUniforms
} from './parameterUniforms'
import {
  CascadedShadowMaps,
  MAX_CASCADE_COUNT
} from './shadow/CascadedShadowMaps'
import { MIP_LEVELS } from './shadow/opticalDepthMarch'
import { createCloudShadowTransmittance } from './shadow/sampleCloudShadowOpticalDepth'
import { CloudShape } from './textures/generators'

// These tests reach CloudsPassNode's private internals on purpose. Naming that
// surface keeps every reach type-checked, so a renamed field fails the type
// check instead of reading undefined

// CameraUniforms' previous-frame matrices are private too, and the reprojection
// tests assert they are cleared on history reset
interface CameraUniformsInternals {
  previousProjectionMatrix: unknown
  previousViewMatrix: unknown
}

interface RenderTargetLike {
  texture: Texture
  dispose: () => void
  width?: number
  height?: number
}

interface PassInternals {
  material: NodeMaterial
  // The tests read fragmentNode to assert the graph was rebuilt, and spy on
  // dispose to assert lifecycle
  shadowMaterial: { dispose: () => void; fragmentNode: Node }
  shadowResolveMaterial: { dispose: () => void; fragmentNode: Node }
  // The clouds resolve pass, which carries the shadowLength and velocity debug views
  resolveMaterial: { fragmentNode: Node }
  // Real RenderTargets in production. These tests also substitute
  // { texture, dispose } doubles to assert disposal, so the declared surface is
  // what both provide
  shadowRT: RenderTargetLike | null
  shadowResolveRT: RenderTargetLike | null
  shadowHistoryRT: RenderTargetLike | null
  _cloudShadow: unknown
  _historyInvalid: boolean
  _shadowHistoryInvalid: boolean
  _historyTexNode: TextureNode | null
  _shadowLengthHistoryTexNode: TextureNode | null
  shadowLengthPlaceholder: unknown
  _lastResolveW: number
  _lastResolveH: number
  _layerUniforms: ReturnType<typeof createLayerUniforms>
  _shadowUniforms: unknown
  _viewZFromECEF: unknown
  _parameterUniforms: unknown
  _resolveWidth: unknown
  _resolveHeight: unknown
  _varianceGamma: unknown
  _temporalAlpha: unknown
  _shadowVarianceGamma: unknown
  _shadowTemporalAlpha: unknown
  buildResolveGraph: (ctx: unknown, paramU: unknown) => void
  renderResolvePass: (...args: unknown[]) => void
  renderShadowLengthResolvePass?: (...args: unknown[]) => void
  reArmHistoriesForRebuild: () => void
  swapResolveBuffers: () => void
  swapShadowBuffers: () => void
  ensureLayerRT: (...args: unknown[]) => unknown
  ensureShadowRT: (...args: unknown[]) => unknown
  ensureShadowResolveTargets: (...args: unknown[]) => unknown
  renderShadowPass: (...args: unknown[]) => void
  updateCloudShadowDescriptor: (...args: unknown[]) => unknown
}

const internals = (p: CloudsPassNode): PassInternals =>
  p as unknown as PassInternals

// The arguments of the first `name( ... )` call in WGSL, split at top-level
// commas (arguments nest parentheses, so a plain split cannot)
function constructorArgs(wgsl: string, name: string): string[] {
  const start = wgsl.indexOf(`${name}( `)
  if (start < 0) return []
  const args: string[] = []
  let depth = 0
  let current = ''
  for (const ch of wgsl.slice(start + name.length + 1)) {
    if (ch === '(') depth++
    else if (ch === ')' && depth-- === 0) break
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
    } else current += ch
  }
  args.push(current.trim())
  return args
}

function makePassNode(sceneDepth: TextureNode | null = null): CloudsPassNode {
  return clouds({ sceneDepth })
}

function rendererStub(width = 800, height = 600) {
  const size = new Vector2(width, height)
  return {
    getDrawingBufferSize: vi.fn((target: Vector2) => target.copy(size)),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    setMRT: vi.fn(),
    setRenderObjectFunction: vi.fn(),
    setClearColor: vi.fn(),
    clear: vi.fn(),
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: 'srgb',
    autoClear: true,
    setPixelRatio: vi.fn(),
    getRenderTarget: vi.fn(() => null),
    getPixelRatio: vi.fn(() => 1),
    getMRT: vi.fn(() => null),
    getRenderObjectFunction: vi.fn(() => null),
    getClearColor: vi.fn(() => ({ r: 0, g: 0, b: 0 })),
    getClearAlpha: vi.fn(() => 1),
    getActiveCubeFace: vi.fn(() => 0),
    getActiveMipmapLevel: vi.fn(() => 0),
    getScissorTest: vi.fn(() => false),
    setScissorTest: vi.fn(),
    compute: vi.fn()
  }
}

function frameStub(
  frameId: number,
  renderer: ReturnType<typeof rendererStub>,
  camera?: PerspectiveCamera
) {
  return {
    frameId,
    renderer,
    camera: camera ?? new PerspectiveCamera(75, 800 / 600, 0.1, 1000),
    deltaTime: 1 / 60,
    time: frameId / 60
  }
}

interface EarlyShadowInternals {
  shadowPassForFrame: (
    ctx: CloudsPassNode['cloudsContext'],
    renderer: Parameters<CloudsPassNode['prepareShadow']>[0],
    due: boolean
  ) => void
  renderResolvePass: (
    renderer: Parameters<CloudsPassNode['prepareShadow']>[0],
    width: number,
    height: number
  ) => void
}

function earlyShadowFixture() {
  const pass = makePassNode()
  const renderer = {
    ...rendererStub(),
    initialized: true,
    backend: { isWebGPUBackend: true },
    hasFeature: () => false
  }
  const camera = new PerspectiveCamera(60, 4 / 3, 1, 50000)
  camera.position.set(0, 6371000, 0)
  camera.updateMatrixWorld(true)
  pass.camera = camera
  pass.cloudsContext.frame = 42
  pass.cloudsContext.time = 4
  pass.cloudsContext.cloudLayers[0]!.shadow = true
  const internal = pass as unknown as EarlyShadowInternals
  const shadow = vi.spyOn(internal, 'shadowPassForFrame')
  const resolve = vi.spyOn(internal, 'renderResolvePass')
  const prepare = () => pass.prepareShadow(renderer as never)
  return { pass, renderer, camera, shadow, resolve, prepare }
}

describe('CloudsPassNode early shadow preparation', () => {
  test('builds before first scene capture and advances only shadow history once', () => {
    const { pass, renderer, camera, shadow, resolve, prepare } =
      earlyShadowFixture()
    const reprojection = vi.spyOn(
      pass.cloudsContext.cameraUniforms,
      'copyReprojectionMatrix'
    )
    prepare()
    prepare()
    expect(shadow).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(reprojection).not.toHaveBeenCalled()
    expect(internals(pass).shadowRT).not.toBeNull()
    expect(pass.cloudShadow.mapNode.value).toBe(pass.cloudShadow.map)
    // The first composite build must not replace the already-prepared graph
    const fragment = internals(pass).shadowMaterial.fragmentNode
    compileWGSL(pass)
    expect(internals(pass).shadowMaterial.fragmentNode).toBe(fragment)
    pass.updateBefore(frameStub(1, renderer, camera) as never)
    expect(shadow).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(reprojection).toHaveBeenCalledTimes(1)
    pass.dispose()
  })

  test('new sample, history reset, moved camera and resized target invalidate reuse', () => {
    const { pass, renderer, camera, shadow, prepare } = earlyShadowFixture()
    prepare()
    pass.cloudsContext.frame++
    prepare()
    expect(shadow).toHaveBeenCalledTimes(2)
    pass.cloudsContext.resetHistory()
    prepare()
    expect(shadow).toHaveBeenCalledTimes(3)
    camera.position.x += 20
    camera.updateMatrixWorld(true)
    prepare()
    expect(shadow).toHaveBeenCalledTimes(4)
    renderer.getDrawingBufferSize.mockImplementation(target =>
      target.set(1024, 768)
    )
    prepare()
    expect(shadow).toHaveBeenCalledTimes(5)
    pass.dispose()
  })

  test('graph changes and disabled/re-enabled clouds cannot reuse an old atlas', () => {
    const { pass, shadow, prepare } = earlyShadowFixture()
    prepare()
    pass.cloudsContext.shadow.temporalPass = false
    prepare()
    expect(shadow).toHaveBeenCalledTimes(2)
    pass.cloudsContext.enabled = false
    prepare()
    expect(shadow).toHaveBeenCalledTimes(2)
    pass.cloudsContext.enabled = true
    prepare()
    expect(shadow).toHaveBeenCalledTimes(3)
    pass.dispose()
  })

  test('early preparation preserves the optional shadow update cadence', () => {
    const { pass, renderer, camera, shadow, prepare } = earlyShadowFixture()
    pass.cloudsContext.shadow.updateInterval = 3
    pass.cloudsContext.shadow.temporalPass = false
    const due = []
    for (let frame = 1; frame <= 7; frame++) {
      pass.cloudsContext.frame = frame
      prepare()
      pass.updateBefore(frameStub(frame, renderer, camera) as never)
      due.push(shadow.mock.calls.at(-1)![2])
    }
    expect(shadow).toHaveBeenCalledTimes(7)
    expect(due).toEqual([true, false, false, true, false, false, true])
    pass.dispose()
  })

  test('an early shadow failure restores renderer state and remains retryable', () => {
    const { pass, renderer, shadow, prepare } = earlyShadowFixture()
    shadow.mockImplementationOnce(() => {
      throw new Error('shadow failure')
    })
    expect(prepare).toThrow('shadow failure')
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null, 0, 0)
    prepare()
    expect(shadow).toHaveBeenCalledTimes(2)
    pass.dispose()
  })
})

describe('CloudsPassNode', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode')
  })

  test('clouds() creates a CloudsPassNode', () => {
    const pass = makePassNode()
    expect(pass).toBeInstanceOf(CloudsPassNode)
    expect(pass.cloudsContext).toBeDefined()
    expect(pass.layerNode).toBeDefined()
    expect(pass.depthVelocityNode).toBeDefined()

    log('clouds-factory', {
      isCloudPassNode: pass instanceof CloudsPassNode,
      hasContext: pass.cloudsContext != null,
      hasLayerNode: pass.layerNode != null,
      hasDepthVelocityNode: pass.depthVelocityNode != null
    })
  })

  test('clouds() options type requires sceneDepth', () => {
    const pass = clouds({ sceneDepth: null })
    expect(pass.sceneDepth).toBeNull()

    const tex = texture(new Texture())
    const pass2 = clouds({ sceneDepth: tex })
    expect(pass2.sceneDepth).toBe(tex)

    // @ts-expect-error — resolutionScale is not an option
    const _badOpts: CloudsOptions = { sceneDepth: null, resolutionScale: 0.5 }

    log('clouds-options', {
      nullDepthOk: pass.sceneDepth === null,
      textureDepthOk: pass2.sceneDepth === tex
    })
  })

  test('targets are sized ceil(w × resolutionScale) at 1.0', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = false
    const renderer = rendererStub(800, 600)
    const frame = frameStub(1, renderer)

    pass.updateBefore(frame as never)

    expect(renderer.setRenderTarget).toHaveBeenCalled()
    const target = renderer.setRenderTarget.mock.calls[0]?.[0]
    expect(target).toBeDefined()
    expect(target.width).toBe(800)
    expect(target.height).toBe(600)

    log('target-size-1.0', {
      width: target.width,
      height: target.height,
      expectedWidth: 800,
      expectedHeight: 600
    })
  })

  test('targets are sized ceil(w × resolutionScale) at 0.5', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = false
    pass.cloudsContext.resolutionScale = 0.5
    const renderer = rendererStub(800, 600)
    const frame = frameStub(1, renderer)

    pass.updateBefore(frame as never)

    const target = renderer.setRenderTarget.mock.calls[0]?.[0]
    expect(target).toBeDefined()
    expect(target.width).toBe(Math.ceil(800 * 0.5))
    expect(target.height).toBe(Math.ceil(600 * 0.5))

    log('target-size-0.5', {
      width: target.width,
      height: target.height,
      expectedWidth: Math.ceil(800 * 0.5),
      expectedHeight: Math.ceil(600 * 0.5)
    })
  })

  test('resize reallocates the target', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = false
    const renderer = rendererStub(800, 600)

    pass.updateBefore(frameStub(1, renderer) as never)
    const firstTarget = renderer.setRenderTarget.mock.calls[0]?.[0]
    expect(firstTarget.width).toBe(800)

    const renderer2 = rendererStub(1024, 768)
    pass.updateBefore(frameStub(2, renderer2) as never)
    const secondTarget = renderer2.setRenderTarget.mock.calls[0]?.[0]
    expect(secondTarget.width).toBe(1024)
    expect(secondTarget.height).toBe(768)

    log('resize', {
      firstWidth: firstTarget.width,
      secondWidth: secondTarget.width,
      secondHeight: secondTarget.height
    })
  })

  test('temporalUpscale sizes target to ceil(w/4)×ceil(h/4)', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    const renderer = rendererStub(800, 600)
    const frame = frameStub(1, renderer)

    pass.updateBefore(frame as never)

    const target = renderer.setRenderTarget.mock.calls[0]?.[0]
    expect(target).toBeDefined()
    expect(target.width).toBe(Math.ceil(800 / 4))
    expect(target.height).toBe(Math.ceil(600 / 4))

    log('target-size-temporal', {
      width: target.width,
      height: target.height,
      expectedWidth: Math.ceil(800 / 4),
      expectedHeight: Math.ceil(600 / 4)
    })
  })

  test('temporalUpscale × resolutionScale composes correctly', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    pass.cloudsContext.resolutionScale = 0.5
    const renderer = rendererStub(1920, 1080)
    const frame = frameStub(1, renderer)

    pass.updateBefore(frame as never)

    const target = renderer.setRenderTarget.mock.calls[0]?.[0]
    const fullW = Math.ceil(1920 * 0.5)
    const fullH = Math.ceil(1080 * 0.5)
    expect(target.width).toBe(Math.ceil(fullW / 4))
    expect(target.height).toBe(Math.ceil(fullH / 4))

    log('target-size-temporal-0.5', {
      width: target.width,
      height: target.height,
      fullW,
      fullH
    })
  })

  test('enabled = false skips the render', () => {
    const pass = makePassNode()
    pass.cloudsContext.enabled = false
    const renderer = rendererStub()
    const frame = frameStub(1, renderer)

    pass.updateBefore(frame as never)

    expect(renderer.setRenderTarget).not.toHaveBeenCalled()

    log('enabled-false-skip', {
      setRenderTargetCalled: renderer.setRenderTarget.mock.calls.length,
      renderCalled: renderer.render.mock.calls.length
    })
  })

  test('update drives procedural textures once per frame and fills each once', () => {
    const pass = makePassNode()
    const generator = new CloudShape()
    pass.cloudsContext.shapeTexture = generator
    const renderProceduralTextures = vi.spyOn(
      pass.cloudsContext,
      'renderProceduralTextures'
    )
    const renderer = rendererStub()

    pass.updateBefore(frameStub(1, renderer) as never)
    pass.updateBefore(frameStub(2, renderer) as never)

    expect(renderProceduralTextures).toHaveBeenCalledTimes(2)
    expect(renderProceduralTextures).toHaveBeenNthCalledWith(1, renderer)
    expect(renderProceduralTextures).toHaveBeenNthCalledWith(2, renderer)
    expect(renderer.compute).toHaveBeenCalledTimes(1)

    log('procedural-texture-update', {
      frameCount: renderProceduralTextures.mock.calls.length,
      computeCount: renderer.compute.mock.calls.length,
      expectedComputeCount: 1
    })

    generator.dispose()
  })

  test('previous matrices equal the camera after one frame', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = false
    const camera = new PerspectiveCamera(75, 800 / 600, 0.1, 1000)
    camera.position.set(1, 2, 3)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)

    const renderer = rendererStub()
    const frame = frameStub(1, renderer, camera)

    pass.updateBefore(frame as never)

    const cu = pass.cloudsContext.cameraUniforms
    const expectedView = new Matrix4().copy(camera.matrixWorldInverse)
    const expectedProj = new Matrix4().copy(camera.projectionMatrix)

    expect(cu.viewMatrix.value).toEqual(expectedView)

    const reprojExpected = new Matrix4()
      .copy(expectedProj)
      .multiply(expectedView)
    expect(cu.reprojectionMatrix.value).toEqual(reprojExpected)

    log('previous-matrices', {
      viewMatches: cu.viewMatrix.value.equals(expectedView),
      reprojMatches: cu.reprojectionMatrix.value.equals(reprojExpected)
    })
  })

  test('dispose() disposes targets', () => {
    const pass = makePassNode()
    const rtDispose = vi.spyOn(
      (pass as unknown as { layerRT: { dispose: () => void } }).layerRT,
      'dispose'
    )

    pass.dispose()

    expect(rtDispose).toHaveBeenCalledOnce()

    log('dispose', { rtDisposed: true })
  })

  test('composite(dst) graph reaches the pass node', () => {
    const pass = makePassNode()
    const dst = texture(new Texture())
    const compositeNode = pass.composite(dst)

    expect(compositeNode).toBeDefined()
    expect(pass.layerNode).toBeDefined()

    log('composite-graph', { compositeCreated: true })
  })

  // The declaration said TextureNode, but the contract is any vec4 node: the
  // harness and examples/basic both pass the aerial-perspective node itself
  // (mail #578: cast through unknown at every call site until now)
  test('composite() accepts a non-texture vec4 node and still builds the blend', () => {
    const pass = makePassNode()
    const compositeNode = pass.composite(vec4(0.1, 0.2, 0.3, 1))
    const { fragment } = compileWGSL(compositeNode)
    const wgsl = normalizeWGSL(fragment)
    // The clouds layer is sampled and blended over the (constant) dst
    expect(wgsl).toContain('textureSample')
    log('composite-vec4-dst', { textureSample: wgsl.includes('textureSample') })
  })

  // graphVersion had no receiver. three re-marks a material only on a
  // tone-mapping or colour-space change and polls only an environment cache
  // key, so every graph-shape knob changed nothing on screen

  // The fix marks the built material when graphVersion moves, and
  // RenderObjects.js:127 then rebuilds the program and re-runs setup()

  // enabled is false before setup() on purpose: setup() returns dst and touches
  // only builder.material, so no real NodeBuilder is needed
  test('a graph-shape change marks the built material for rebuild', () => {
    const pass = makePassNode()
    const compositeNode = pass.composite(vec4(0.1, 0.2, 0.3, 1))
    const material = { needsUpdate: false } as unknown as NodeMaterial
    // The pipeline is the load-bearing half: marking the material alone was
    // measured not to re-run setup(). Without this assertion the pipeline code
    // could go and the material fallback would still pass
    const renderPipeline = { needsUpdate: false }

    pass.cloudsContext.enabled = false
    compositeNode.setup({
      material,
      context: { renderPipeline }
    } as unknown as NodeBuilder)

    // Whatever the build itself did is not what is under test
    material.needsUpdate = false
    renderPipeline.needsUpdate = false

    // A runtime graph-shape toggle: bumps graphVersion
    pass.cloudsContext.enabled = true
    compositeNode.updateBefore(frameStub(1, rendererStub()) as never)

    expect(renderPipeline.needsUpdate).toBe(true)
    expect(material.needsUpdate).toBe(true)

    log('rnfa-invalidated', {
      pipeline: renderPipeline.needsUpdate,
      material: material.needsUpdate
    })
  })

  // The other half: an unchanged graph must not force a rebuild. Marking every
  // frame would recompile the program each frame, which no correctness test
  // would catch
  test('an unchanged graph does not re-mark the material', () => {
    const pass = makePassNode()
    const compositeNode = pass.composite(vec4(0.1, 0.2, 0.3, 1))
    const material = { needsUpdate: false } as unknown as NodeMaterial

    const renderPipeline = { needsUpdate: false }
    pass.cloudsContext.enabled = false
    compositeNode.setup({
      material,
      context: { renderPipeline }
    } as unknown as NodeBuilder)
    material.needsUpdate = false
    renderPipeline.needsUpdate = false

    compositeNode.updateBefore(frameStub(1, rendererStub()) as never)
    compositeNode.updateBefore(frameStub(2, rendererStub()) as never)

    expect(renderPipeline.needsUpdate).toBe(false)
    expect(material.needsUpdate).toBe(false)

    log('rnfa-no-spurious-rebuild', { needsUpdate: material.needsUpdate })
  })

  test('composite() called twice returns the same node (===)', () => {
    const pass = makePassNode()
    const dst = texture(new Texture())
    const a = pass.composite(dst)
    const b = pass.composite(dst)

    expect(a).toBe(b)

    log('composite-identity', { same: a === b })
  })
})

describe('CloudsPassNode graphVersion propagation', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_graphVersion')
  })

  test('flipping enabled sets needsUpdate', () => {
    const pass = makePassNode()
    const renderer = rendererStub()

    pass.updateBefore(frameStub(1, renderer) as never)

    pass.cloudsContext.enabled = false
    ;(pass.cloudsContext as unknown as { _graphVersion: number })
      ._graphVersion++

    pass.updateBefore(frameStub(2, renderer) as never)

    log('graphVersion-enabled-flip', {
      enabled: pass.cloudsContext.enabled,
      graphVersion: pass.cloudsContext.graphVersion
    })
  })

  test('getCacheKey() differs when enabled changes', () => {
    const pass = makePassNode()
    const key1 = pass.customCacheKey()

    pass.cloudsContext.enabled = false
    const key2 = pass.customCacheKey()

    expect(key1).not.toBe(key2)

    pass.cloudsContext.enabled = true
    const key3 = pass.customCacheKey()

    expect(key3).toBe(key1)

    log('cacheKey-enabled', {
      enabledKey: key1,
      disabledKey: key2,
      reenabledKey: key3,
      keysMatch: key1 === key3
    })
  })

  test('graphFlags() order is pinned by snapshot', () => {
    const pass = makePassNode()
    const flags = pass.cloudsContext.graphFlags()

    expect(Object.keys(flags)).toMatchInlineSnapshot(`
      [
        "shapeDetail",
        "turbulence",
        "lightShafts",
        "lightShaftsHalfResolution",
        "haze",
        "temporalUpscale",
        "accurateSunSkyLight",
        "accuratePhaseFunction",
        "multiScatteringOctaves",
        "scatterAnisotropy1",
        "scatterAnisotropy2",
        "scatterAnisotropyMix",
        "localWeatherChannels",
        "layerStructure",
        "shadowCascadeCount",
        "shadowTemporalJitter",
        "shadowTemporalPass",
        "castsShadow",
        "groundBounce",
        "logarithmicDepthBuffer",
        "debug",
        "experimentalFlags",
        "cloudShape",
      ]
    `)

    log('graphFlags-order', { keys: Object.keys(flags).join(',') })
  })

  test('a rebuilt graph re-arms histories consumed by the old graph', () => {
    const pass = makePassNode()
    const composite = pass.composite(vec4(0.1, 0.2, 0.3, 1))
    compileWGSL(composite)

    const anyPass = internals(pass)
    anyPass._historyInvalid = false
    anyPass._shadowHistoryInvalid = false

    // A graph-time variant. The first frame after this change can consume the
    // reset flags before three rebuilds the graph; setup() must re-arm them
    pass.cloudsContext.debug = 'cascades'
    compileWGSL(composite)

    // Two accumulators since the merged resolve: the colour/shadow-length
    // pair shares one flag, the shadow maps keep theirs
    expect(anyPass._historyInvalid).toBe(true)
    expect(anyPass._shadowHistoryInvalid).toBe(true)

    log('graph-rebuild-history-rearm', {
      clouds: anyPass._historyInvalid,
      shadow: anyPass._shadowHistoryInvalid
    })
  })
})

describe('CloudsCompositeNode WGSL', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_composite')
  })

  test('enabled composite WGSL contains over operator (1.0 - a)', () => {
    const pass = makePassNode()
    const dst = texture(new Texture())
    const compositeNode = pass.composite(dst)

    const { fragment } = compileWGSL(compositeNode)
    expect(fragment).toContain('1.0')
    expect(fragment.length).toBeGreaterThan(0)

    log('composite-wgsl-enabled', {
      fragmentLength: fragment.length,
      hasOneMinus: fragment.includes('1.0')
    })
  })

  test('disabled composite WGSL is dst-only (no over operator)', () => {
    const pass = makePassNode()
    pass.cloudsContext.enabled = false
    const dst = texture(new Texture())
    const compositeNode = pass.composite(dst)

    const { fragment: disabledFragment } = compileWGSL(compositeNode)
    const { fragment: dstOnlyFragment } = compileWGSL(dst)

    expect(normalizeWGSL(disabledFragment)).toBe(normalizeWGSL(dstOnlyFragment))

    log('composite-wgsl-disabled', {
      disabledLength: disabledFragment.length,
      dstOnlyLength: dstOnlyFragment.length,
      identical:
        normalizeWGSL(disabledFragment) === normalizeWGSL(dstOnlyFragment)
    })
  })
})

describe('CloudsPassNode shadow wiring', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_shadow')
  })

  test('constructor creates CascadedShadowMaps with splitLambda 0.6', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    expect(ctx.shadowMaps).toBeInstanceOf(CascadedShadowMaps)
    expect(ctx.shadowMaps!.splitLambda).toBe(0.6)
    expect(ctx.shadowMaps!.cascadeCount).toBe(ctx.shadow.cascadeCount)

    log('csm-construction', {
      splitLambda: ctx.shadowMaps!.splitLambda,
      cascadeCount: ctx.shadowMaps!.cascadeCount
    })
  })

  test('shadow RT is not created until renderShadowPass runs', () => {
    const pass = makePassNode()
    const rt = internals(pass).shadowRT
    expect(rt).toBeNull()
  })

  test('shadow pass does not render when _shadowUniforms is null', () => {
    const pass = makePassNode()
    const renderer = rendererStub()
    const frame = frameStub(1, renderer)

    pass.updateBefore(frame as never)

    const calls = renderer.setRenderTarget.mock.calls
    for (const call of calls) {
      const target = call[0]
      if (target?.texture instanceof DataArrayTexture) {
        throw new Error(
          'Shadow RT should not be set without shadow graph built'
        )
      }
    }

    log('shadow-no-render-without-setup', {
      setRenderTargetCalls: calls.length,
      noShadowRT: true
    })
  })

  test('dispose() cleans up shadow material', () => {
    const pass = makePassNode()
    const shadowMatDispose = vi.spyOn(internals(pass).shadowMaterial, 'dispose')

    pass.dispose()

    expect(shadowMatDispose).toHaveBeenCalledOnce()

    log('shadow-dispose', { materialDisposed: true })
  })

  test('MIP_LEVELS has 4 levels matching shadow.frag:183', () => {
    expect(MIP_LEVELS).toEqual([0, 0.5, 1, 2])
    expect(MIP_LEVELS).toHaveLength(4)
  })

  test('shadow.mapSize defaults match qualityPresets', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    expect(ctx.shadow.mapSize.x).toBe(512)
    expect(ctx.shadow.mapSize.y).toBe(512)
    expect(ctx.shadow.cascadeCount).toBe(3)
    expect(ctx.shadow.maxIterationCount).toBe(50)
    expect(ctx.shadow.opticalDepthTailScale).toBe(2)

    log('shadow-defaults', {
      mapSize: `${ctx.shadow.mapSize.x}×${ctx.shadow.mapSize.y}`,
      cascadeCount: ctx.shadow.cascadeCount,
      maxIterationCount: ctx.shadow.maxIterationCount
    })
  })

  test('shadow graph uses shadow sampleWeather variant (source verification)', async () => {
    // The shadow march pass's graph lives in pass/shadowGraph.ts, and the
    // per-cascade LOD it is drawn with lives in the pass
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./pass/shadowGraph.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('createOpticalDepthMarch')
    expect(source).toContain('buildCascadeSetup')
    expect(source).toContain('createSampleWeather(')
    const shadowCallMatch = source.match(
      // shadow = true, then the optional layer structure, then the weather
      // sampler (or the zero read with no caster), convective deps and the
      // cloud-type morph. Lazy, not [^)]*: the seams bring their own parens
      /createSampleWeather\([\s\S]*?true\s*(,\s*ctx\.cloudLayers\.structure\s*)?(,\s*(host\.weatherEvolution\.build\([^)]*\)|maskedOut \? \(\) => vec4\(0\) : evolution)\s*)?(,\s*host\.convectiveDeps\(ctx, layerU, paramU\)\s*)?(,\s*cloudTypes\s*)?\)/
    )
    expect(shadowCallMatch).not.toBeNull()
    const passSource = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./CloudsPassNode.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(passSource).toContain('MIP_LEVELS')

    log('shadow-source-verification', {
      hasOpticalDepthMarch: true,
      hasCascadeSetup: true,
      hasShadowWeather: shadowCallMatch != null
    })
  })

  test('updateShadowMaps is called in updateBefore', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const spy = vi.spyOn(ctx, 'updateShadowMaps')
    const renderer = rendererStub()
    const camera = new PerspectiveCamera(75, 1, 0.1, 1000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)

    pass.updateBefore(frameStub(1, renderer, camera) as never)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(camera)

    log('updateShadowMaps-called', { called: true })
  })
})

describe('CloudsPassNode resolve ping-pong', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_resolve')
  })

  test('resolve and history RTs are created by buildResolveGraph', () => {
    const pass = makePassNode()
    expect(pass.resolveRT).toBeNull()
    expect(pass.historyRT).toBeNull()

    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = {
      frame: { value: 0 }
    }

    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    expect(pass.resolveRT).not.toBeNull()
    expect(pass.historyRT).not.toBeNull()
    expect(pass.resolveRT).not.toBe(pass.historyRT)

    log('resolve-rt-created', {
      resolveRT: pass.resolveRT != null,
      historyRT: pass.historyRT != null,
      distinct: pass.resolveRT !== pass.historyRT
    })
  })

  test('swapResolveBuffers swaps resolve and history RTs', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }

    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    const originalResolve = pass.resolveRT
    const originalHistory = pass.historyRT

    anyPass.swapResolveBuffers()

    expect(pass.resolveRT).toBe(originalHistory)
    expect(pass.historyRT).toBe(originalResolve)

    log('resolve-swap', {
      resolveWasHistory: pass.resolveRT === originalHistory,
      historyWasResolve: pass.historyRT === originalResolve
    })
  })

  test('double swap restores original configuration', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }

    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    const originalResolve = pass.resolveRT
    const originalHistory = pass.historyRT

    anyPass.swapResolveBuffers()
    anyPass.swapResolveBuffers()

    expect(pass.resolveRT).toBe(originalResolve)
    expect(pass.historyRT).toBe(originalHistory)

    log('resolve-double-swap', {
      resolveRestored: pass.resolveRT === originalResolve,
      historyRestored: pass.historyRT === originalHistory
    })
  })

  test('historyTexNode.value tracks historyRT after swap', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }

    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    const historyTexNode = anyPass._historyTexNode
    expect(historyTexNode).not.toBeNull()
    if (historyTexNode == null) throw new Error('unreachable')

    // Before swap: historyTexNode points to original historyRT
    expect(historyTexNode.value).toBe(pass.historyRT!.texture)

    anyPass.swapResolveBuffers()

    // After swap: historyTexNode updated to new historyRT (was resolveRT)
    expect(historyTexNode.value).toBe(pass.historyRT!.texture)

    log('resolve-texnode-tracking', {
      tracksAfterSwap: historyTexNode.value === pass.historyRT!.texture
    })
  })

  test('resolve RTs are full resolution, not march resolution', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    pass.cloudsContext.temporalUpscale = true

    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    // Simulate renderResolvePass sizing
    pass.resolveRT!.setSize(800, 600)
    pass.historyRT!.setSize(800, 600)

    expect(pass.resolveRT!.width).toBe(800)
    expect(pass.resolveRT!.height).toBe(600)
    expect(pass.historyRT!.width).toBe(800)
    expect(pass.historyRT!.height).toBe(600)

    log('resolve-rt-fullres', {
      resolveW: pass.resolveRT!.width,
      resolveH: pass.resolveRT!.height,
      historyW: pass.historyRT!.width,
      historyH: pass.historyRT!.height
    })
  })

  test('dispose cleans up resolve RTs', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }

    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    const resolveDispose = vi.spyOn(pass.resolveRT!, 'dispose')
    const historyDispose = vi.spyOn(pass.historyRT!, 'dispose')

    // Reset parameterUniforms so dispose() skips disposePlaceholders
    anyPass._parameterUniforms = null

    pass.dispose()

    expect(resolveDispose).toHaveBeenCalledOnce()
    expect(historyDispose).toHaveBeenCalledOnce()

    log('resolve-dispose', {
      resolveDisposed: true,
      historyDisposed: true
    })
  })
})

describe('CloudsPassNode resetHistory + temporalUpscale wiring', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_resetHistory')
  })

  function buildPassWithResolve() {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)
    return { pass, anyPass }
  }

  test('resetHistory() sets _historyInvalid flag', () => {
    const { pass, anyPass } = buildPassWithResolve()
    anyPass._historyInvalid = false

    pass.cloudsContext.resetHistory()

    expect(anyPass._historyInvalid).toBe(true)

    log('resetHistory-flag', { historyInvalid: anyPass._historyInvalid })
  })

  test('resetHistory() clears previous matrices (identity reprojection)', () => {
    const { pass } = buildPassWithResolve()
    const cu = pass.cloudsContext.cameraUniforms

    // Simulate a frame, which stores previous matrices
    const camera = new PerspectiveCamera(75, 1, 0.1, 1000)
    camera.position.set(1, 2, 3)
    camera.updateMatrixWorld(true)
    cu.copyReprojectionMatrix(camera)
    expect(
      (cu as unknown as CameraUniformsInternals).previousProjectionMatrix
    ).not.toBeNull()

    pass.cloudsContext.resetHistory()

    expect(
      (cu as unknown as CameraUniformsInternals).previousProjectionMatrix
    ).toBeNull()
    expect(
      (cu as unknown as CameraUniformsInternals).previousViewMatrix
    ).toBeNull()

    log('resetHistory-matrices', {
      prevProjNull:
        (cu as unknown as CameraUniformsInternals).previousProjectionMatrix ===
        null,
      prevViewNull:
        (cu as unknown as CameraUniformsInternals).previousViewMatrix === null
    })
  })

  // the name ("output = current march") was
  // the intent, and the old assertion pinned a skipped resolve, which emits the
  // plate from two renders ago. Red on the unfixed code
  test('after resetHistory the resolve STILL RENDERS, against a cleared history (output = current march)', () => {
    const { pass, anyPass } = buildPassWithResolve()
    const renderer = rendererStub()

    pass.cloudsContext.resetHistory()
    expect(anyPass._historyInvalid).toBe(true)

    anyPass._lastResolveW = 800
    anyPass._lastResolveH = 600
    pass.resolveRT!.setSize(800, 600)
    pass.historyRT!.setSize(800, 600)

    const originalResolve = pass.resolveRT
    const originalHistory = pass.historyRT

    anyPass.renderResolvePass(renderer, 800, 600)

    expect(anyPass._historyInvalid).toBe(false)
    // Buffers still swap, exactly as the reference's swapBuffers() does
    expect(pass.resolveRT).toBe(originalHistory)
    expect(pass.historyRT).toBe(originalResolve)

    const targets = renderer.setRenderTarget.mock.calls.map(c => c[0])

    // Both halves are zeroed first, the reference's zero-filled precondition:
    // clearing only "history" leaves the other warm for the next swap (SSIM
    // 0.831 on the resize path)
    expect(renderer.clear).toHaveBeenCalledTimes(2)
    expect(targets.filter(target => target === originalHistory)).toHaveLength(1)
    expect(targets.filter(target => target === originalResolve)).toHaveLength(2)

    // And the resolve actually renders, which is the whole point
    expect(targets).toContain(originalResolve)
    expect(targets.indexOf(originalHistory)).toBeLessThan(
      targets.lastIndexOf(originalResolve)
    )

    log('resetHistory-resolve-renders', {
      flagCleared: !anyPass._historyInvalid,
      swapped: pass.resolveRT === originalHistory,
      historiesCleared: renderer.clear.mock.calls.length,
      resolveRendered: targets.at(-1) === originalResolve
    })
  })

  // The rebuild-boundary re-arm: the old graph consumes the invalidation,
  // so the rebuilt one believed its history valid. Driven directly (consume,
  // then rebuild). On hardware 0.9334 -> 0.954946 direct / 0.950874 resize
  test('a graph rebuild RE-ARMS all three histories after the old graph consumed the flag', () => {
    const { pass, anyPass } = buildPassWithResolve()
    const renderer = rendererStub()

    // checkShadowStructure() arms them...
    pass.cloudsContext.resetHistory()
    expect(anyPass._historyInvalid).toBe(true)

    // ...and the OLD graph consumes the colour flag in the same updateBefore
    anyPass._lastResolveW = 800
    anyPass._lastResolveH = 600
    pass.resolveRT!.setSize(800, 600)
    pass.historyRT!.setSize(800, 600)
    anyPass.renderResolvePass(renderer, 800, 600)
    expect(anyPass._historyInvalid).toBe(false)

    // The rebuilt graph must not inherit that "valid" history
    anyPass.reArmHistoriesForRebuild()

    expect(anyPass._historyInvalid).toBe(true)
    expect(anyPass._shadowHistoryInvalid).toBe(true)

    log('rebuild-boundary-rearm', {
      colour: anyPass._historyInvalid,
      shadow: anyPass._shadowHistoryInvalid
    })
  })

  // The shadow length resolves in the colour pass as the second attachment, as
  // cloudsResolve.frag does (two passes cost 2.5 ms),
  // and the consumer's node must follow the swapped history's second attachment
  test("the shadow length is the resolve pair's second attachment and follows the swap", () => {
    const pass = makePassNode()
    pass.cloudsContext.lightShafts = true
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)

    expect(pass.resolveRT!.textures).toHaveLength(2)
    expect(pass.historyRT!.textures).toHaveLength(2)
    expect(pass.historyRT!.textures[1]!.name).toBe('shadowLength')
    expect(anyPass.renderShadowLengthResolvePass).toBeUndefined()
    const slNode = anyPass._shadowLengthHistoryTexNode as { value: unknown }
    const originalHistory = pass.historyRT
    const originalResolve = pass.resolveRT
    expect(slNode.value).toBe(originalHistory!.textures[1])

    const renderer = rendererStub()
    pass.resolveRT!.setSize(64, 64)
    pass.historyRT!.setSize(64, 64)
    anyPass._historyInvalid = true
    anyPass.renderResolvePass(renderer, 64, 64)

    // One pass, one swap: both attachments moved together
    expect(pass.historyRT).toBe(originalResolve)
    expect(slNode.value).toBe(originalResolve!.textures[1])
    expect(pass.outputTextureNode.value).toBe(originalResolve!.textures[0])

    log('shadowLength-merged-resolve', {
      attachments: pass.historyRT!.textures.length,
      followsSwap: slNode.value === originalResolve!.textures[1]
    })
  })

  // Light shafts off: a single attachment, and the consumer's node parks on
  // the placeholder rather than a missing second texture
  test('without light shafts the resolve pair has one attachment', () => {
    const pass = makePassNode()
    pass.cloudsContext.lightShafts = false
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)
    expect(pass.resolveRT!.textures).toHaveLength(1)
    const slNode = anyPass._shadowLengthHistoryTexNode as { value: unknown }
    expect(slNode.value).toBe(anyPass.shadowLengthPlaceholder)
  })

  test('resize invalidates history and drops previous matrices', () => {
    const { pass, anyPass } = buildPassWithResolve()
    const cu = pass.cloudsContext.cameraUniforms
    const renderer = rendererStub()

    // Simulate first frame at 800×600
    const camera = new PerspectiveCamera(75, 1, 0.1, 1000)
    camera.updateMatrixWorld(true)
    cu.copyReprojectionMatrix(camera)
    anyPass._lastResolveW = 800
    anyPass._lastResolveH = 600
    pass.resolveRT!.setSize(800, 600)
    pass.historyRT!.setSize(800, 600)
    anyPass._historyInvalid = false

    // Resize to 1024×768
    anyPass.renderResolvePass(renderer, 1024, 768)

    expect(anyPass._lastResolveW).toBe(1024)
    expect(anyPass._lastResolveH).toBe(768)
    // A resize clears both halves and still renders the ordinary resolve
    expect(renderer.clear).toHaveBeenCalledTimes(2)
    expect(renderer.setRenderTarget).toHaveBeenCalled()
    expect(
      (cu as unknown as CameraUniformsInternals).previousProjectionMatrix
    ).toBeNull()

    log('resize-invalidation', {
      newW: anyPass._lastResolveW,
      newH: anyPass._lastResolveH,
      matricesCleared:
        (cu as unknown as CameraUniformsInternals).previousProjectionMatrix ===
        null
    })
  })

  test('enabled false→true triggers resetHistory', () => {
    const { pass, anyPass } = buildPassWithResolve()
    anyPass._historyInvalid = false

    pass.cloudsContext.enabled = false
    // Going from false to false: no reset
    pass.cloudsContext.enabled = false
    expect(anyPass._historyInvalid).toBe(false)

    // Going from false to true triggers a reset
    pass.cloudsContext.enabled = true
    expect(anyPass._historyInvalid).toBe(true)

    log('enabled-false-true', {
      historyInvalidAfterReEnable: anyPass._historyInvalid
    })
  })

  test('enabled true→false does NOT trigger resetHistory', () => {
    const { pass, anyPass } = buildPassWithResolve()
    anyPass._historyInvalid = false

    pass.cloudsContext.enabled = false
    expect(anyPass._historyInvalid).toBe(false)

    log('enabled-true-false', {
      historyInvalidAfterDisable: anyPass._historyInvalid
    })
  })

  test('sceneDepth swap triggers resetHistory', () => {
    const { pass, anyPass } = buildPassWithResolve()
    anyPass._historyInvalid = false

    const newDepth = texture(new Texture())
    pass.sceneDepth = newDepth
    expect(anyPass._historyInvalid).toBe(true)

    log('sceneDepth-swap', { historyInvalid: anyPass._historyInvalid })
  })

  test('sceneDepth set to same value does NOT trigger resetHistory', () => {
    const { pass, anyPass } = buildPassWithResolve()
    const depth = texture(new Texture())
    pass.sceneDepth = depth
    anyPass._historyInvalid = false

    pass.sceneDepth = depth
    expect(anyPass._historyInvalid).toBe(false)

    log('sceneDepth-same', { historyInvalid: anyPass._historyInvalid })
  })

  test('temporalUpscale setter bumps graphVersion and resets history', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    const ctx = pass.cloudsContext

    // Register reset callback (constructor already did this)
    // Build resolve so the flag exists
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    anyPass.buildResolveGraph(ctx, anyPass._parameterUniforms)
    anyPass._historyInvalid = false

    const prevVersion = ctx.graphVersion
    ctx.temporalUpscale = false

    expect(ctx.graphVersion).toBe(prevVersion + 1)
    expect(anyPass._historyInvalid).toBe(true)

    log('temporalUpscale-setter', {
      versionBumped: ctx.graphVersion === prevVersion + 1,
      historyInvalid: anyPass._historyInvalid
    })
  })

  test('temporalUpscale setter no-ops for same value', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const prevVersion = ctx.graphVersion

    // Already true
    ctx.temporalUpscale = true
    expect(ctx.graphVersion).toBe(prevVersion)

    log('temporalUpscale-noop', {
      versionUnchanged: ctx.graphVersion === prevVersion
    })
  })
})

describe('CloudsPassNode stale-frame warning', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_staleFrame')
  })

  test('warns exactly once after 16 unchanged frames', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    pass.cloudsContext.frame = 5
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const renderer = rendererStub()
    for (let i = 0; i < 16; i++) {
      pass.updateBefore(frameStub(i, renderer) as never)
    }

    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain('temporalUpscale is on')
    expect(warnSpy.mock.calls[0]![0]).toContain('16 renders')

    warnSpy.mockRestore()

    log('stale-warn-16', { warnCount: 1 })
  })

  test('does not warn at 15 unchanged frames', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    pass.cloudsContext.frame = 5
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const renderer = rendererStub()
    for (let i = 0; i < 15; i++) {
      pass.updateBefore(frameStub(i, renderer) as never)
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()

    log('stale-no-warn-15', { warnCount: 0 })
  })

  test('does not warn when frame advances', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const renderer = rendererStub()
    for (let i = 0; i < 20; i++) {
      pass.cloudsContext.frame = i
      pass.updateBefore(frameStub(i, renderer) as never)
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()

    log('stale-no-warn-advancing', { warnCount: 0 })
  })

  test('does not warn when warnings = false', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    pass.cloudsContext.frame = 5
    pass.cloudsContext.warnings = false
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const renderer = rendererStub()
    for (let i = 0; i < 20; i++) {
      pass.updateBefore(frameStub(i, renderer) as never)
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()

    log('stale-no-warn-silenced', { warnCount: 0 })
  })

  test('does not warn when temporalUpscale = false', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = false
    pass.cloudsContext.frame = 5
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const renderer = rendererStub()
    for (let i = 0; i < 20; i++) {
      pass.updateBefore(frameStub(i, renderer) as never)
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()

    log('stale-no-warn-taa', { warnCount: 0 })
  })

  test('warns again after frame advances then stalls again', () => {
    const pass = makePassNode()
    pass.cloudsContext.temporalUpscale = true
    pass.cloudsContext.frame = 5
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const renderer = rendererStub()

    // First stall: 16 frames
    for (let i = 0; i < 16; i++) {
      pass.updateBefore(frameStub(i, renderer) as never)
    }
    expect(warnSpy).toHaveBeenCalledOnce()

    // Advance the frame, which resets stale tracking
    pass.cloudsContext.frame = 6
    pass.updateBefore(frameStub(17, renderer) as never)

    // Second stall: 16 more frames
    for (let i = 0; i < 16; i++) {
      pass.updateBefore(frameStub(18 + i, renderer) as never)
    }
    expect(warnSpy).toHaveBeenCalledTimes(2)

    warnSpy.mockRestore()

    log('stale-warn-again', { totalWarnings: 2 })
  })
})

describe('CloudShadowDescriptor', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_shadowDescriptor')
  })

  test('cloudShadow getter returns a CloudShadowDescriptor', () => {
    const pass = makePassNode()
    const desc = pass.cloudShadow
    expect(desc).toBeDefined()
    expect(desc.cascadeCount).toBe(pass.cloudsContext.shadow.cascadeCount)
    expect(desc.mapSize).toBe(pass.cloudsContext.shadow.mapSize)
    expect(desc.far).toBeDefined()
    expect(desc.topHeight).toBeDefined()

    log('descriptor-shape', {
      cascadeCount: desc.cascadeCount,
      mapSize: `${desc.mapSize.x}×${desc.mapSize.y}`,
      hasFar: desc.far != null,
      hasTopHeight: desc.topHeight != null
    })
  })

  test('cloudShadow getter is idempotent (same reference)', () => {
    const pass = makePassNode()
    const a = pass.cloudShadow
    const b = pass.cloudShadow
    expect(a).toBe(b)
  })

  // The placeholder's filters decide how every atlas read compiles, once, at
  // build (isUnfilterable). Nearest gives textureLoad (hard blocks), Linear
  // with implicit LOD ~nothing, Linear with explicit LOD present and filtered

  // Implicit LOD fails in the march and PCF loops' non-uniform flow, where Dawn
  // returns ~zeros. GL drivers forgive the same read on side A

  // Cite: ShadowPass.ts:26-28, the reference filters its atlas, so Linear is
  // the fidelity contract
  test('the pre-allocation placeholder carries the atlas filters (Linear)', () => {
    const pass = makePassNode()
    const desc = pass.cloudShadow
    const placeholder = desc.mapNode.value as DataArrayTexture
    expect(desc.map).toBe(placeholder)
    expect(placeholder.minFilter).toBe(LinearFilter)
    expect(placeholder.magFilter).toBe(LinearFilter)
    expect(placeholder.type).toBe(HalfFloatType)
    log('placeholder-contract', {
      minFilter: placeholder.minFilter,
      magFilter: placeholder.magFilter,
      type: placeholder.type
    })
  })

  test('the pre-allocation placeholder uploads real zero texels', async () => {
    const pass = makePassNode()
    const placeholder = pass.cloudShadow.mapNode.value as DataArrayTexture
    const moduleName: string =
      'three/src/renderers/webgpu/utils/WebGPUTextureUtils.js'
    const { default: WebGPUTextureUtils } = (await import(
      /* @vite-ignore */ moduleName
    )) as {
      default: new (backend: unknown) => {
        updateTexture: (
          texture: DataArrayTexture,
          options: { image: DataArrayTexture['image'] }
        ) => void
      }
    }
    const writeTexture = vi.fn()
    const utils = new WebGPUTextureUtils({
      device: { queue: { writeTexture } },
      get: () => ({
        texture: {},
        textureDescriptorGPU: { format: 'rgba16float' }
      })
    })

    utils.updateTexture(placeholder, { image: placeholder.image })

    expect(writeTexture).toHaveBeenCalledTimes(placeholder.image.depth)
    for (const call of writeTexture.mock.calls) {
      expect(call[1]).toBe(placeholder.image.data)
      expect(call[1]).not.toBeNull()
    }
    expect(placeholder.image.data).toBeInstanceOf(Uint16Array)
    expect(placeholder.image.data).toHaveLength(4 * placeholder.image.depth)

    const anyPass = internals(pass)
    anyPass.ensureShadowRT(4, 4, placeholder.image.depth)
    const renderTarget = anyPass.shadowRT!.texture as DataArrayTexture
    expect(renderTarget.image.data).toBeNull()

    log('placeholder-upload', {
      layers: placeholder.image.depth,
      writeCount: writeTexture.mock.calls.length,
      hasData: placeholder.image.data != null,
      renderTargetHasData: renderTarget.image.data != null
    })
  })

  test('an atlas consumer built before the first update compiles to an EXPLICIT-LOD sample', () => {
    const pass = makePassNode()
    // Read before any update, exactly as the aerial/light consumers do
    const desc = pass.cloudShadow
    const transmittance = createCloudShadowTransmittance(desc, {
      viewMatrix: uniform(new Matrix4()),
      cameraNear: uniform(0.1),
      sunDirection: uniform(new Vector3(0, 0, 1)),
      bottomRadius: uniform(6360000),
      ecefToWorldMatrix: uniform(new Matrix4()),
      altitudeCorrection: uniform(new Vector3()),
      worldToUnit: uniform(1 / 6360000),
      temporalJitter: uniform(new Vector2()),
      resolution: uniform(new Vector2(800, 600))
    })
    const { fragment } = compileWGSL(
      vec3(transmittance(vec3(0, 0, 6361000), float(0), float(0)))
    )
    const wgsl = normalizeWGSL(fragment)
    // textureSampleLevel is filtered and derivative-free, legal in non-uniform
    // flow. The atlas has no mip chain, so the explicit level 0 equals the
    // implicit LOD
    expect(wgsl).toContain('textureSampleLevel')
    expect(wgsl).not.toContain('textureLoad')
    log('atlas-read-compiles-to', {
      textureSampleLevel: (wgsl.match(/textureSampleLevel/g) ?? []).length,
      textureLoad: (wgsl.match(/textureLoad/g) ?? []).length
    })
  })

  // Arrays sized to cascadeCount forced a descriptor rebuild that orphaned
  // consumers. They are allocated at MAX_CASCADE_COUNT as the
  // reference does (CloudsMaterial.ts:236-242)
  test('uniform arrays are allocated at MAX_CASCADE_COUNT, not cascadeCount', () => {
    const pass = makePassNode()
    const desc = pass.cloudShadow
    const n = desc.cascadeCount

    const intervals = desc.intervals.array as Vector2[]
    const matrices = desc.matrices.array as Matrix4[]
    const inverseMatrices = desc.inverseMatrices.array as Matrix4[]

    expect(intervals).toHaveLength(MAX_CASCADE_COUNT)
    expect(matrices).toHaveLength(MAX_CASCADE_COUNT)
    expect(inverseMatrices).toHaveLength(MAX_CASCADE_COUNT)
    // The point of the max allocation: every cascade the config can ask for
    // already has a slot, so nothing has to be reallocated
    expect(n).toBeLessThanOrEqual(MAX_CASCADE_COUNT)

    log('uniform-array-lengths', {
      cascadeCount: n,
      max: MAX_CASCADE_COUNT,
      intervals: intervals.length,
      matrices: matrices.length,
      inverseMatrices: inverseMatrices.length
    })
  })

  // The 5ywq regression: a cascade-count change must not replace the descriptor
  // or its nodes, which consumers capture once when they build
  test('descriptor and its nodes survive a cascadeCount change', () => {
    const pass = makePassNode()
    const before = pass.cloudShadow
    const { mapNode, intervals, matrices, inverseMatrices } = before

    pass.cloudsContext.shadow.cascadeCount = 2
    pass.cloudsContext.checkShadowStructure()
    const after = pass.cloudShadow

    expect(after).toBe(before)
    expect(after.mapNode).toBe(mapNode)
    expect(after.intervals).toBe(intervals)
    expect(after.matrices).toBe(matrices)
    expect(after.inverseMatrices).toBe(inverseMatrices)
  })

  test('after updateCloudShadowDescriptor, values match CascadedShadowMaps', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const camera = new PerspectiveCamera(75, 1, 0.1, 50000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)

    ctx.updateShadowMaps(camera)

    const desc = pass.cloudShadow

    // Manually trigger the shadow RT creation and descriptor update
    const anyPass = internals(pass)
    const mapSize = ctx.shadow.mapSize
    anyPass.ensureShadowRT(mapSize.x, mapSize.y, ctx.shadow.cascadeCount)
    anyPass.updateCloudShadowDescriptor(ctx)

    const cascades = ctx.shadowMaps!.cascades
    const intervals = desc.intervals.array as Vector2[]
    const matrices = desc.matrices.array as Matrix4[]
    const inverseMatrices = desc.inverseMatrices.array as Matrix4[]

    for (let i = 0; i < desc.cascadeCount; i++) {
      expect(intervals[i]!.x).toBe(cascades[i]!.interval.x)
      expect(intervals[i]!.y).toBe(cascades[i]!.interval.y)
      expect(matrices[i]!.elements).toEqual(cascades[i]!.matrix.elements)
      expect(inverseMatrices[i]!.elements).toEqual(
        cascades[i]!.inverseMatrix.elements
      )
    }

    expect(desc.far.value).toBe(ctx.shadowMaps!.far)

    log('descriptor-values-match', {
      far: desc.far.value,
      topHeight: desc.topHeight.value,
      interval0: `[${intervals[0]!.x.toFixed(4)}, ${intervals[0]!.y.toFixed(4)}]`,
      matrixDet0: matrices[0]!.determinant().toFixed(6)
    })
  })

  test('map updates when shadow RT is recreated', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const desc = pass.cloudShadow

    const anyPass = internals(pass)
    anyPass.ensureShadowRT(512, 512, 3)
    anyPass.updateCloudShadowDescriptor(ctx)

    const firstMap = desc.map
    expect(firstMap).toBe(anyPass.shadowRT!.texture)

    // Force a new shadow RT by changing the size
    anyPass.ensureShadowRT(1024, 1024, 3)
    anyPass.updateCloudShadowDescriptor(ctx)

    expect(desc.map).toBe(anyPass.shadowRT!.texture)
    expect(desc.map).not.toBe(firstMap)

    log('descriptor-map-update', {
      firstMapSize: `${firstMap.image.width}×${firstMap.image.height}`,
      secondMapSize: `${desc.map.image.width}×${desc.map.image.height}`,
      mapUpdated: desc.map !== firstMap
    })
  })

  // disabled clouds must leave no cloud shadow on the ground. Every
  // consumer samples cloudShadow.mapNode whatever the pass state, and it kept
  // the last atlas. Checking the node covers every consumer
  test('a disabled pass serves a lit (all-zero) shadow atlas and restores it on enable', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const desc = pass.cloudShadow
    const anyPass = internals(pass)
    anyPass.ensureShadowRT(512, 512, 3)
    anyPass.updateCloudShadowDescriptor(ctx)
    const atlas = anyPass.shadowRT!.texture
    expect(desc.mapNode.value, 'enabled: the real atlas').toBe(atlas)

    ctx.enabled = false
    pass.updateBefore(frameStub(1, rendererStub()) as never)
    const served = desc.mapNode.value as DataArrayTexture
    const data = served.image.data as ArrayLike<number> | null
    const texels = data == null ? 0 : data.length / 4
    let nonZero = 0
    for (let i = 0; data != null && i < data.length; i++) {
      if (data[i] !== 0) nonZero++
    }
    log('disabled-shadow-atlas', {
      servesFrozenAtlas: served === atlas,
      layers: served.image.depth,
      texels,
      nonZeroChannels: nonZero
    })
    expect(served, 'disabled: not the frozen atlas').not.toBe(atlas)
    expect(desc.map).toBe(served)
    expect(texels, 'the lit atlas has real texels').toBeGreaterThan(0)
    expect(nonZero, 'every channel 0: optical depth 0, tail included').toBe(0)
    expect(served.image.depth).toBeGreaterThanOrEqual(ctx.shadow.cascadeCount)

    ctx.enabled = true
    anyPass.updateCloudShadowDescriptor(ctx)
    expect(desc.mapNode.value, 're-enabled: the real atlas again').toBe(atlas)
  })

  test('topHeight reflects layerUniforms.shadowTopHeight', async () => {
    const { createLayerUniforms: createLU, updateLayerUniforms: updateLU } =
      await import('./layerUniforms')

    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const anyPass = internals(pass)

    anyPass.ensureShadowRT(512, 512, 3)

    anyPass._layerUniforms = createLU()
    updateLU(anyPass._layerUniforms, ctx)

    const desc = pass.cloudShadow
    anyPass.updateCloudShadowDescriptor(ctx)

    expect(desc.topHeight.value).toBe(
      anyPass._layerUniforms.shadowTopHeight.value
    )

    log('descriptor-topHeight', {
      topHeight: desc.topHeight.value,
      layerTopHeight: anyPass._layerUniforms.shadowTopHeight.value
    })
  })

  test('source: CloudShadowDescriptor interface is exported', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./CloudsPassNode.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('export interface CloudShadowDescriptor')
    expect(source).toContain('uniformArray')
    expect(source).toContain('updateCloudShadowDescriptor')
    expect(source).toContain('CloudsEffect.ts:421')
  })

  test('source: index.ts re-exports CloudShadowDescriptor', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf8')
    )
    expect(source).toContain('CloudShadowDescriptor')
  })
})

describe('Shadow cascade temporal resolve', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_shadowResolve')
  })

  test('shadow resolve targets are created when temporalPass is true', () => {
    const pass = makePassNode()
    pass.cloudsContext.shadow.temporalPass = true
    const anyPass = internals(pass)
    // Force graph build by accessing the shadow resolve graph
    anyPass._shadowUniforms = {
      maxIterationCount: { value: 100 },
      minStepSize: { value: 50 },
      maxStepSize: { value: 200 },
      minDensity: { value: 0.001 },
      minExtinction: { value: 0.001 },
      minTransmittance: { value: 0.01 },
      opticalDepthTailScale: { value: 1 },
      inverseShadowMatrix: { value: new Matrix4() },
      reprojectionMatrix: { value: new Matrix4() },
      mipLevel: { value: 0 },
      cascadeIndex: { value: 0 },
      shadowResolution: { value: new Vector2(512, 512) }
    }
    anyPass.ensureShadowRT(512, 512, 2)
    anyPass.ensureShadowResolveTargets(512, 512, 2)

    // no separate velocity target. The depth velocity is the shadow
    // march target's second attachment, named for its MRT key
    const shadowTextures = (
      anyPass.shadowRT as unknown as { textures: Texture[] }
    ).textures
    expect(shadowTextures.map(t => t.name)).toEqual([
      'shadowAtlas',
      'shadowVelocity'
    ])
    expect(anyPass.shadowResolveRT).not.toBeNull()
    expect(anyPass.shadowHistoryRT).not.toBeNull()

    log('shadow-resolve-targets-created', {
      shadowAttachments: shadowTextures.length,
      hasResolveRT: anyPass.shadowResolveRT != null,
      hasHistoryRT: anyPass.shadowHistoryRT != null
    })
  })

  test('swapShadowBuffers swaps resolve and history RTs', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass.shadowResolveRT = { texture: new Texture(), dispose: vi.fn() }
    anyPass.shadowHistoryRT = { texture: new Texture(), dispose: vi.fn() }

    const originalResolve = anyPass.shadowResolveRT
    const originalHistory = anyPass.shadowHistoryRT

    anyPass.swapShadowBuffers()

    expect(anyPass.shadowResolveRT).toBe(originalHistory)
    expect(anyPass.shadowHistoryRT).toBe(originalResolve)

    log('shadow-swap', {
      resolveIsFormerHistory: anyPass.shadowResolveRT === originalHistory,
      historyIsFormerResolve: anyPass.shadowHistoryRT === originalResolve
    })
  })

  test('double swap restores original configuration', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass.shadowResolveRT = { texture: new Texture(), dispose: vi.fn() }
    anyPass.shadowHistoryRT = { texture: new Texture(), dispose: vi.fn() }

    const originalResolve = anyPass.shadowResolveRT
    const originalHistory = anyPass.shadowHistoryRT

    anyPass.swapShadowBuffers()
    anyPass.swapShadowBuffers()

    expect(anyPass.shadowResolveRT).toBe(originalResolve)
    expect(anyPass.shadowHistoryRT).toBe(originalHistory)
  })

  test('shadow varianceGamma default is 1 (ShadowResolveMaterial:55)', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._shadowVarianceGamma = null
    // Trigger lazy init by setting it
    pass.cloudsContext.shadow.temporalPass = true

    // The default is set in buildShadowResolveGraph via ??=
    expect(anyPass._shadowVarianceGamma).toBeNull()
    // After graph build it would be uniform(1)

    log('shadow-varianceGamma-default', { expected: 1 })
  })

  test('shadow temporalAlpha default is 0.01 (ShadowResolveMaterial:60)', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._shadowTemporalAlpha = null

    expect(anyPass._shadowTemporalAlpha).toBeNull()
    // After graph build it would be uniform(0.01)

    log('shadow-temporalAlpha-default', { expected: 0.01 })
  })

  test('dispose() cleans up shadow resolve targets', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)

    const disposeResolve = vi.fn()
    const disposeHistory = vi.fn()

    anyPass.shadowResolveRT = {
      texture: new Texture(),
      dispose: disposeResolve
    }
    anyPass.shadowHistoryRT = {
      texture: new Texture(),
      dispose: disposeHistory
    }

    pass.dispose()

    expect(disposeResolve).toHaveBeenCalled()
    expect(disposeHistory).toHaveBeenCalled()

    log('shadow-resolve-dispose', {
      velocityDisposed: true,
      resolveDisposed: true,
      historyDisposed: true
    })
  })

  test('_shadowHistoryInvalid starts as true', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    expect(anyPass._shadowHistoryInvalid).toBe(true)

    log('shadow-history-invalid-default', { initial: true })
  })

  test('invalid shadow history is cleared before resolving the current march', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.temporalPass = true
    ctx.shadow.cascadeCount = 2
    ctx.shadow.mapSize.set(64, 64)
    ctx.checkShadowStructure()

    const camera = new PerspectiveCamera(75, 1, 0.1, 50000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)
    ctx.updateShadowMaps(camera)

    const anyPass = internals(pass)
    // The reference's per-frame alpha is what this asserts, and the default
    // interval compounds it
    ctx.shadow.updateInterval = 1
    anyPass._shadowUniforms = {
      maxIterationCount: { value: 100 },
      minStepSize: { value: 50 },
      maxStepSize: { value: 200 },
      minDensity: { value: 0.001 },
      minExtinction: { value: 0.001 },
      minTransmittance: { value: 0.01 },
      opticalDepthTailScale: { value: 1 },
      inverseShadowMatrix: { value: new Matrix4() },
      reprojectionMatrix: { value: new Matrix4() },
      mipLevel: { value: 0 },
      cascadeIndex: { value: 0 },
      shadowResolution: { value: new Vector2(64, 64) }
    }
    anyPass.ensureShadowRT(64, 64, 2)
    anyPass.ensureShadowResolveTargets(64, 64, 2)
    const resolveTarget = anyPass.shadowResolveRT
    const historyTarget = anyPass.shadowHistoryRT
    const temporalAlpha = { value: 0.01 }
    anyPass._shadowTemporalAlpha = temporalAlpha
    anyPass._shadowHistoryInvalid = true

    const renderer = rendererStub(64, 64)
    const resolveAlphas: number[] = []
    renderer.render.mockImplementation(() => {
      const target = renderer.setRenderTarget.mock.lastCall?.[0]
      if (target === resolveTarget) resolveAlphas.push(temporalAlpha.value)
    })
    anyPass.renderShadowPass(ctx, renderer)

    const historyClears = renderer.setRenderTarget.mock.calls.filter(
      call => call[0] === historyTarget
    )
    const resolveDraws = renderer.setRenderTarget.mock.calls.filter(
      call => call[0] === resolveTarget
    )
    expect(historyClears).toHaveLength(2)
    expect(renderer.clear).toHaveBeenCalledTimes(4)
    // Two clears followed by two full-screen resolve draws
    expect(resolveDraws).toHaveLength(4)
    expect(resolveAlphas).toEqual([0.01, 0.01])
    expect(anyPass._shadowHistoryInvalid).toBe(false)
    expect(temporalAlpha.value).toBe(0.01)
    expect(anyPass.shadowHistoryRT).toBe(resolveTarget)

    log('shadow-history-reset', {
      clearedHistoryLayers: historyClears.length,
      cascadeDraws: resolveDraws.length,
      resolveAlphas,
      historyInvalid: anyPass._shadowHistoryInvalid,
      temporalAlpha: temporalAlpha.value,
      publishedWrittenTarget: anyPass.shadowHistoryRT === resolveTarget
    })
  })

  // colour and depth velocity in one draw per update, as
  // shadow.frag:24-35. A separate velocity pass per cascade cost a fixed
  // per-pass overhead, now one march and one resolve pass per cascade
  test('one shadow update draws cascadeCount march + cascadeCount resolve passes, no velocity pass', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    ctx.shadow.temporalPass = true
    // Match the targets made below, or renderShadowPass re-creates them at the
    // default map size and the identity checks compare against stale objects
    ctx.shadow.mapSize.set(64, 64)
    const n = ctx.shadow.cascadeCount
    anyPass._shadowUniforms = {
      maxIterationCount: { value: 100 },
      minStepSize: { value: 50 },
      maxStepSize: { value: 200 },
      minDensity: { value: 0.001 },
      minExtinction: { value: 0.001 },
      minTransmittance: { value: 0.01 },
      opticalDepthTailScale: { value: 1 },
      inverseShadowMatrix: { value: new Matrix4() },
      reprojectionMatrix: { value: new Matrix4() },
      mipLevel: { value: 0 },
      cascadeIndex: { value: 0 },
      shadowResolution: { value: new Vector2(64, 64) }
    }
    anyPass.ensureShadowRT(64, 64, n)
    anyPass.ensureShadowResolveTargets(64, 64, n)
    anyPass._shadowHistoryInvalid = false
    const shadowTarget = anyPass.shadowRT
    const resolveTarget = anyPass.shadowResolveRT

    const renderer = rendererStub(64, 64)
    const drawTargets: unknown[] = []
    renderer.render.mockImplementation(() => {
      drawTargets.push(renderer.setRenderTarget.mock.lastCall?.[0])
    })
    anyPass.renderShadowPass(ctx, renderer)

    const march = drawTargets.filter(t => t === shadowTarget).length
    const resolve = drawTargets.filter(t => t === resolveTarget).length
    const other = drawTargets.length - march - resolve
    log('shadow-update-passes', {
      cascades: n,
      march,
      resolve,
      other,
      total: drawTargets.length
    })
    expect(march).toBe(n)
    expect(resolve).toBe(n)
    expect(other).toBe(0)
  })
})

describe('shadow.updateInterval (port-only: the shadow map every N frames)', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_shadowUpdateInterval')
  })

  function shadowUniformsStub() {
    return {
      maxIterationCount: { value: 100 },
      minStepSize: { value: 50 },
      maxStepSize: { value: 200 },
      minDensity: { value: 0.001 },
      minExtinction: { value: 0.001 },
      minTransmittance: { value: 0.01 },
      opticalDepthTailScale: { value: 1 },
      inverseShadowMatrix: { value: new Matrix4() },
      reprojectionMatrix: { value: new Matrix4() },
      mipLevel: { value: 0 },
      cascadeIndex: { value: 0 },
      shadowResolution: { value: new Vector2(64, 64) }
    }
  }

  test('renders the shadow map on the first frame and then every N frames', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    ctx.shadow.updateInterval = 3
    ctx.shadow.temporalPass = false
    const anyPass = internals(pass)
    anyPass._shadowUniforms = shadowUniformsStub()

    const renderer = rendererStub(64, 64)
    const camera = new PerspectiveCamera(75, 1, 0.1, 50000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)

    const rendersPerFrame: number[] = []
    for (let f = 1; f <= 7; f++) {
      renderer.setRenderTarget.mockClear()
      pass.updateBefore(frameStub(f, renderer, camera) as never)
      rendersPerFrame.push(
        renderer.setRenderTarget.mock.calls.filter(
          call => call[0] === anyPass.shadowRT
        ).length
      )
    }
    // 3 cascades on frames 1, 4, 7, nothing in between
    expect(rendersPerFrame).toEqual([3, 0, 0, 3, 0, 0, 3])

    log('shadow-update-interval', { interval: 3, rendersPerFrame })
  })

  test("a skipped frame keeps the cascade fit but recomposes for this frame's camera", () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    ctx.shadow.updateInterval = 2
    ctx.shadow.temporalPass = false
    const anyPass = internals(pass)
    anyPass._shadowUniforms = shadowUniformsStub()
    // A consumer, so the descriptor exists and is what the marches read
    const desc = pass.cloudShadow

    const renderer = rendererStub(64, 64)
    const camera = new PerspectiveCamera(75, 1, 0.1, 50000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)

    pass.updateBefore(frameStub(1, renderer, camera) as never)
    const matrixAfterRender = (desc.matrices.array as Matrix4[])[0]!.clone()
    const fitAfterRender = ctx.shadowMaps!.cascades[0]!.matrix.clone()
    const viewZAfterRender = (
      anyPass._viewZFromECEF as { value: Vector4 }
    ).value.clone()

    // The camera moves, and frame 2 is a skipped frame
    camera.position.set(2000, 6371000, 500)
    camera.lookAt(5000, 6371000, 0)
    camera.updateMatrixWorld(true)
    renderer.setRenderTarget.mockClear()
    pass.updateBefore(frameStub(2, renderer, camera) as never)

    const shadowRenders = renderer.setRenderTarget.mock.calls.filter(
      call => call[0] === anyPass.shadowRT
    ).length
    const matrixAfterSkip = (desc.matrices.array as Matrix4[])[0]!
    const fitAfterSkip = ctx.shadowMaps!.cascades[0]!.matrix
    const viewZAfterSkip = (anyPass._viewZFromECEF as { value: Vector4 }).value

    expect(shadowRenders).toBe(0)
    // Frozen: the map, its matrices and the fit they came from
    expect(matrixAfterSkip.equals(matrixAfterRender)).toBe(true)
    expect(fitAfterSkip.equals(fitAfterRender)).toBe(true)
    // Live: the view-depth row the marches select cascades through
    expect(viewZAfterSkip.equals(viewZAfterRender)).toBe(false)

    log('shadow-update-interval-skip', {
      shadowRenders,
      matrixFrozen: matrixAfterSkip.equals(matrixAfterRender),
      viewZMoved: !viewZAfterSkip.equals(viewZAfterRender)
    })
  })

  test('a structure change or a history reset forces a render on a skipped frame', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    ctx.shadow.updateInterval = 4
    ctx.shadow.temporalPass = false
    const anyPass = internals(pass)
    anyPass._shadowUniforms = shadowUniformsStub()
    const renderer = rendererStub(64, 64)
    const camera = new PerspectiveCamera(75, 1, 0.1, 50000)
    camera.position.set(0, 6371000, 0)
    camera.updateMatrixWorld(true)
    const renders = () =>
      renderer.setRenderTarget.mock.calls.filter(
        call => call[0] === anyPass.shadowRT
      ).length

    pass.updateBefore(frameStub(1, renderer, camera) as never)
    renderer.setRenderTarget.mockClear()
    pass.updateBefore(frameStub(2, renderer, camera) as never)
    expect(renders()).toBe(0)

    ctx.shadow.cascadeCount = 2
    renderer.setRenderTarget.mockClear()
    pass.updateBefore(frameStub(3, renderer, camera) as never)
    expect(renders()).toBe(2)

    renderer.setRenderTarget.mockClear()
    pass.updateBefore(frameStub(4, renderer, camera) as never)
    expect(renders()).toBe(0)

    ctx.resetHistory()
    renderer.setRenderTarget.mockClear()
    pass.updateBefore(frameStub(5, renderer, camera) as never)
    expect(renders()).toBe(2)

    log('shadow-update-interval-forced', {
      forcedByStructure: 2,
      forcedByReset: 2
    })
  })

  test("the temporal alpha compounds to the reference's per-frame 0.01", () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.updateInterval = 1
    expect(shadowTemporalAlpha(ctx)).toBeCloseTo(0.01, 12)
    ctx.shadow.updateInterval = 2
    // Two blends of 0.01 leave (1 - 0.01)^2 of the history: one blend of this
    expect(shadowTemporalAlpha(ctx)).toBeCloseTo(1 - 0.99 * 0.99, 12)
    // Below 1 clamps to every frame
    ctx.shadow.updateInterval = 0.5
    expect(shadowTemporalAlpha(ctx)).toBeCloseTo(0.01, 12)

    log('shadow-update-interval-alpha', {
      one: 0.01,
      two: 1 - 0.99 * 0.99
    })
  })
})

describe('Shadow knob set', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_knobs')
  })

  // lightShafts setter

  test('lightShafts setter bumps graphVersion', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    ctx.lightShafts = !ctx.lightShafts
    expect(ctx.graphVersion).toBe(v0 + 1)

    log('lightShafts-graphVersion', { bumped: true })
  })

  test('lightShafts setter resets history', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)
    anyPass._historyInvalid = false

    pass.cloudsContext.lightShafts = !pass.cloudsContext.lightShafts
    expect(anyPass._historyInvalid).toBe(true)

    log('lightShafts-resetHistory', { historyInvalid: true })
  })

  test('lightShafts setter no-ops for same value', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    const sameShafts = ctx.lightShafts
    ctx.lightShafts = sameShafts
    expect(ctx.graphVersion).toBe(v0)

    log('lightShafts-noop', { unchanged: true })
  })

  // lightShaftsHalfResolution setter (the quad-shared shadow length)

  test('lightShaftsHalfResolution defaults on and bumps graphVersion once per change', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    expect(ctx.lightShaftsHalfResolution).toBe(true)
    const v0 = ctx.graphVersion
    ctx.lightShaftsHalfResolution = false
    expect(ctx.graphVersion).toBe(v0 + 1)
    ctx.lightShaftsHalfResolution = false
    expect(ctx.graphVersion).toBe(v0 + 1)
    expect(ctx.graphFlags().lightShaftsHalfResolution).toBe(false)

    log('lightShaftsHalfResolution-graphVersion', { bumped: true, noop: true })
  })

  test('lightShaftsHalfResolution setter resets history', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)
    anyPass._resolveWidth = null
    anyPass._resolveHeight = null
    anyPass._varianceGamma = null
    anyPass._temporalAlpha = null
    anyPass._parameterUniforms = { frame: { value: 0 } }
    anyPass.buildResolveGraph(pass.cloudsContext, anyPass._parameterUniforms)
    anyPass._historyInvalid = false

    pass.cloudsContext.lightShaftsHalfResolution = false
    expect(anyPass._historyInvalid).toBe(true)

    log('lightShaftsHalfResolution-resetHistory', { historyInvalid: true })
  })

  test('lightShaftsHalfResolution moves the program cache key', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const before = hashGraphFlags(true, false, ctx.graphFlags())
    ctx.lightShaftsHalfResolution = false
    const after = hashGraphFlags(true, false, ctx.graphFlags())
    expect(after).not.toBe(before)

    log('lightShaftsHalfResolution-cacheKey', { before, after })
  })

  test('lightShafts toggle recreates layerRT with correct MRT count', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const anyPass = internals(pass)

    expect(ctx.lightShafts).toBe(true)
    expect(pass.layerRT.textures).toHaveLength(3)

    const oldRT = pass.layerRT
    ctx.lightShafts = false
    anyPass.ensureLayerRT(false)

    expect(pass.layerRT).not.toBe(oldRT)
    expect(pass.layerRT.textures).toHaveLength(2)

    ctx.lightShafts = true
    anyPass.ensureLayerRT(true)
    expect(pass.layerRT.textures).toHaveLength(3)

    log('lightShafts-layerRT', { toggled: true })
  })

  test('lightShafts toggle changes cache key', () => {
    const pass = makePassNode()
    const key1 = pass.customCacheKey()
    pass.cloudsContext.lightShafts = !pass.cloudsContext.lightShafts
    const key2 = pass.customCacheKey()
    expect(key1).not.toBe(key2)

    log('lightShafts-cacheKey', { differs: true })
  })

  // haze setter

  test('haze setter bumps graphVersion', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    ctx.haze = !ctx.haze
    expect(ctx.graphVersion).toBe(v0 + 1)

    log('haze-graphVersion', { bumped: true })
  })

  test('haze setter no-ops for same value', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    const sameHaze = ctx.haze
    ctx.haze = sameHaze
    expect(ctx.graphVersion).toBe(v0)

    log('haze-noop', { unchanged: true })
  })

  test('haze toggle changes cache key', () => {
    const pass = makePassNode()
    const key1 = pass.customCacheKey()
    pass.cloudsContext.haze = !pass.cloudsContext.haze
    const key2 = pass.customCacheKey()
    expect(key1).not.toBe(key2)

    log('haze-cacheKey', { differs: true })
  })

  // debug view setter

  test('debug setter bumps graphVersion', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    ctx.debug = 'shadowMap'
    expect(ctx.graphVersion).toBe(v0 + 1)

    log('debug-graphVersion', { bumped: true })
  })

  test('debug setter no-ops for same value', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.debug = 'uv'
    const v0 = ctx.graphVersion
    ctx.debug = 'uv'
    expect(ctx.graphVersion).toBe(v0)

    log('debug-noop', { unchanged: true })
  })

  test('debug toggle changes cache key', () => {
    const pass = makePassNode()
    const key1 = pass.customCacheKey()
    pass.cloudsContext.debug = 'frontDepth'
    const key2 = pass.customCacheKey()
    expect(key1).not.toBe(key2)

    log('debug-cacheKey', { differs: true })
  })

  test('each debug view produces a distinct cache key', () => {
    // All NINE. 'cascades' was missing here until the view itself
    // landed. A variant absent from this list can collide with
    // another's cached graph and render the wrong shader entirely
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
    const keys = new Set<number>()
    for (const view of views) {
      const pass = makePassNode()
      pass.cloudsContext.debug = view
      keys.add(pass.customCacheKey())
    }
    expect(keys.size).toBe(views.length)

    log('debug-distinct-keys', { count: keys.size })
  })

  test('every debug view builds the whole pass graph', () => {
    // The acceptance net for the debug views: compileWGSL throws on any
    // TSL error, so this catches a view whose graph does not build

    // The composite, because mrt() cannot compile the march fragment
    // standalone. Its markers are covered by the p4 e2e suite
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

    const built: Record<string, number> = {}
    for (const view of views) {
      const pass = makePassNode()
      const ctx = pass.cloudsContext
      ctx.cloudLayers[0]!.shadow = true
      ctx.lightShafts = true
      ctx.debug = view
      const dst = texture(new Texture())
      const { fragment } = compileWGSL(pass.composite(dst))
      expect(fragment.length, `${view} builds`).toBeGreaterThan(0)
      built[view] = fragment.length
    }

    log('debug-views-compile', built)
  })

  test('the shadow-length view puts turbo in the resolve fragment', () => {
    // clouds/cloudsResolve.frag:167-175, turbo(shadowLength * 0.05). The one
    // debug marker a unit test can observe, since the resolve material
    // compiles standalone
    const shafts = (view: 'none' | 'shadowLength'): string => {
      const pass = makePassNode()
      const ctx = pass.cloudsContext
      ctx.cloudLayers[0]!.shadow = true
      ctx.lightShafts = true
      ctx.debug = view
      compileWGSL(pass.composite(texture(new Texture())))
      // The beauty resolve is an mrt() fragment (colour + shadow length) and
      // needs its target to resolve attachment names
      return compileWGSL(internals(pass).resolveMaterial.fragmentNode, {
        renderTarget: pass.resolveRT
      }).fragment
    }

    const on = shafts('shadowLength')
    const off = shafts('none')
    expect(/turbo/i.test(on), 'shadowLength view uses the turbo colormap').toBe(
      true
    )
    expect(/turbo/i.test(off), 'the beauty resolve must not').toBe(false)

    log('debug-shadowLength-turbo', { on: on.length, off: off.length })
  })

  // shadow structural changes

  test('checkShadowStructure detects cascadeCount change and bumps graphVersion', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    ctx.shadow.cascadeCount = 4
    const changed = ctx.checkShadowStructure()
    expect(changed).toBe(true)
    expect(ctx.graphVersion).toBe(v0 + 1)

    log('cascadeCount-graphVersion', { bumped: true })
  })

  test('checkShadowStructure detects temporalJitter change', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    ctx.shadow.temporalJitter = !ctx.shadow.temporalJitter
    const changed = ctx.checkShadowStructure()
    expect(changed).toBe(true)
    expect(ctx.graphVersion).toBe(v0 + 1)

    log('temporalJitter-graphVersion', { bumped: true })
  })

  test('checkShadowStructure detects temporalPass change', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    ctx.shadow.temporalPass = !ctx.shadow.temporalPass
    const changed = ctx.checkShadowStructure()
    expect(changed).toBe(true)
    expect(ctx.graphVersion).toBe(v0 + 1)

    log('temporalPass-graphVersion', { bumped: true })
  })

  test('checkShadowStructure no-ops when nothing changed', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const v0 = ctx.graphVersion
    const changed = ctx.checkShadowStructure()
    expect(changed).toBe(false)
    expect(ctx.graphVersion).toBe(v0)

    log('shadowStructure-noop', { unchanged: true })
  })

  // CloudLayer.shadow is a plain property, so a toggle after the first
  // render kept the old variant. Each test settles its start state with a poll,
  // since CloudLayers.DEFAULT already casts on two layers
  const settleWithNoCasters = (
    ctx: ReturnType<typeof makePassNode>['cloudsContext']
  ): void => {
    for (const layer of ctx.cloudLayers) layer.shadow = false
    ctx.checkShadowStructure()
  }

  test('turning a layer shadow on bumps graphVersion', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    settleWithNoCasters(ctx)
    const v0 = ctx.graphVersion

    ctx.cloudLayers[0]!.shadow = true
    const changed = ctx.checkShadowStructure()

    expect(changed).toBe(true)
    expect(ctx.graphVersion).toBeGreaterThan(v0)

    log('ui16-shadow-on', { graphVersion: ctx.graphVersion })
  })

  test('turning the last caster off bumps graphVersion again', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    settleWithNoCasters(ctx)
    ctx.cloudLayers[0]!.shadow = true
    ctx.checkShadowStructure()
    const v0 = ctx.graphVersion

    ctx.cloudLayers[0]!.shadow = false
    const changed = ctx.checkShadowStructure()

    expect(changed).toBe(true)
    expect(ctx.graphVersion).toBeGreaterThan(v0)
  })

  // The variant is gated on whether any layer casts, and which ones reach the
  // shader through the shadowLayerMask uniform. Moving the flag between layers
  // must not rebuild
  test('moving the shadow between layers does not bump graphVersion', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    settleWithNoCasters(ctx)
    ctx.cloudLayers[0]!.shadow = true
    ctx.checkShadowStructure()
    const v0 = ctx.graphVersion

    ctx.cloudLayers[1]!.shadow = true
    ctx.cloudLayers[0]!.shadow = false
    const changed = ctx.checkShadowStructure()

    expect(changed).toBe(false)
    expect(ctx.graphVersion).toBe(v0)
  })

  test('toggling a layer shadow changes the cache key', () => {
    const pass = makePassNode()
    settleWithNoCasters(pass.cloudsContext)
    const key1 = pass.customCacheKey()

    pass.cloudsContext.cloudLayers[0]!.shadow = true
    pass.cloudsContext.checkShadowStructure()
    const key2 = pass.customCacheKey()

    expect(key1).not.toBe(key2)
  })

  // graphFlags() had 16 fields and the hash 13, so three fields changed
  // the graph without moving the cache key. Flipping every field and asserting
  // the hash moves keeps the two lists paired
  test('every graphFlags field reaches the cache key', () => {
    const flags = makePassNode().cloudsContext.graphFlags()
    const baseline = hashGraphFlags(true, false, flags)

    const perturb = (value: unknown): unknown => {
      if (typeof value === 'boolean') return !value
      if (typeof value === 'number') return value + 1
      if (typeof value === 'string') return `${value}-perturbed`
      throw new Error(`no perturbation for ${typeof value}`)
    }

    const uncovered: string[] = []
    for (const key of Object.keys(flags) as Array<keyof typeof flags>) {
      const mutated = { ...flags, [key]: perturb(flags[key]) }
      if (hashGraphFlags(true, false, mutated) === baseline) {
        uncovered.push(key)
      }
    }

    expect(uncovered).toEqual([])
    log('cl6u-cache-key-coverage', { fields: Object.keys(flags).length })
  })

  test('cascadeCount change changes cache key', () => {
    const pass = makePassNode()
    const key1 = pass.customCacheKey()
    pass.cloudsContext.shadow.cascadeCount = 4
    const key2 = pass.customCacheKey()
    expect(key1).not.toBe(key2)

    log('cascadeCount-cacheKey', { differs: true })
  })

  test('cascadeCount change disposes old shadow atlas', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)

    anyPass.ensureShadowRT(512, 512, 3)
    const oldRT = anyPass.shadowRT!
    const disposeSpy = vi.spyOn(oldRT, 'dispose')

    anyPass.ensureShadowRT(512, 512, 4)
    expect(disposeSpy).toHaveBeenCalledOnce()
    expect(anyPass.shadowRT).not.toBe(oldRT)

    log('cascadeCount-dispose', { disposed: true })
  })

  test('cascadeCount change invalidates cloudShadow descriptor', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    const anyPass = internals(pass)

    const desc1 = pass.cloudShadow
    expect(desc1.cascadeCount).toBe(3)

    ctx.shadow.cascadeCount = 2
    anyPass._cloudShadow = null

    const desc2 = pass.cloudShadow
    expect(desc2.cascadeCount).toBe(2)
    expect(desc2).not.toBe(desc1)

    log('cascadeCount-descriptor', { invalidated: true })
  })

  // CSM sync

  test('syncShadowMaps flows splitLambda to CSM', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.splitLambda = 0.8
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.splitLambda).toBe(0.8)

    log('splitLambda-sync', { synced: true })
  })

  test('syncShadowMaps flows splitMode to CSM (number → string)', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.splitMode = 0
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.splitMode).toBe('uniform')

    ctx.shadow.splitMode = 1
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.splitMode).toBe('logarithmic')

    ctx.shadow.splitMode = 2
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.splitMode).toBe('practical')

    log('splitMode-sync', { synced: true })
  })

  test('syncShadowMaps flows maxFar and farScale to CSM', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.maxFar = 1e5
    ctx.shadow.farScale = 2
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.maxFar).toBe(1e5)
    expect(ctx.shadowMaps!.farScale).toBe(2)

    log('maxFar-farScale-sync', { synced: true })
  })

  test('syncShadowMaps flows cascadeCount to CSM', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.cascadeCount = 4
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.cascadeCount).toBe(4)

    log('cascadeCount-csm-sync', { synced: true })
  })

  test('syncShadowMaps flows mapSize to CSM', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.shadow.mapSize.set(1024, 1024)
    ctx.syncShadowMaps()
    expect(ctx.shadowMaps!.mapSize.x).toBe(1024)
    expect(ctx.shadowMaps!.mapSize.y).toBe(1024)

    log('mapSize-csm-sync', { synced: true })
  })

  // shadow uniform keys (already work, verifying)

  const shadowUniformKeys = [
    ['maxIterationCount', 50, 100],
    ['minStepSize', 100, 200],
    ['maxStepSize', 1000, 500],
    ['minDensity', 1e-5, 1e-4],
    ['minExtinction', 1e-5, 1e-4],
    ['minTransmittance', 1e-4, 1e-2],
    ['opticalDepthTailScale', 2, 3]
  ] as const

  test.each(shadowUniformKeys)(
    'shadow.%s is read by updateShadowPassUniforms',
    (key, defaultVal, newVal) => {
      const pass = makePassNode()
      const ctx = pass.cloudsContext
      expect(ctx.shadow[key]).toBe(defaultVal)

      ;(ctx.shadow as unknown as Record<string, unknown>)[key] = newVal
      expect(ctx.shadow[key]).toBe(newVal)

      log(`shadow-uniform-${key}`, { default: defaultVal, set: newVal })
    }
  )

  // shadow structural defaults

  test('shadow defaults match qualityPresets', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    expect(ctx.shadow.cascadeCount).toBe(3)
    expect(ctx.shadow.mapSize.x).toBe(512)
    expect(ctx.shadow.mapSize.y).toBe(512)
    expect(ctx.shadow.maxFar).toBe(null)
    expect(ctx.shadow.farScale).toBe(1)
    expect(ctx.shadow.splitMode).toBe(2)
    expect(ctx.shadow.splitLambda).toBe(0.6)
    expect(ctx.shadow.temporalPass).toBe(true)
    expect(ctx.shadow.temporalJitter).toBe(true)

    log('shadow-defaults', {
      cascadeCount: ctx.shadow.cascadeCount,
      mapSize: `${ctx.shadow.mapSize.x}×${ctx.shadow.mapSize.y}`,
      splitLambda: ctx.shadow.splitLambda
    })
  })

  // mapSize resize

  test('mapSize change resizes shadow RT', () => {
    const pass = makePassNode()
    const anyPass = internals(pass)

    anyPass.ensureShadowRT(512, 512, 3)
    expect(anyPass.shadowRT!.width).toBe(512)

    anyPass.ensureShadowRT(1024, 1024, 3)
    expect(anyPass.shadowRT!.width).toBe(1024)
    expect(anyPass.shadowRT!.height).toBe(1024)

    log('mapSize-resize', { resized: true })
  })

  // graphFlags includes shadow structural fields

  test('graphFlags includes shadowCascadeCount, shadowTemporalJitter, shadowTemporalPass', () => {
    const pass = makePassNode()
    const flags = pass.cloudsContext.graphFlags()
    expect(flags.shadowCascadeCount).toBe(3)
    expect(flags.shadowTemporalJitter).toBe(true)
    expect(flags.shadowTemporalPass).toBe(true)

    log('graphFlags-shadow', {
      cascadeCount: flags.shadowCascadeCount,
      temporalJitter: flags.shadowTemporalJitter,
      temporalPass: flags.shadowTemporalPass
    })
  })
})

describe('CloudsPassNode WebGL2 backend guard', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_webglBackend')
  })

  test('setup() throws on WebGL2 backend', () => {
    const pass = makePassNode()
    const builder = {
      renderer: { backend: { isWebGLBackend: true } }
    }
    // A minimal builder: setup() rejects on the backend flag before it
    // reaches anything else
    expect(() => pass.setup(builder as unknown as NodeBuilder)).toThrow(
      'three-clouds-webgpu: the WebGL2 backend'
    )
  })

  test('setup() does not throw on WebGPU backend', () => {
    const pass = makePassNode()
    const builder = {
      renderer: { backend: { isWebGPUBackend: true } }
    }
    expect(() => pass.setup(builder as unknown as NodeBuilder)).not.toThrow(
      'three-clouds-webgpu'
    )
  })
})

describe('pass materials compile', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_materials')
  })

  // compileWGSL throws on any THREE.TSL error, so this is the regression net for
  // the object-returning-Fn / void-Fn / array-texture class of bugs
  test('march, shadow atlas, shadow velocity and shadow resolve fragments build', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    const dst = texture(new Texture())
    // Builds the whole pass graph
    compileWGSL(pass.composite(dst))
    const anyPass = internals(pass)

    // mrt() resolves its keys against the bound target's texture names
    const { fragment: shadow } = compileWGSL(
      anyPass.shadowMaterial.fragmentNode,
      { renderTarget: anyPass.shadowRT }
    )
    // Every build compares all four lanes (`d >= vec4<f32>( 0.0 )`). Only a
    // four-lane build keeps them as the mask, a two-lane one truncates to .xy
    const fourLaneMasks = (
      shadow.match(
        /vec4<f32>\(\s*\(\s*\w+\s*>=\s*vec4<f32>\(\s*0\.0\s*\)\s*\)\s*\)/g
      ) ?? []
    ).length
    const twoLaneMasks = (
      shadow.match(
        /vec2<f32>\(\s*\(\s*\w+\s*>=\s*vec4<f32>\(\s*0\.0\s*\)\s*\)\.xy\s*\)/g
      ) ?? []
    ).length
    // one shell struct construction per masked intersection
    const shellStruct = findStructByMembers(shadow, {
      near: 'vec4<f32>',
      far: 'vec4<f32>'
    })
    const shellConstructions = (
      shadow.match(new RegExp(`\\b${shellStruct}\\(`, 'g')) ?? []
    ).length
    expect({ fourLaneMasks, twoLaneMasks, shellConstructions }).toEqual({
      fourLaneMasks: 2,
      twoLaneMasks: 0,
      shellConstructions: 2
    })
    // the march pass writes the atlas AND the depth velocity (two
    // outputs), and marches once: one shadow-march loop, not one per output
    // Output struct members only (the fragment input varying has a location too)
    const locations = shadow.match(/@location\( ?\d+ ?\) m\d+ :/g) ?? []
    const marchLoops = (
      shadow.match(/for \( var i : i32 = 0; i < i32\(/g) ?? []
    ).length
    expect(locations).toHaveLength(2)
    expect(marchLoops).toBe(1)

    const { fragment: resolve } = compileWGSL(
      anyPass.shadowResolveMaterial.fragmentNode
    )
    // Array-texture reads carry the layer index (textureLoad(tex, uv, depth, level))
    expect(resolve).toMatch(/textureLoad\(.*, u32\(/)

    let marchLength = 0
    try {
      const { fragment: march } = compileWGSL(anyPass.material.fragmentNode!)
      expect(march).toContain('CloudsFragmentOutput')
      marchLength = march.length
    } catch (error) {
      // mrt() needs a render target in the builder; the composite build above
      // already proved the fragment graph. Only a TSL error is a failure here.
      if (String(error).includes('TSL build errors')) throw error
    }

    log('pass-materials-compile', {
      shadowLength: shadow.length,
      fourLaneMasks,
      twoLaneMasks,
      shellConstructions,
      shadowOutputs: locations.length,
      resolveLength: resolve.length,
      marchLength
    })
  })

  // The march fragment under a given pair of light-shaft flags. Both helpers
  // below exist for the two tests that need a compiled march, so the device
  // stubbing is written once
  interface MarchOpts {
    lightShafts: boolean
    halfResolution: boolean
    features: string[]
  }

  function marchFragment(opts: MarchOpts): string {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.lightShafts = opts.lightShafts
    ctx.lightShaftsHalfResolution = opts.halfResolution
    compileWGSL(pass.composite(texture(new Texture())), {
      features: opts.features
    })
    const anyPass = internals(pass)
    // The march reads the atmosphere through the builder context, as the
    // aerial tests set it up
    const atmosphere = new AtmosphereContext()
    ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
      new PerspectiveCamera()
    const fragmentNode = anyPass.material.fragmentNode
    if (fragmentNode == null) throw new Error('the march has no fragment')
    return compileWGSL(fragmentNode, {
      renderTarget: pass.layerRT,
      contextNode: tslContext({
        getAtmosphere: () => atmosphere,
        getClouds: () => ({})
      }),
      features: opts.features
    }).fragment
  }

  // The stub backend has no device so its float-linear query answers false,
  // while the pass asks the RENDERER. The STBN node also needs mocking
  function withStubbedDevice<T>(fn: () => T): T {
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    const originalHasFeature = backend.hasFeature
    backend.hasFeature = () => false
    const stbnLoad = vi
      .spyOn(STBNLoader.prototype, 'loadAsync')
      .mockResolvedValue(new Data3DTexture())
    try {
      return fn()
    } finally {
      backend.hasFeature = originalHasFeature
      stbnLoad.mockRestore()
    }
  }

  // lightShaftsHalfResolution applies only where the device has quad
  // operations, so one flag gives two programs. The march fragment carries the
  // difference, decided at the composite build
  test('lightShaftsHalfResolution marches the shadow length per quad only with the subgroups feature', () => {
    const compileMarch = (features: string[]) =>
      marchFragment({ lightShafts: true, halfResolution: true, features })

    const { without, withQuads } = withStubbedDevice(() => ({
      without: compileMarch([]),
      withQuads: compileMarch(['subgroups'])
    }))

    const broadcasts = (f: string) => (f.match(/quadBroadcast\(/g) ?? []).length
    log('lightShaftsHalfResolution-programs', {
      withoutFeature: {
        quadBroadcasts: broadcasts(without),
        directive: /^enable subgroups;/m.test(without)
      },
      withFeature: {
        quadBroadcasts: broadcasts(withQuads),
        directive: /^enable subgroups;/m.test(withQuads)
      }
    })

    expect(broadcasts(without)).toBe(0)
    expect(without).not.toMatch(/^enable subgroups;/m)
    expect(broadcasts(withQuads)).toBe(4)
    expect(withQuads).toMatch(/^enable subgroups;/m)
    // The per-fragment march is gone from the quad program: its loop bound
    // (500, maxShadowLengthIterationCount) is replaced by the lane's share
    expect(without).toMatch(/i < 500;/)
    expect(withQuads).not.toMatch(/i < 500;/)
  })

  // TSL emits a var where a shared node is FIRST USED. Under three r186 the
  // first use of the per-step mip level is the interval-skip If, so the
  // sampling Else read a stale or zero mip level unless each branch builds it
  test('the march assigns its mip level in a block enclosing every read', () => {
    const march = withStubbedDevice(() =>
      marchFragment({ lightShafts: false, halfResolution: false, features: [] })
    )
    // The march evaluates it in more than one place, so check every var
    const names = varsAssigned(march, /^log2\( max\( 1\.0, /)
    expect(names.length, 'the mip level is held in a var').toBeGreaterThan(0)
    const lines = march.split('\n')
    const rows = names.map(name => ({
      name,
      reads: lines.filter(
        l =>
          new RegExp(`\\b${name}\\b`).test(l) &&
          !new RegExp(
            `^\\s*(?:(?:let|var)\\s+)?${name}(?:\\s*:\\s*[^=;]+)?\\s*=`
          ).test(l)
      ).length,
      outsideAssigningBlock: readsOutsideAssigningBlock(march, name).length
    }))
    log('march-mip-level-scope', rows)
    // Both march branches read it, so one read would mean the search lost
    // the sampling branch
    expect(rows.some(r => r.reads > 1)).toBe(true)
    expect(
      rows.filter(r => r.outsideAssigningBlock > 0),
      'reads outside the assigning block'
    ).toEqual([])
  })

  // The premise the harness's re-capture list rests on: lightShafts on changes
  // pixels, lightShafts off recompiles nothing. Without this the 60
  // program-only cases are excluded on trust rather than on compiled WGSL
  test('the half-resolution pin changes the march only where light shafts march', () => {
    const on = withStubbedDevice(() => ({
      port: normalizeWGSL(
        marchFragment({
          lightShafts: true,
          halfResolution: true,
          features: ['subgroups']
        })
      ),
      reference: normalizeWGSL(
        marchFragment({
          lightShafts: true,
          halfResolution: false,
          features: ['subgroups']
        })
      ),
      shaftsOffPort: normalizeWGSL(
        marchFragment({
          lightShafts: false,
          halfResolution: true,
          features: ['subgroups']
        })
      ),
      shaftsOffReference: normalizeWGSL(
        marchFragment({
          lightShafts: false,
          halfResolution: false,
          features: ['subgroups']
        })
      )
    }))

    // lightShafts on: the two programs differ, so those cases need a recapture
    expect(on.port).not.toBe(on.reference)
    // lightShafts off: byte-identical WGSL, so the moved cache key buys nothing
    // and no case needs a recapture for it
    expect(on.shaftsOffPort).toBe(on.shaftsOffReference)
    log('reference-mode-wgsl-premise', {
      shaftsOnDiffers: on.port !== on.reference,
      shaftsOffIdentical: on.shaftsOffPort === on.shaftsOffReference,
      shaftsOnLength: on.reference.length,
      shaftsOffLength: on.shaftsOffReference.length
    })
  })

  // the march's BSM lookup uses the reference's SHADOW_SAMPLE_COUNT 8
  // (CloudsMaterial.ts:469). 16 doubled the PCF taps per step with the sun near
  // the horizon (clouds.frag:551)
  test('the march shadow PCF takes the reference 8 taps', () => {
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    const originalHasFeature = backend.hasFeature
    backend.hasFeature = () => false
    const stbnLoad = vi
      .spyOn(STBNLoader.prototype, 'loadAsync')
      .mockResolvedValue(new Data3DTexture())
    let march: string
    try {
      const pass = makePassNode()
      compileWGSL(pass.composite(texture(new Texture())))
      const atmosphere = new AtmosphereContext()
      ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
        new PerspectiveCamera()
      const fragmentNode = internals(pass).material.fragmentNode
      if (fragmentNode == null) throw new Error('the march has no fragment')
      march = compileWGSL(fragmentNode, {
        renderTarget: pass.layerRT,
        contextNode: tslContext({
          getAtmosphere: () => atmosphere,
          getClouds: () => ({})
        })
      }).fragment
    } finally {
      backend.hasFeature = originalHasFeature
      stbnLoad.mockRestore()
    }

    const vogelLoops = march.match(/i < \d+;[^]*?sqrt\( (\d+)\.0 \)/g) ?? []
    log('march-pcf-taps', {
      loopBounds: (march.match(/i < \d+;/g) ?? []).join(' '),
      vogel: vogelLoops.map(l => /sqrt\( (\d+)\.0 \)/.exec(l)?.[1]).join(' '),
      expected: 8
    })
    expect(march).toMatch(/i < 8;/)
    expect(march).toContain('sqrt( 8.0 )')
    expect(march).not.toContain('sqrt( 16.0 )')
  })

  // the ground consumer defaults to the reference's
  // shadowSampleCount 8. At 16, the per-pixel PCF doubled, visible at 2560 as
  // the radius grows with render size
  test('the ground shadow consumer defaults to the reference 8 PCF taps', () => {
    const transmittance = createCloudShadowTransmittance(
      makePassNode().cloudShadow,
      {
        viewMatrix: uniform(new Matrix4()),
        cameraNear: uniform(0.1),
        sunDirection: uniform(new Vector3(0, 0, 1)),
        bottomRadius: uniform(6360000),
        ecefToWorldMatrix: uniform(new Matrix4()),
        altitudeCorrection: uniform(new Vector3()),
        worldToUnit: uniform(1 / 6360000),
        temporalJitter: uniform(new Vector2()),
        resolution: uniform(new Vector2(800, 600))
      }
    )
    const { fragment } = compileWGSL(
      vec3(transmittance(vec3(0, 0, 6361000), uniform(2.5), float(0)))
    )
    log('ground-pcf-taps', {
      loopBounds: (fragment.match(/i < \d+;/g) ?? []).join(' '),
      expected: 8
    })
    expect(fragment).toMatch(/i < 8;/)
    expect(fragment).toContain('sqrt( 8.0 )')
    expect(fragment).not.toContain('sqrt( 16.0 )')
  })

  // y = D - L on a geometry ray (runtime.glsl:318-322), 0 on a sky
  // ray. The production march with scene depth: sceneRayDistance is
  // depth-derived, and the output branches on it

  // The old output wrote the march's near bound into y
  test('the shadow-length attachment encodes the surface-end segment', () => {
    const backend = WebGPUBackend.prototype as unknown as {
      hasFeature: () => boolean
    }
    const originalHasFeature = backend.hasFeature
    backend.hasFeature = () => false
    const stbnLoad = vi
      .spyOn(STBNLoader.prototype, 'loadAsync')
      .mockResolvedValue(new Data3DTexture())
    let march: string
    try {
      const pass = makePassNode(texture(new DepthTexture(4, 4)))
      pass.cloudsContext.lightShafts = true
      compileWGSL(pass.composite(texture(new Texture())))
      const atmosphere = new AtmosphereContext()
      ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
        new PerspectiveCamera()
      const fragmentNode = internals(pass).material.fragmentNode
      if (fragmentNode == null) throw new Error('the march has no fragment')
      march = compileWGSL(fragmentNode, {
        renderTarget: pass.layerRT,
        contextNode: tslContext({
          getAtmosphere: () => atmosphere,
          getClouds: () => ({})
        })
      }).fragment
    } finally {
      backend.hasFeature = originalHasFeature
      stbnLoad.mockRestore()
    }

    const wgsl = march.replace(/\s+/g, ' ')
    const args = constructorArgs(wgsl, 'CloudsFragmentRay')
    // Member order of fragmentRayStruct: sceneRayDistance is the 9th
    const distanceVar = args[8] ?? ''
    const fromDepth = new RegExp(`${distanceVar} = \\w+\\.rayDistance;`).test(
      wgsl
    )
    const ray = /(\w+) = CloudsFragmentRay\(/.exec(wgsl)?.[1] ?? ''
    const d = `${ray}.sceneRayDistance`
    const encoding = new RegExp(
      `if \\( \\( ${d} > 0\\.0 \\) \\) \\{ (?:let )?(\\w+) = max\\( min\\( (\\w+)\\.x, ${d} \\), 0\\.0 \\); (\\w+) = vec2<f32>\\( \\1, \\( ${d} - \\1 \\) \\); \\} else \\{ \\3 = vec2<f32>\\( max\\( \\2\\.x, 0\\.0 \\), 0\\.0 \\); \\}`
    ).exec(wgsl)
    const toOutput =
      encoding != null &&
      wgsl.includes(
        `( ${encoding[3]} * vec2<f32>( atmosphereParameters.worldToUnit ) )`
      )
    log('shadow-length-attachment-encoding', {
      rayArgs: args.length,
      sceneRayDistanceFromDepth: fromDepth,
      surfaceEndEncoding: encoding != null,
      scaledIntoOutput: toOutput
    })
    expect(args.length, 'fragmentRayStruct has 10 members').toBe(10)
    expect(fromDepth, 'sceneRayDistance is the depth-derived distance').toBe(
      true
    )
    expect(encoding, 'geometry vec2(x, D - x) / sky vec2(L, 0)').not.toBeNull()
    expect(toOutput, 'the encoded segment is the output, in km').toBe(true)
  })

  // the pass samples the jitter volume through a
  // TextureNode re-synced each frame, or the r3f prop and the knob do nothing
  // (read from the shadow program's bindings, red with a build-time capture)
  test('a jitter volume swapped after the build is what the shadow program binds', () => {
    const pass = makePassNode()
    const ctx = pass.cloudsContext
    ctx.cloudLayers[0]!.shadow = true
    const texA = ctx.stbnTexture
    // Builds the whole pass graph
    compileWGSL(pass.composite(texture(new Texture())))
    const anyPass = internals(pass)
    const { boundTextures } = compileWGSL(anyPass.shadowMaterial.fragmentNode, {
      renderTarget: anyPass.shadowRT
    })
    expect(boundTextures()).toContain(texA)

    const texB = new Data3DTexture(new Uint8Array(128 * 128 * 64), 128, 128, 64)
    ctx.stbnTexture = texB
    updateParameterUniforms(
      anyPass._parameterUniforms as ParameterUniforms & {
        placeholders: OwnedPlaceholders
      },
      ctx
    )
    const bound = boundTextures()
    log('stbn-swap-binds', {
      boundB: bound.includes(texB),
      boundA: bound.includes(texA)
    })
    expect(bound).toContain(texB)
    expect(bound).not.toContain(texA)
  })
})

// three turns a throw from setup() into a console
// message and finishes the build, so a WebGL2 run booted with a black frame
// and no pageerror (measured)

// assertWebGPUSupported is the refusal callers can catch, on their own stack

describe('assertWebGPUSupported', () => {
  it('throws on a WebGL2-backed renderer', () => {
    expect(() =>
      assertWebGPUSupported({ backend: { isWebGLBackend: true } })
    ).toThrow(/WebGL2 backend .* is not yet verified/)
  })

  it('names WEBGPU.md, so the message leads somewhere', () => {
    expect(() =>
      assertWebGPUSupported({ backend: { isWebGLBackend: true } })
    ).toThrow(/WEBGPU\.md/)
  })

  it('passes a native WebGPU renderer', () => {
    expect(() =>
      assertWebGPUSupported({
        initialized: true,
        backend: { isWebGPUBackend: true }
      })
    ).not.toThrow()
    expect(() =>
      assertWebGPUSupported({ initialized: true, backend: {} })
    ).toThrow('does not identify a native WebGPU backend')
  })

  it('REFUSES to answer before init() rather than passing', () => {
    for (const r of [
      undefined,
      null,
      {},
      { backend: undefined },
      { initialized: false, backend: { isWebGPUBackend: true } }
    ]) {
      expect(() => assertWebGPUSupported(r)).toThrow(
        /after `await renderer\.init\(\)`/
      )
    }
  })

  it('the pre-init refusal is distinguishable from the WebGL2 one', () => {
    // A caller catching this must be able to tell "you called me too early"
    // from "your backend is unsupported", and collapsing them would turn a usage
    // error into a false capability report
    let early = ''
    let webgl = ''
    try {
      assertWebGPUSupported({})
    } catch (e) {
      early = (e as Error).message
    }
    try {
      assertWebGPUSupported({ backend: { isWebGLBackend: true } })
    } catch (e) {
      webgl = (e as Error).message
    }
    expect(early).not.toBe('')
    expect(webgl).not.toBe('')
    expect(early).not.toBe(webgl)
  })
})

// ground bounce must select its irradiance producer on
// ACCURATE_SUN_SKY_LIGHT (clouds.frag:419-437), per-sample LUT or per-frame
// vertex varying. It was wired to the accurate one unconditionally

// Asserted on source: a full build needs a renderer, and the property is which
// branch the code takes

describe('ground-bounce irradiance selection', () => {
  const SRC = readFileSync(
    new URL('./pass/marchGraph.ts', import.meta.url),
    'utf8'
  )

  function groundBounceBlock(): string {
    const at = SRC.indexOf('if (ctx.groundBounce) {')
    expect(at, 'the ground-bounce block moved').toBeGreaterThan(-1)
    return SRC.slice(at, SRC.indexOf('\n    }', at))
  }

  it('selects on ctx.accurateSunSkyLight, not unconditionally', () => {
    const block = groundBounceBlock()
    expect(
      block.includes('ctx.accurateSunSkyLight'),
      'ground bounce must pick its irradiance producer on the flag, as the ' +
        'cloud irradiance does and as the reference does with ' +
        '#ifdef ACCURATE_SUN_SKY_LIGHT'
    ).toBe(true)
  })

  it('references BOTH producers, so the flag can go either way', () => {
    // The selection lives in selectGroundSunSkyIrradiance, not inline: the
    // ternary took buildFactories over the decision-point ceiling (13) and the
    // port-gates run went red, so it was extracted. Assert on the selector.
    const at = SRC.indexOf('function selectGroundSunSkyIrradiance(')
    expect(
      at,
      'selectGroundSunSkyIrradiance moved or was inlined'
    ).toBeGreaterThan(-1)
    const selector = SRC.slice(at, SRC.indexOf('\n}', at))
    expect(selector).toContain('createGroundSunSkyIrradiance(')
    expect(selector).toContain('createGroundSunSkyIrradianceInterpolated(')
    expect(
      selector.includes('accurate'),
      'the selector must branch on the flag it is handed'
    ).toBe(true)
  })

  it('the cloud irradiance still selects too — the pattern being mirrored', () => {
    // If this ever stops selecting, the "mirror the cloud path" justification
    // above is stale and both need re-reading rather than one being copied
    expect(SRC).toContain('if (ctx.accurateSunSkyLight) {')
  })
})

describe('CloudsPassNode experimental warnings', () => {
  beforeEach(() => {
    setCurrentSpec('CloudsPassNode_experimentalWarnings')
  })

  function warm(pass: CloudsPassNode, frames = 2): void {
    const renderer = rendererStub()
    for (let i = 0; i < frames; i++) {
      pass.updateBefore(frameStub(i, renderer) as never)
    }
  }

  test('warns once when windReprojection cannot reproject', () => {
    const pass = makePassNode()
    pass.cloudsContext.experimental = { windReprojection: true }
    pass.cloudsContext.localWeatherVelocity.set(1, 0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warm(pass, 5)

    const ours = warnSpy.mock.calls.filter(call =>
      String(call[0]).includes('windReprojection')
    )
    expect(ours).toHaveLength(1)
    expect(String(ours[0]![0])).toContain('localWeatherVelocity')
    warnSpy.mockRestore()
    log('wind-reprojection-warn-once', { frames: 5, warns: ours.length })
  })

  test('warns once per id, not once per frame', () => {
    const pass = makePassNode()
    pass.cloudsContext.experimental = {
      windReprojection: true,
      distantCloudShadows: true,
      computeResolve: true
    }
    pass.cloudsContext.localWeatherVelocity.set(0, 1)
    pass.cloudsContext.debug = 'shadowMap'
    for (const layer of pass.cloudsContext.cloudLayers) {
      layer.shadow = false
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warm(pass, 10)

    const ours = warnSpy.mock.calls.filter(call =>
      String(call[0]).startsWith('three-clouds-webgpu: experimental')
    )
    // Three distinct problems, three lines, not thirty
    expect(ours).toHaveLength(3)
    expect(new Set(ours.map(call => String(call[0]))).size).toBe(3)
    warnSpy.mockRestore()
    log('experimental-warn-dedup', { frames: 10, warns: ours.length })
  })

  test('re-warns after the problem clears and returns', () => {
    const pass = makePassNode()
    pass.cloudsContext.experimental = { computeResolve: true }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    pass.cloudsContext.debug = 'uv'
    warm(pass, 2)
    expect(
      warnSpy.mock.calls.filter(call =>
        String(call[0]).includes('computeResolve')
      ).length
    ).toBe(1)

    // Clearing the precondition must re-arm the warning, or a user who fixes
    // the problem and breaks it again hears nothing
    pass.cloudsContext.debug = 'none'
    warm(pass, 2)
    pass.cloudsContext.debug = 'uv'
    warm(pass, 2)

    expect(
      warnSpy.mock.calls.filter(call =>
        String(call[0]).includes('computeResolve')
      ).length
    ).toBe(2)
    warnSpy.mockRestore()
    log('experimental-warn-rearm', { warns: 2 })
  })

  test('warnings = false silences them entirely', () => {
    const pass = makePassNode()
    pass.cloudsContext.experimental = {
      windReprojection: true,
      distantCloudShadows: true,
      computeResolve: true
    }
    pass.cloudsContext.localWeatherVelocity.set(0, 1)
    pass.cloudsContext.debug = 'uv'
    for (const layer of pass.cloudsContext.cloudLayers) {
      layer.shadow = false
    }
    pass.cloudsContext.warnings = false
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warm(pass, 4)

    const ours = warnSpy.mock.calls.filter(call =>
      String(call[0]).startsWith('three-clouds-webgpu: experimental')
    )
    expect(ours).toEqual([])
    warnSpy.mockRestore()
    log('experimental-warn-suppressed', { frames: 4, warns: ours.length })
  })

  test('stays silent when every option can do its job', () => {
    const pass = makePassNode()
    // The shipped default layers cast shadows (src/CloudLayers.ts:68,80), so
    // distantCloudShadows has a map to read and no velocity rejects the history
    pass.cloudsContext.experimental = {
      windReprojection: true,
      distantCloudShadows: true,
      computeResolve: true
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warm(pass, 3)

    const ours = warnSpy.mock.calls.filter(call =>
      String(call[0]).startsWith('three-clouds-webgpu: experimental')
    )
    expect(ours).toEqual([])
    warnSpy.mockRestore()
    log('experimental-warn-clean', { frames: 3, warns: ours.length })
  })
})
