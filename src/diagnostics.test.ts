import {
  Data3DTexture,
  DataArrayTexture,
  DataTexture,
  DepthTexture,
  PerspectiveCamera,
  Texture
} from 'three'
import { texture } from 'three/tsl'
import { WebGPURenderer } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { log } from '../test/helpers/log'
import { CloudsContext, getCloudsContext } from './CloudsContext'
import { assertWebGPUSupported, clouds } from './CloudsPassNode'
import { inspectCloudsSetup } from './diagnostics'
import { experimentalWarnings } from './experimental/options'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const pass = clouds({ sceneDepth: null })
  pass.camera = new PerspectiveCamera()
  const context = pass.cloudsContext
  context.sunDirection.set(1, 0, 0)
  context.localWeatherTexture = new DataTexture(new Uint8Array(16), 2, 2)
  context.shapeTexture = new Data3DTexture(new Uint8Array(8), 2, 2, 2)
  context.shapeDetail = false
  context.turbulence = false
  const atmosphere = new AtmosphereContext()
  atmosphere.camera = pass.camera
  atmosphere.sunDirectionECEF.value.copy(context.sunDirection)
  const renderer = {
    initialized: true,
    backend: { isWebGPUBackend: true },
    contextNode: {
      value: {
        getClouds: (): unknown => context,
        getAtmosphere: (): unknown => atmosphere
      }
    }
  }
  const inspect = (depthMode: 'scene' | 'sky-only' = 'sky-only') =>
    inspectCloudsSetup({ renderer, pass, atmosphere, depthMode })
  cleanups.push(() => {
    pass.dispose()
    context.dispose()
    atmosphere.dispose()
  })
  return { pass, context, atmosphere, renderer, inspect }
}

