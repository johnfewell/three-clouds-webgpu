import {
  Data3DTexture,
  DataTexture,
  DepthTexture,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3
} from 'three'
import {
  mrt,
  normalView,
  output,
  pass as scenePassNode,
  texture,
  context as tslContext,
  vec4
} from 'three/tsl'
import {
  WebGPUBackend,
  type RenderPipeline,
  type WebGPURenderer
} from 'three/webgpu'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { AtmosphereContext, SkyNode } from '@takram/three-atmosphere/webgpu'

import { compileWGSL } from '../test/helpers/compileWGSL'
import { log } from '../test/helpers/log'
import { clouds, CloudsPassNode } from './CloudsPassNode'
import {
  createCloudsIntegration,
  type CloudsIntegrationOptions,
  type CloudsIntegrationTextures
} from './integration'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

function fixture() {
  const renderer = {
    initialized: true,
    backend: { isWebGPUBackend: true },
    contextNode: tslContext({ host: 'preserved' })
  } as unknown as WebGPURenderer
  const camera = new PerspectiveCamera(50, 1, 100, 1e8)
  camera.position.set(0, 6378137 + 2500, 0)
  camera.lookAt(10000, 6378137 + 4000, 0)
  camera.updateMatrixWorld()
  const atmosphere = new AtmosphereContext()
  atmosphere.raymarchScattering = false
  const scenePass = scenePassNode(new Scene(), camera)
  scenePass.setMRT(mrt({ output, normal: normalView }))
  const textures: CloudsIntegrationTextures = {
    localWeatherTexture: new DataTexture(new Uint8Array(16), 2, 2),
    turbulenceTexture: new DataTexture(new Uint8Array(16), 2, 2),
    shapeTexture: new Data3DTexture(new Uint8Array(8), 2, 2, 2),
    shapeDetailTexture: new Data3DTexture(new Uint8Array(8), 2, 2, 2)
  }
  const options: CloudsIntegrationOptions = {
    renderer,
    camera,
    atmosphere,
    scenePass,
    textures,
    lighting: 'post',
    sunDirection: new Vector3(1, 1, 0).normalize()
  }
  cleanups.push(() => {
    atmosphere.dispose()
    scenePass.dispose()
    for (const value of Object.values(textures)) value?.dispose()
  })
  const create = (overrides: Partial<CloudsIntegrationOptions> = {}) => {
    const integration = createCloudsIntegration({ ...options, ...overrides })
    cleanups.push(() => integration.dispose())
    return integration
  }
  const borrowed = () => {
    const value = clouds({ sceneDepth: null })
    cleanups.push(() => {
      value.dispose()
      value.cloudsContext.dispose()
    })
    return value
  }
  return { ...options, camera, options, create, borrowed }
}