describe('structured cloud setup inspection', () => {
  it('accepts explicit sky-only and optional textures without allocating jitter', () => {
    const { context, inspect } = fixture()
    const version = context.graphVersion
    expect(context.resolvedStbnTexture).toBeNull()
    const result = inspect()
    log('sky-only setup', { ...result })
    expect(result.diagnostics).toEqual([])
    expect(result.readiness).toEqual({
      configuration: 'valid',
      assets: 'ready',
      graph: 'unobserved',
      frame: 'unobserved'
    })
    expect(context.resolvedStbnTexture).toBeNull()
    expect(context.graphVersion).toBe(version)
  })

  it('distinguishes missing depth from deliberate no-depth operation', () => {
    const { pass, inspect } = fixture()
    const result = inspect('scene')
    log('scene depth', { ...result })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'depth.missing',
        path: 'pass.sceneDepth',
        severity: 'error',
        observed: null
      })
    )
    pass.sceneDepth = texture(new DepthTexture(2, 2))
    expect(inspect('scene').readiness.configuration).toBe('valid')
  })

  it('does not report unknown or uninitialized backends as ready', () => {
    const { renderer, inspect } = fixture()
    renderer.initialized = false
    expect(inspect().diagnostics[0]?.code).toBe('backend.not-initialized')
    renderer.initialized = true
    renderer.backend.isWebGPUBackend = false
    const result = inspect()
    log('unknown backend', { ...result })
    expect(result.diagnostics[0]?.code).toBe('backend.unknown')
    expect(result.readiness.configuration).toBe('invalid')
    expect(() => assertWebGPUSupported(renderer)).toThrow('native WebGPU')
  })

  it('does not silently treat an omitted depth policy as sky-only', () => {
    const { renderer, pass } = fixture()
    const result = inspectCloudsSetup({ renderer, pass } as never)
    log('explicit depth policy', { ...result })
    expect(result.diagnostics.map(item => item.code)).toContain(
      'depth.mode-invalid'
    )
  })

  it.each([null, undefined, {}])(
    'reports invalid atmosphere provider value %s',
    value => {
      const { renderer, inspect } = fixture()
      renderer.contextNode.value.getAtmosphere = () => value
      const result = inspect()
      log('invalid atmosphere provider', { ...result })
      expect(result.diagnostics.map(item => item.code)).toContain(
        'provider.atmosphere-invalid'
      )
    }
  )

  it('rejects a real renderer before initialization despite its existing backend', () => {
    const renderer = new WebGPURenderer({
      canvas: {
        width: 1,
        height: 1,
        addEventListener() {}
      } as unknown as HTMLCanvasElement
    })
    log('real pre-init renderer', {
      initialized: renderer.initialized,
      backendPresent: renderer.backend != null
    })
    expect(renderer.backend).toBeDefined()
    expect(renderer.initialized).toBe(false)
    expect(() => assertWebGPUSupported(renderer)).toThrow(
      'await renderer.init()'
    )
  })

  it('reports missing, throwing and wrong-identity providers without throwing', () => {
    const { renderer, inspect } = fixture()
    renderer.contextNode.value.getClouds = () => undefined
    renderer.contextNode.value.getAtmosphere = () => {
      throw new Error('provider failed')
    }
    const result = inspect()
    log('provider problems', { ...result })
    expect(result.diagnostics.map(item => item.code)).toContain(
      'provider.clouds-mismatch'
    )
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'provider.threw',
        observed: 'provider failed'
      })
    )
    Reflect.deleteProperty(renderer.contextNode.value, 'getAtmosphere')
    expect(inspect().diagnostics.map(item => item.code)).toContain(
      'provider.missing'
    )
  })

  it('detects distinct CloudsContext constructors, not different legitimate instances', async () => {
    const { renderer, inspect } = fixture()
    vi.resetModules()
    const other = await import('./CloudsContext')
    expect(other.CloudsContext).not.toBe(CloudsContext)
    const foreign = new other.CloudsContext()
    renderer.contextNode.value.getClouds = () => foreign
    const result = inspect()
    log('duplicate constructor', { ...result })
    expect(result.diagnostics.map(item => item.code)).toContain(
      'provider.duplicate-clouds'
    )
    expect(() => getCloudsContext({ getClouds: () => foreign })).toThrow(
      'two copies'
    )
    renderer.contextNode.value.getClouds = () => new CloudsContext()
    expect(inspect().diagnostics.map(item => item.code)).toContain(
      'provider.clouds-mismatch'
    )
  })

  it('reports camera and finite celestial-direction failures', () => {
    const { pass, context, atmosphere, inspect } = fixture()
    pass.camera = null
    context.sunDirection.set(0, 0, 0)
    context.experimental = { moonlight: true }
    context.moonDirection.set(NaN, 1, 0)
    atmosphere.sunDirectionECEF.value.set(0, Infinity, 0)
    const result = inspect()
    log('camera and directions', { ...result })
    expect(
      result.diagnostics.filter(item => item.code === 'direction.invalid')
    ).toHaveLength(3)
    expect(result.diagnostics.map(item => item.code)).toContain(
      'camera.missing'
    )
    expect(result.diagnostics.map(item => item.code)).toContain(
      'camera.atmosphere-mismatch'
    )
  })

  it('separates pending assets from invalid configuration', () => {
    const { context, inspect } = fixture()
    context.shapeTexture = null
    context.localWeatherTexture = new Texture()
    const result = inspect()
    log('pending assets', { ...result })
    expect(result.readiness.configuration).toBe('valid')
    expect(result.readiness.assets).toBe('not-ready')
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'asset.not-loaded',
      'asset.missing'
    ])
    context.enabled = false
    expect(inspect().readiness.assets).toBe('ready')
  })

  it('rejects wrong dimensional slots and malformed cached jitter', () => {
    const { context, inspect } = fixture()
    context.localWeatherTexture = new DataArrayTexture(
      new Uint8Array(4),
      1,
      1,
      1
    )
    context.shapeTexture = new Texture() as Data3DTexture
    context.stbnTexture = new Data3DTexture(new Uint8Array(), 0, 1, 1)
    const result = inspect()
    log('slot dimensions', { ...result })
    expect(
      result.diagnostics.filter(item => item.code === 'asset.wrong-dimension')
    ).toHaveLength(2)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'pass.cloudsContext.stbnTexture',
        code: 'asset.not-loaded'
      })
    )
    expect(result.readiness.configuration).toBe('invalid')
  })

  it('waits for image completion even when width and height are set', () => {
    const { context, inspect } = fixture()
    context.localWeatherTexture = new Texture({
      width: 2,
      height: 2,
      complete: false
    })
    const result = inspect()
    log('pending image', { ...result })
    expect(result.readiness.assets).toBe('not-ready')
    expect(result.diagnostics.map(item => item.code)).toContain(
      'asset.not-loaded'
    )
  })

  it('accepts supplied procedural slots without rendering generators', () => {
    const { context, inspect } = fixture()
    const render = vi.fn()
    context.localWeatherTexture = {
      texture: new DataTexture(new Uint8Array(4), 1, 1),
      size: 1,
      needsRender: true,
      render,
      dispose: vi.fn()
    }
    log('procedural readiness', { ...inspect() })
    expect(inspect().readiness.assets).toBe('ready')
    expect(render).not.toHaveBeenCalled()
  })

  it('reports malformed layer arrays before reading their derived properties', () => {
    const { context, inspect } = fixture()
    context.cloudLayers.length = 3
    const result = inspect()
    log('layer slots', { ...result })
    expect(result.diagnostics.map(item => item.code)).toContain(
      'layers.invalid-slots'
    )
    expect(result.readiness.configuration).toBe('invalid')
  })

  it('reports invalid weather channels by slot', () => {
    const { context, inspect } = fixture()
    context.cloudLayers[2]!.channel = 'x' as never
    const result = inspect()
    log('weather channel', { ...result })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'layers.invalid-channel',
        path: 'pass.cloudsContext.cloudLayers[2].channel',
        observed: 'x'
      })
    )
  })

  it('reuses the existing feature-warning data independently of console suppression', () => {
    const { context, inspect } = fixture()
    context.warnings = false
    context.experimental = { rainShafts: true }
    context.lightShafts = false
    const warnings = experimentalWarnings({
      experimental: context.experimental,
      debug: context.debug,
      castsShadow: context.cloudLayers.castsShadow,
      localWeatherVelocity: context.localWeatherVelocity,
      lightShafts: context.lightShafts
    })
    const result = inspect()
    log('feature prerequisites', { ...result })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'feature.rainShafts/noLightShafts',
        message: warnings[0]?.message,
        severity: 'warning'
      })
    )
  })
})