describe('explicit cloud integration', () => {
  it('refuses an orthographic camera before depth lookup or provider installation', () => {
    expectTypeOf<
      CloudsIntegrationOptions['camera']
    >().toEqualTypeOf<PerspectiveCamera>()
    const { create, renderer, scenePass } = fixture()
    const original = renderer.contextNode
    const getDepth = vi.spyOn(scenePass, 'getTextureNode')
    expect(() => create({ camera: new OrthographicCamera() as never })).toThrow(
      'Supply a PerspectiveCamera'
    )
    expect(getDepth).not.toHaveBeenCalled()
    expect(renderer.contextNode).toBe(original)
    log('perspective-only preflight', {
      depthLookups: getDepth.mock.calls.length
    })
  })

  it.each(['post', 'lights'] as const)(
    'compiles the %s composition with an explicit scene camera',
    lighting => {
      const { create, renderer } = fixture()
      const integration = create({ lighting })
      const sky = integration.aerial.skyNode as SkyNode
      sky.showStars = false
      sky.showMoon = false
      const backend = WebGPUBackend.prototype as unknown as {
        hasFeature(): boolean
      }
      vi.spyOn(backend, 'hasFeature').mockReturnValue(false)
      const result = compileWGSL(integration.output, {
        contextNode: renderer.contextNode
      })
      expect(result.fragment.length).toBeGreaterThan(100)
      expect(result.fragment).toContain('@fragment')
      log('helper WGSL', {
        lighting,
        fragmentCharacters: result.fragment.length
      })
    }
  )

  it('composes one new pass with a pipeline-compatible output and live diagnostics', () => {
    const { create, scenePass, atmosphere, renderer } = fixture()
    const integration = create()
    const pipelineOutput: RenderPipeline['outputNode'] = integration.output
    expect(pipelineOutput).toBe(integration.output)
    expect(integration.pass.sceneDepth).toBe(scenePass.getTextureNode('depth'))
    expect(integration.context).toBe(integration.pass.cloudsContext)
    expect(integration.pass.hasComposite).toBe(true)
    expect(integration.pass.composite(integration.aerial)).toBe(
      integration.output
    )
    expect(integration.aerial.lighting).toBe(true)
    expect(atmosphere.camera).toBe(integration.pass.camera)
    const inspection = integration.diagnostics()
    log('helper setup', { ...inspection })
    expect(inspection.readiness).toEqual({
      configuration: 'valid',
      assets: 'ready',
      graph: 'unobserved',
      frame: 'unobserved'
    })
    expect(inspection.diagnostics).toEqual([])
    integration.context.sunDirection.setScalar(0)
    expect(integration.diagnostics().readiness.configuration).toBe('invalid')
    const providers = renderer.contextNode.value as Record<string, unknown>
    expect(providers.host).toBe('preserved')
  })

  it('borrows exactly the supplied pass and its lazy jitter in lights mode', () => {
    const { create, borrowed, scenePass, camera } = fixture()
    const pass = borrowed()
    pass.cloudsContext.sunDirection.set(1, 0, 0)
    const sceneChildren = [...scenePass.scene.children]
    const integration = create({
      cloudsPass: pass,
      sunDirection: undefined,
      lighting: 'lights'
    })
    expect(integration.pass).toBe(pass)
    expect(integration.aerial.lighting).toBe(false)
    expect(integration.aerial.normalNode).toBeUndefined()
    expect(pass.camera).toBe(camera)
    expect(pass.cloudsContext.resolvedStbnTexture).toBeNull()
    expect(scenePass.scene.children).toEqual(sceneChildren)
    log('borrowed pass', {
      samePass: integration.pass === pass,
      lighting: integration.aerial.lighting
    })
  })

  it('rejects a pre-init or unknown backend before constructing a pass', () => {
    const { create, renderer } = fixture()
    const dispose = vi.spyOn(CloudsPassNode.prototype, 'dispose')
    Object.defineProperty(renderer, 'initialized', {
      value: false,
      configurable: true
    })
    expect(() => create()).toThrow('await renderer.init()')
    Object.defineProperty(renderer, 'initialized', { value: true })
    Object.defineProperty(renderer, 'backend', { value: {} })
    expect(() => create()).toThrow('native WebGPU')
    expect(dispose).not.toHaveBeenCalled()
    log('backend preflight', { disposedPasses: dispose.mock.calls.length })
  })

  it('rejects invalid lighting, missing MRT, sun and depth/camera identity before provider installation', () => {
    const { create, renderer, scenePass, borrowed } = fixture()
    const original = renderer.contextNode
    expect(() => create({ lighting: 'both' as never })).toThrow(
      'Choose lighting'
    )
    expect(() => create({ atmosphere: {} as never })).toThrow(
      'same atmosphere package'
    )
    expect(() => create({ sunDirection: undefined })).toThrow(
      'Supply sunDirection'
    )
    expect(() => create({ sunDirection: new Vector3() })).toThrow(
      'finite nonzero'
    )
    expect(() =>
      create({ worldToECEFMatrix: new Matrix4().makeScale(0, 1, 1) })
    ).toThrow('invertible')
    scenePass.setMRT(null)
    expect(() => create()).toThrow('normalView')
    scenePass.setMRT(mrt({ output, normal: normalView }))
    expect(() => create({ camera: new PerspectiveCamera() })).toThrow(
      'camera identity'
    )
    const pass = borrowed()
    pass.sceneDepth = texture(new DepthTexture(1, 1))
    expect(() => create({ cloudsPass: pass })).toThrow('different depth')
    expect(renderer.contextNode).toBe(original)
    log('input preflight', {
      unchangedProviders: renderer.contextNode === original
    })
  })

  it('rejects precomposited passes without allocating another cached destination', () => {
    const { create, borrowed } = fixture()
    const pass = borrowed()
    expect(pass.hasComposite).toBe(false)
    const destinationNode = vec4(1)
    const destination = pass.composite(destinationNode)
    expect(pass.hasComposite).toBe(true)
    expect(() => create({ cloudsPass: pass })).toThrow('cached composite')
    expect(pass.composite(destinationNode)).toBe(destination)
    destination.dispose()
    expect(pass.hasComposite).toBe(false)
    const integration = create({ cloudsPass: pass })
    expect(pass.composite(integration.aerial)).toBe(integration.output)
    log('manual composite guard', { hasComposite: pass.hasComposite })
  })

  it('rolls back borrowed fields and disposes only new resources on invalid assets', () => {
    const { create, borrowed, textures, renderer, atmosphere } = fixture()
    const pass = borrowed()
    const oldSun = pass.cloudsContext.sunDirection.clone()
    const oldWorld = pass.cloudsContext.worldToECEFMatrix.clone()
    const original = renderer.contextNode
    const disposed = vi.spyOn(pass, 'dispose')
    const textureDispose = vi.spyOn(textures.shapeTexture!, 'dispose')
    expect(() =>
      create({
        cloudsPass: pass,
        textures: { ...textures, localWeatherTexture: null }
      })
    ).toThrow('asset.missing')
    expect(pass.camera).toBeNull()
    expect(pass.sceneDepth).toBeNull()
    expect(pass.cloudsContext.shapeTexture).toBeNull()
    expect(pass.cloudsContext.sunDirection.equals(oldSun)).toBe(true)
    expect(pass.cloudsContext.worldToECEFMatrix.equals(oldWorld)).toBe(true)
    expect(atmosphere.camera).toBeUndefined()
    expect(renderer.contextNode).toBe(original)
    expect(disposed).not.toHaveBeenCalled()
    expect(textureDispose).not.toHaveBeenCalled()
    const newPassDispose = vi.spyOn(CloudsPassNode.prototype, 'dispose')
    expect(() =>
      create({ textures: { ...textures, shapeTexture: null } })
    ).toThrow('asset.missing')
    expect(newPassDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).not.toHaveBeenCalled()
    expect(create({ cloudsPass: pass }).pass).toBe(pass)
    log('asset rollback', {
      borrowedDisposals: disposed.mock.calls.length,
      newDisposals: newPassDispose.mock.calls.length
    })
  })

  it('cleans a late construction failure and releases leases for retry', () => {
    const { create, borrowed, renderer, scenePass, atmosphere } = fixture()
    const pass = borrowed()
    const original = renderer.contextNode
    const getTextureNode = scenePass.getTextureNode.bind(scenePass)
    const getNode = vi
      .spyOn(scenePass, 'getTextureNode')
      .mockImplementation(name => {
        if (name === 'output') throw new Error('late graph failure')
        return getTextureNode(name)
      })
    expect(() => create({ cloudsPass: pass })).toThrow('late graph failure')
    expect(renderer.contextNode).toBe(original)
    expect(pass.camera).toBeNull()
    expect(atmosphere.camera).toBeUndefined()
    getNode.mockRestore()
    expect(create({ cloudsPass: pass }).pass).toBe(pass)
    log('late failure rollback', { reusedPass: true })
  })

  it('limits ownership to one live helper per renderer and per pass', () => {
    const first = fixture()
    const second = fixture()
    const pass = first.borrowed()
    const integration = first.create({ cloudsPass: pass })
    const original = first.renderer.contextNode
    expect(() => first.create()).toThrow('renderer already')
    expect(() => second.create({ cloudsPass: pass })).toThrow('pass already')
    expect(first.renderer.contextNode).toBe(original)
    const other = second.create()
    expect(other.pass).not.toBe(pass)
    other.dispose()
    integration.dispose()
    expect(first.create({ cloudsPass: pass }).pass).toBe(pass)
    log('single ownership', { separateRenderers: true, sequentialReuse: true })
  })

  it('restores prior providers and context node when the host leaves them unchanged', () => {
    const { create, renderer } = fixture()
    const getClouds = () => 'prior-clouds'
    const getAtmosphere = () => 'prior-atmosphere'
    const original = tslContext({ getClouds, getAtmosphere, extra: 42 })
    renderer.contextNode = original
    const integration = create()
    expect(renderer.contextNode).not.toBe(original)
    integration.dispose()
    expect(renderer.contextNode).toBe(original)
    expect(renderer.contextNode.value).toEqual({
      getClouds,
      getAtmosphere,
      extra: 42
    })
    log('provider restoration', { sameNode: renderer.contextNode === original })
  })

  it('preserves host edits and removes only its own providers, even after a context-node replacement', () => {
    const { create, renderer } = fixture()
    const integration = create()
    const hostClouds = () => 'new-host-clouds'
    renderer.contextNode = tslContext({
      ...(renderer.contextNode.value as Record<string, unknown>),
      getClouds: hostClouds,
      extra: 'after-setup'
    })
    const changed = renderer.contextNode
    integration.dispose()
    expect(renderer.contextNode).toBe(changed)
    expect(renderer.contextNode.value).toEqual({
      host: 'preserved',
      getClouds: hostClouds,
      extra: 'after-setup'
    })
    log('host provider edits', { preserved: renderer.contextNode === changed })
  })

  it.each(['null', 'undefined', 'replacement'] as const)(
    'releases owned resources when the host changes the context node to %s',
    replacement => {
      const { create, renderer, textures, atmosphere, scenePass } = fixture()
      const integration = create()
      const ownedDisposals = [
        vi.spyOn(integration.pass, 'dispose'),
        vi.spyOn(integration.context, 'dispose'),
        vi.spyOn(integration.context.stbnTexture, 'dispose'),
        vi.spyOn(integration.output, 'dispose'),
        vi.spyOn(integration.aerial, 'dispose')
      ]
      const borrowedDisposals = [
        ...Object.values(textures).map(value => vi.spyOn(value!, 'dispose')),
        vi.spyOn(atmosphere, 'dispose'),
        vi.spyOn(scenePass, 'dispose')
      ]
      const changed =
        replacement === 'null'
          ? null
          : replacement === 'undefined'
            ? undefined
            : tslContext({ host: 'replacement' })
      Reflect.set(renderer, 'contextNode', changed)
      expect(() => integration.dispose()).not.toThrow()
      integration.dispose()
      expect(renderer.contextNode).toBe(changed)
      expect(integration.pass.hasComposite).toBe(false)
      for (const dispose of ownedDisposals)
        expect(dispose).toHaveBeenCalledTimes(1)
      for (const dispose of borrowedDisposals)
        expect(dispose).not.toHaveBeenCalled()
      renderer.contextNode = tslContext({ host: 'restored' })
      expect(create().pass).not.toBe(integration.pass)
      log('host context replacement disposal', {
        replacement,
        owned: ownedDisposals.map(dispose => dispose.mock.calls.length),
        borrowed: borrowedDisposals.map(dispose => dispose.mock.calls.length),
        reusableRenderer: true
      })
    }
  )

  it('disposes a created pass and generated jitter once, preserving supplied and replacement textures', () => {
    const { create, textures, atmosphere, scenePass, renderer } = fixture()
    const integration = create()
    const passDispose = vi.spyOn(integration.pass, 'dispose')
    const contextDispose = vi.spyOn(integration.context, 'dispose')
    const originalJitter = integration.context.stbnTexture
    const jitterDispose = vi.spyOn(originalJitter, 'dispose')
    const textureDisposals = Object.values(textures).map(value =>
      vi.spyOn(value!, 'dispose')
    )
    const atmoDispose = vi.spyOn(atmosphere, 'dispose')
    const sceneDispose = vi.spyOn(scenePass, 'dispose')
    const replacement = new Texture()
    const replacementJitter = new Data3DTexture(new Uint8Array(1), 1, 1, 1)
    const replacementDispose = vi.spyOn(replacement, 'dispose')
    const replacementJitterDispose = vi.spyOn(replacementJitter, 'dispose')
    integration.context.localWeatherTexture = replacement
    integration.context.stbnTexture = replacementJitter
    integration.dispose()
    integration.dispose()
    expect(passDispose).toHaveBeenCalledTimes(1)
    expect(contextDispose).toHaveBeenCalledTimes(1)
    expect(jitterDispose).toHaveBeenCalledTimes(1)
    for (const spy of [
      ...textureDisposals,
      replacementDispose,
      replacementJitterDispose,
      atmoDispose,
      sceneDispose
    ])
      expect(spy).not.toHaveBeenCalled()
    expect(renderer.contextNode.value).toEqual({ host: 'preserved' })
    expect(integration.context.localWeatherTexture).toBeNull()
    log('created-resource disposal', {
      pass: passDispose.mock.calls.length,
      jitter: jitterDispose.mock.calls.length
    })
  })

  it('owns every regenerated jitter after supplied and generated slot replacements', () => {
    const { create, textures } = fixture()
    const supplied = new Data3DTexture(new Uint8Array(1), 1, 1, 1)
    const suppliedDispose = vi.spyOn(supplied, 'dispose')
    cleanups.push(() => supplied.dispose())
    const integration = create({
      textures: { ...textures, stbnTexture: supplied }
    })
    expect(integration.context.stbnTexture).toBe(supplied)
    const generatedDisposals = []
    for (let index = 0; index < 3; index++) {
      integration.context.stbnTexture = null
      const generated = integration.context.stbnTexture
      generatedDisposals.push(vi.spyOn(generated, 'dispose'))
      integration.context.stbnTexture = supplied
    }
    integration.dispose()
    integration.dispose()
    for (const disposed of generatedDisposals)
      expect(disposed).toHaveBeenCalledTimes(1)
    expect(suppliedDispose).not.toHaveBeenCalled()
    log('regenerated integration jitter', {
      generated: generatedDisposals.map(disposed => disposed.mock.calls.length),
      supplied: suppliedDispose.mock.calls.length
    })
  })

  it('leaves regenerated jitter on a borrowed pass to its context owner', () => {
    const { create, borrowed } = fixture()
    const pass = borrowed()
    const integration = create({ cloudsPass: pass })
    const first = integration.context.stbnTexture
    const firstDispose = vi.spyOn(first, 'dispose')
    integration.context.stbnTexture = null
    const second = integration.context.stbnTexture
    const secondDispose = vi.spyOn(second, 'dispose')
    integration.dispose()
    expect(firstDispose).not.toHaveBeenCalled()
    expect(secondDispose).not.toHaveBeenCalled()
    pass.cloudsContext.dispose()
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).toHaveBeenCalledTimes(1)
    log('borrowed generated jitter', {
      firstOwnedDisposal: firstDispose.mock.calls.length,
      secondOwnedDisposal: secondDispose.mock.calls.length
    })
  })

  it('preserves symbol-valued host additions to the installed provider context', () => {
    const { create, renderer } = fixture()
    const original = renderer.contextNode
    const integration = create()
    const installed = renderer.contextNode
    const hostKey = Symbol('host')
    Reflect.set(installed.value as object, hostKey, 42)
    integration.dispose()
    expect(renderer.contextNode).toBe(installed)
    expect(renderer.contextNode).not.toBe(original)
    expect(Reflect.get(renderer.contextNode.value as object, hostKey)).toBe(42)
    log('symbol host context', { preserved: true })
  })

  it('never disposes a borrowed pass/context or supplied jitter and permits StrictMode-style reuse', () => {
    const { create, borrowed, textures, renderer } = fixture()
    const pass = borrowed()
    const jitter = new Data3DTexture(new Uint8Array(1), 1, 1, 1)
    const passDispose = vi.spyOn(pass, 'dispose')
    const contextDispose = vi.spyOn(pass.cloudsContext, 'dispose')
    const jitterDispose = vi.spyOn(jitter, 'dispose')
    const first = create({
      cloudsPass: pass,
      textures: { ...textures, stbnTexture: jitter }
    })
    first.update({ time: 123, frame: 456 })
    const outputDispose = vi.spyOn(first.output, 'dispose')
    Reflect.set(renderer, 'contextNode', null)
    expect(() => first.dispose()).not.toThrow()
    first.dispose()
    expect(renderer.contextNode).toBeNull()
    expect(outputDispose).toHaveBeenCalledTimes(1)
    expect(pass.hasComposite).toBe(false)
    renderer.contextNode = tslContext({ host: 'restored' })
    const second = create({ cloudsPass: pass })
    expect(second.output).not.toBe(first.output)
    expect(pass.hasComposite).toBe(true)
    expect(second.context.time).toBe(123)
    expect(second.context.frame).toBe(456)
    expect(second.context.resolvedStbnTexture).toBe(jitter)
    second.dispose()
    expect(pass.hasComposite).toBe(false)
    for (const spy of [passDispose, contextDispose, jitterDispose])
      expect(spy).not.toHaveBeenCalled()
    log('borrowed resource disposal', {
      pass: passDispose.mock.calls.length,
      context: contextDispose.mock.calls.length
    })
  })

  it('preserves a host replacement sky node while releasing its originally created sky', () => {
    const { create } = fixture()
    const integration = create()
    const originalSky = integration.aerial.skyNode!
    const originalDispose = vi.spyOn(originalSky, 'dispose')
    expect(originalSky).toBeInstanceOf(SkyNode)
    const ownedStars = (originalSky as SkyNode).starsNode
    const starsDispose = vi.spyOn(ownedStars, 'dispose')
    const replacement = fixture().create().aerial.skyNode!
    const replacementDispose = vi.spyOn(replacement, 'dispose')
    integration.aerial.skyNode = replacement
    integration.dispose()
    expect(originalDispose).toHaveBeenCalledTimes(1)
    expect(starsDispose).toHaveBeenCalledTimes(1)
    expect(replacementDispose).not.toHaveBeenCalled()
    log('sky ownership', {
      owned: originalDispose.mock.calls.length,
      borrowed: replacementDispose.mock.calls.length
    })
  })

  it('updates one authoritative context and synchronizes changing world/sun/moon inputs', () => {
    const { create, camera, atmosphere } = fixture()
    const integration = create()
    const world = new Matrix4().makeTranslation(10, 20, 30)
    const sun = new Vector3(0, 1, 0)
    const moon = new Vector3(0, 0, 1)
    camera.position.x += 25
    camera.fov = 65
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    integration.update({
      time: -5,
      frame: 7,
      worldToECEFMatrix: world,
      sunDirection: sun,
      moonDirection: moon
    })
    expect(integration.context.time).toBe(-5)
    expect(integration.context.frame).toBe(7)
    expect(atmosphere.camera).toBe(camera)
    expect(atmosphere.matrixWorldToECEF.value.equals(world)).toBe(true)
    expect(atmosphere.sunDirectionECEF.value.equals(sun)).toBe(true)
    expect(atmosphere.moonDirectionECEF.value.equals(moon)).toBe(true)
    integration.context.worldToECEFMatrix.makeTranslation(40, 50, 60)
    integration.context.sunDirection.set(1, 0, 0)
    integration.context.shadow.mapSize.set(32, 64)
    integration.update({ time: 10, frame: 8 })
    expect(
      atmosphere.matrixWorldToECEF.value.equals(
        integration.context.worldToECEFMatrix
      )
    ).toBe(true)
    expect(
      atmosphere.sunDirectionECEF.value.equals(integration.context.sunDirection)
    ).toBe(true)
    expect(integration.context.shadow.mapSize.toArray()).toEqual([32, 64])
    log('live updates', {
      time: integration.context.time,
      frame: integration.context.frame,
      sun: atmosphere.sunDirectionECEF.value.toArray()
    })
  })

  it('disposes captured sky children rather than host replacements', () => {
    const { create } = fixture()
    const integration = create()
    const sky = integration.aerial.skyNode as SkyNode
    const originalStars = sky.starsNode
    const originalDispose = vi.spyOn(originalStars, 'dispose')
    const borrowedSky = fixture().create().aerial.skyNode as SkyNode
    const borrowedDispose = vi.spyOn(borrowedSky.starsNode, 'dispose')
    sky.starsNode = borrowedSky.starsNode
    integration.dispose()
    expect(originalDispose).toHaveBeenCalledOnce()
    expect(borrowedDispose).not.toHaveBeenCalled()
    log('sky child ownership', {
      owned: originalDispose.mock.calls.length,
      borrowed: borrowedDispose.mock.calls.length
    })
  })

  it('borrows procedural resources without rendering or disposing them during setup/cleanup', () => {
    const { create, textures } = fixture()
    const generator = {
      texture: new DataTexture(new Uint8Array(4), 1, 1),
      size: 1,
      needsRender: true,
      render: vi.fn(),
      dispose: vi.fn()
    }
    const textureDispose = vi.spyOn(generator.texture, 'dispose')
    const integration = create({
      textures: { ...textures, localWeatherTexture: generator }
    })
    expect(integration.diagnostics().readiness.assets).toBe('ready')
    integration.dispose()
    expect(generator.render).not.toHaveBeenCalled()
    expect(generator.dispose).not.toHaveBeenCalled()
    expect(textureDispose).not.toHaveBeenCalled()
    log('procedural ownership', {
      renders: generator.render.mock.calls.length,
      disposals: generator.dispose.mock.calls.length
    })
  })

  it('does not let later option-object edits hide a changed camera identity', () => {
    const { options, camera } = fixture()
    const integration = createCloudsIntegration(options)
    cleanups.push(() => integration.dispose())
    options.camera = new PerspectiveCamera()
    integration.update({ time: 0, frame: 0 })
    expect(integration.pass.camera).toBe(camera)
    options.scenePass.camera = options.camera
    integration.pass.camera = options.camera
    options.atmosphere.camera = options.camera
    expect(() => integration.update({ time: 0, frame: 0 })).toThrow(
      'Dispose and rebuild'
    )
    log('captured configuration identity', { originalCamera: camera.uuid })
  })

  it('rejects invalid update values transactionally and delegates resetHistory', () => {
    const { create } = fixture()
    const integration = create()
    integration.update({ time: 3, frame: 4 })
    expect(() => integration.update({ time: NaN, frame: 5 })).toThrow(
      'finite time'
    )
    expect(() => integration.update({ time: 0, frame: -1 })).toThrow(
      'nonnegative integer'
    )
    expect(() =>
      integration.update({ time: 0, frame: 0, sunDirection: new Vector3() })
    ).toThrow('nonzero')
    expect(() =>
      integration.update({
        time: 0,
        frame: 0,
        worldToECEFMatrix: new Matrix4().makeScale(1e200, 1e200, 1e200)
      })
    ).toThrow('finite and invertible')
    expect(integration.context.time).toBe(3)
    expect(integration.context.frame).toBe(4)
    const reset = vi.spyOn(integration.pass, 'resetHistory')
    integration.resetHistory()
    expect(reset).toHaveBeenCalledOnce()
    integration.dispose()
    expect(() => integration.update({ time: 0, frame: 0 })).toThrow('disposed')
    expect(() => integration.diagnostics()).toThrow('disposed')
    log('explicit time and history', { resetCalls: reset.mock.calls.length })
  })

  it('refuses camera and depth identity replacement rather than silently freezing stale nodes', () => {
    const { create, camera, scenePass, atmosphere } = fixture()
    const integration = create()
    scenePass.camera = new PerspectiveCamera()
    expect(() => integration.update({ time: 0, frame: 0 })).toThrow(
      'Dispose and rebuild'
    )
    scenePass.camera = camera
    atmosphere.camera = new PerspectiveCamera()
    expect(() => integration.update({ time: 0, frame: 0 })).toThrow(
      'Dispose and rebuild'
    )
    atmosphere.camera = camera
    integration.pass.sceneDepth = texture(new DepthTexture(1, 1))
    expect(() => integration.update({ time: 0, frame: 0 })).toThrow(
      'Dispose and rebuild'
    )
    integration.pass.sceneDepth = scenePass.getTextureNode('depth')
    expect(() => integration.update({ time: 0, frame: 0 })).not.toThrow()
    log('identity guard', { restored: true })
  })
})
