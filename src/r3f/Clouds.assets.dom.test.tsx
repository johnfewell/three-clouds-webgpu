// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { StrictMode } from 'react'
import {
  Data3DTexture,
  NearestFilter,
  PerspectiveCamera,
  Texture,
  TextureLoader
} from 'three'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  STBN_TEXTURE_DEPTH,
  STBN_TEXTURE_HEIGHT,
  STBN_TEXTURE_WIDTH
} from '@takram/three-geospatial'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { CloudsPassNode } from '../CloudsPassNode'
import { CloudTextureLoadError } from '../textures/loadBakedCloudTextures'
import {
  Clouds,
  useClouds,
  type CloudsPassContextValue,
  type CloudsProps
} from './Clouds'

const camera = new PerspectiveCamera()
vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { camera: PerspectiveCamera }) => unknown) =>
    selector({ camera })
}))

const borrowed = {
  localWeatherTexture: new Texture(),
  shapeTexture: new Data3DTexture(),
  shapeDetailTexture: new Data3DTexture(),
  turbulenceTexture: new Texture(),
  stbnTexture: new Data3DTexture()
}

interface ImageRequest {
  url: string
  texture: Texture
  complete: () => void
  fail: (cause: unknown) => void
}

const images: ImageRequest[] = []
let captured: CloudsPassContextValue
const snapshots: Array<{
  status: CloudsPassContextValue['assets']['status']
  enabled: boolean
  renderingEnabled: boolean
  weather: unknown
  stbn: Data3DTexture | null
}> = []

function Probe() {
  captured = useClouds()
  snapshots.push({
    status: captured.assets.status,
    enabled: captured.context.enabled,
    renderingEnabled: captured.pass.renderingEnabled,
    weather: captured.context.localWeatherTexture,
    stbn: captured.context.resolvedStbnTexture
  })
  return null
}

function view(props: Partial<CloudsProps> = {}) {
  return (
    <Clouds sceneDepth={null} {...borrowed} {...props}>
      <Probe />
    </Clouds>
  )
}

async function settle(change: () => void): Promise<void> {
  await act(async () => {
    change()
    await Promise.resolve()
  })
}

beforeEach(() => {
  setCurrentSpec('r3f_asset_lifecycle')
  images.length = 0
  snapshots.length = 0
  vi.spyOn(TextureLoader.prototype, 'load').mockImplementation(
    (url, onLoad, _progress, onError) => {
      const texture = new Texture<HTMLImageElement>()
      images.push({
        url,
        texture,
        complete: () => onLoad?.(texture),
        fail: cause => onError?.(cause)
      })
      return texture
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([false, true])(
  'omitted jitter is ready in the first descendant render without allocation (StrictMode: %s)',
  strict => {
    const children = view({ stbnTexture: undefined })
    const mounted = render(
      strict ? <StrictMode>{children}</StrictMode> : children
    )
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        status: 'ready',
        enabled: true,
        renderingEnabled: true,
        stbn: null
      })
    }
    const generated = captured.context.stbnTexture
    mounted.rerender(
      strict ? (
        <StrictMode>{view({ stbnTexture: undefined, frame: 1 })}</StrictMode>
      ) : (
        view({ stbnTexture: undefined, frame: 1 })
      )
    )
    expect(captured.context.resolvedStbnTexture).toBe(generated)
    mounted.unmount()
    log('lazy-jitter-first-render', {
      strict,
      ready: true,
      allocationBeforeRead: false
    })
  }
)

test.each([false, true])(
  'imperative enabled intent written during loading survives completion (%s)',
  async enabled => {
    const mounted = render(view({ localWeatherTexture: '/intent.png' }))
    captured.context.enabled = enabled
    mounted.rerender(view({ localWeatherTexture: '/intent.png', frame: 1 }))
    expect(captured.context.enabled).toBe(enabled)
    expect(captured.pass.renderingEnabled).toBe(false)
    await settle(() => images[0]!.complete())
    expect(captured.context.enabled).toBe(enabled)
    expect(captured.pass.renderingEnabled).toBe(enabled)
    mounted.unmount()
    log('loading-intent', { enabled, preserved: true })
  }
)

test.each([false, true])(
  'each owned context and generated jitter are disposed once (StrictMode: %s)',
  strict => {
    const contexts = vi.spyOn(CloudsContext.prototype, 'dispose')
    const passes = vi.spyOn(CloudsPassNode.prototype, 'dispose')
    const textures = vi.spyOn(Texture.prototype, 'dispose')
    const children = view({
      localWeatherTexture: '/pending.png',
      stbnTexture: undefined
    })
    const mounted = render(
      strict ? <StrictMode>{children}</StrictMode> : children
    )
    const context = captured.context
    const first = context.stbnTexture
    context.stbnTexture = null
    const second = context.stbnTexture
    context.stbnTexture = borrowed.stbnTexture
    mounted.unmount()
    expect(passes).toHaveBeenCalledTimes(strict ? 2 : 1)
    expect(contexts).toHaveBeenCalledTimes(passes.mock.calls.length)
    for (const pass of passes.mock.contexts as CloudsPassNode[]) {
      expect(
        contexts.mock.contexts.filter(value => value === pass.cloudsContext)
      ).toHaveLength(1)
    }
    for (const texture of [first, second]) {
      expect(
        textures.mock.contexts.filter(value => value === texture)
      ).toHaveLength(1)
    }
    for (const texture of Object.values(borrowed)) {
      expect(textures.mock.contexts).not.toContain(texture)
    }
    log('owned-context-disposal', {
      strict,
      generatedDisposedOnce: 2,
      borrowedDisposed: 0
    })
  }
)

test.each([false, true])(
  'imperative enabled intent written during an error survives retry (%s)',
  async enabled => {
    const mounted = render(view({ localWeatherTexture: '/intent-error.png' }))
    await settle(() => images[0]!.fail(new Error('missing')))
    expect(captured.assets.status).toBe('error')
    captured.context.enabled = enabled
    mounted.rerender(
      view({ localWeatherTexture: '/intent-error.png', frame: 1 })
    )
    expect(captured.context.enabled).toBe(enabled)
    expect(captured.pass.renderingEnabled).toBe(false)
    mounted.rerender(view({ localWeatherTexture: '/retry-intent.png' }))
    await settle(() => images[1]!.complete())
    expect(captured.context.enabled).toBe(enabled)
    expect(captured.pass.renderingEnabled).toBe(enabled)
    mounted.unmount()
    log('error-intent', { enabled, preserved: true })
  }
)

test('URL loading is observable and keeps the pass disabled until CPU completion', async () => {
  const mounted = render(view({ localWeatherTexture: '/weather.png' }))
  const pass = captured.pass
  expect(captured.assets).toEqual({ status: 'loading', error: null })
  expect(captured.context.enabled).toBe(true)
  expect(captured.pass.renderingEnabled).toBe(false)
  expect(captured.context.localWeatherTexture).toBeNull()
  await settle(() => images[0]!.complete())
  expect(captured.pass).toBe(pass)
  expect(captured.assets).toEqual({ status: 'ready', error: null })
  expect(captured.context.enabled).toBe(true)
  expect(captured.pass.renderingEnabled).toBe(true)
  expect(captured.context.localWeatherTexture).toBe(images[0]!.texture)
  mounted.unmount()
  log('asset-status', {
    loadingDisabled: true,
    readyEnabled: true,
    samePass: true
  })
})

test('imperative disabling survives unrelated rerenders and an asset reload', async () => {
  const mounted = render(view())
  captured.context.enabled = false
  mounted.rerender(view({ coverage: 0.42 }))
  expect(captured.context.enabled).toBe(false)
  mounted.rerender(view({ localWeatherTexture: '/replacement.png' }))
  expect(captured.assets.status).toBe('loading')
  expect(captured.context.enabled).toBe(false)
  await settle(() => images[0]!.complete())
  expect(captured.assets.status).toBe('ready')
  expect(captured.context.enabled).toBe(false)
  captured.context.enabled = true
  mounted.rerender(view({ localWeatherTexture: '/replacement.png', frame: 2 }))
  expect(captured.context.enabled).toBe(true)
  mounted.unmount()
  log('imperative-enabled', {
    survivesRerender: true,
    survivesAssetReload: true,
    canEnableAgain: true
  })
})

test('explicit enabled props override imperative state but never bypass asset loading', async () => {
  const mounted = render(view({ enabled: true }))
  captured.context.enabled = false
  mounted.rerender(view({ enabled: true, frame: 1 }))
  expect(captured.context.enabled).toBe(true)
  mounted.rerender(
    view({ enabled: true, localWeatherTexture: '/controlled.png' })
  )
  expect(captured.context.enabled).toBe(true)
  expect(captured.pass.renderingEnabled).toBe(false)
  mounted.rerender(
    view({ enabled: false, localWeatherTexture: '/controlled.png' })
  )
  await settle(() => images[0]!.complete())
  expect(captured.assets.status).toBe('ready')
  expect(captured.context.enabled).toBe(false)
  mounted.rerender(view({ localWeatherTexture: '/controlled.png' }))
  expect(captured.context.enabled).toBe(false)
  mounted.rerender(
    view({ enabled: true, localWeatherTexture: '/controlled.png' })
  )
  expect(captured.context.enabled).toBe(true)
  mounted.unmount()
  log('controlled-enabled', {
    explicitPropWins: true,
    loadingGateWins: true,
    removedPropRetainsState: true
  })
})

test('URL replacements never publish late old results and dispose owned textures once', async () => {
  const disposal = vi.spyOn(Texture.prototype, 'dispose')
  const mounted = render(view({ localWeatherTexture: '/first.png' }))
  mounted.rerender(view({ localWeatherTexture: '/second.png' }))
  await settle(() => images[1]!.complete())
  expect(captured.context.localWeatherTexture).toBe(images[1]!.texture)
  await settle(() => images[0]!.complete())
  expect(captured.context.localWeatherTexture).toBe(images[1]!.texture)
  expect(
    disposal.mock.contexts.filter(texture => texture === images[0]!.texture)
  ).toHaveLength(1)
  mounted.rerender(view())
  expect(captured.context.localWeatherTexture).toBe(
    borrowed.localWeatherTexture
  )
  expect(
    disposal.mock.contexts.filter(texture => texture === images[1]!.texture)
  ).toHaveLength(1)
  mounted.unmount()
  expect(disposal.mock.contexts).not.toContain(borrowed.localWeatherTexture)
  log('url-replacement', {
    staleIgnored: true,
    ownedDisposed: 2,
    borrowedDisposed: 0
  })
})

test.each([false, true])(
  'returning from a borrowed object to the same URL is loading in every render (StrictMode: %s)',
  async strict => {
    const disposal = vi.spyOn(Texture.prototype, 'dispose')
    const renderView = (props: Partial<CloudsProps> = {}) =>
      strict ? <StrictMode>{view(props)}</StrictMode> : view(props)
    const mounted = render(renderView({ localWeatherTexture: '/same.png' }))
    await settle(() => images.forEach(request => request.complete()))
    const previous = captured.context.localWeatherTexture
    expect(captured.assets.status).toBe('ready')
    mounted.rerender(renderView())
    expect(captured.context.localWeatherTexture).toBe(
      borrowed.localWeatherTexture
    )
    expect(
      disposal.mock.contexts.filter(texture => texture === previous)
    ).toHaveLength(1)
    snapshots.length = 0
    mounted.rerender(renderView({ localWeatherTexture: '/same.png' }))
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        status: 'loading',
        enabled: true,
        renderingEnabled: false,
        weather: null
      })
    }
    await settle(() => images.at(-1)!.complete())
    const replacement = captured.context.localWeatherTexture
    expect(captured.assets.status).toBe('ready')
    expect(replacement).not.toBe(previous)
    mounted.unmount()
    for (const texture of [previous, replacement]) {
      expect(
        disposal.mock.contexts.filter(disposed => disposed === texture)
      ).toHaveLength(1)
    }
    expect(disposal.mock.contexts).not.toContain(borrowed.localWeatherTexture)
    log('same-url-render-readiness', {
      strict,
      staleReadyRenders: 0,
      ownedDisposedOnce: true
    })
  }
)

test.each([false, true])(
  'removing a borrowed jitter override never renders a disposed fallback (StrictMode: %s)',
  strict => {
    const disposal = vi.spyOn(Data3DTexture.prototype, 'dispose')
    const renderView = (props: Partial<CloudsProps> = {}) =>
      strict ? <StrictMode>{view(props)}</StrictMode> : view(props)
    const mounted = render(renderView({ stbnTexture: undefined }))
    expect(captured.context.resolvedStbnTexture).toBeNull()
    const previous = captured.context.stbnTexture
    mounted.rerender(renderView())
    expect(captured.context.resolvedStbnTexture).toBe(borrowed.stbnTexture)
    expect(
      disposal.mock.contexts.filter(texture => texture === previous)
    ).toHaveLength(0)
    snapshots.length = 0
    mounted.rerender(renderView({ stbnTexture: undefined }))
    expect(snapshots[0]).toMatchObject({
      status: 'ready',
      enabled: true,
      renderingEnabled: true,
      stbn: null
    })
    expect(snapshots.every(snapshot => snapshot.stbn !== previous)).toBe(true)
    const replacement = captured.context.stbnTexture
    expect(captured.assets.status).toBe('ready')
    expect(replacement).not.toBe(previous)
    expect(replacement).not.toBe(borrowed.stbnTexture)
    mounted.unmount()
    for (const texture of [previous, replacement]) {
      expect(
        disposal.mock.contexts.filter(disposed => disposed === texture)
      ).toHaveLength(1)
    }
    expect(disposal.mock.contexts).not.toContain(borrowed.stbnTexture)
    log('fallback-render-readiness', {
      strict,
      staleReadyRenders: 0,
      borrowedDisposed: false
    })
  }
)

test('a failed asset exposes its error, disables clouds and recovers on URL change', async () => {
  const mounted = render(view({ localWeatherTexture: '/bad.png' }))
  await settle(() => images[0]!.fail(new Error('missing image')))
  expect(captured.assets.status).toBe('error')
  expect(captured.assets.error).toBeInstanceOf(CloudTextureLoadError)
  expect(captured.assets.error).toMatchObject({
    asset: 'localWeather',
    url: '/bad.png'
  })
  expect(captured.context.enabled).toBe(true)
  expect(captured.pass.renderingEnabled).toBe(false)
  mounted.rerender(view({ localWeatherTexture: '/good.png', enabled: false }))
  expect(captured.assets.status).toBe('loading')
  await settle(() => images[1]!.complete())
  expect(captured.assets.status).toBe('ready')
  expect(captured.context.enabled).toBe(false)
  log('asset-error-recovery', {
    observable: true,
    recovered: true,
    callerDisabled: true
  })
})

test('retrying the same URL after a borrowed object never renders the retired error', async () => {
  const mounted = render(view({ localWeatherTexture: '/retry.png' }))
  await settle(() => images[0]!.fail(new Error('first request failed')))
  expect(captured.assets.status).toBe('error')
  mounted.rerender(view())
  snapshots.length = 0
  mounted.rerender(view({ localWeatherTexture: '/retry.png' }))
  expect(snapshots.length).toBeGreaterThan(0)
  expect(snapshots.every(snapshot => snapshot.status === 'loading')).toBe(true)
  await settle(() => images[1]!.complete())
  expect(captured.assets).toEqual({ status: 'ready', error: null })
  mounted.unmount()
  log('same-url-error-retry', { retiredErrorRenders: 0, recovered: true })
})

test.each([false, true])(
  'cancelled same-URL requests cannot publish into a later lease (StrictMode: %s)',
  async strict => {
    const disposal = vi.spyOn(Texture.prototype, 'dispose')
    const renderView = (props: Partial<CloudsProps> = {}) =>
      strict ? <StrictMode>{view(props)}</StrictMode> : view(props)
    const mounted = render(renderView({ localWeatherTexture: '/delayed.png' }))
    const cancelled = [...images]
    mounted.rerender(renderView())
    snapshots.length = 0
    mounted.rerender(renderView({ localWeatherTexture: '/delayed.png' }))
    await settle(() => cancelled.forEach(request => request.complete()))
    expect(captured.assets.status).toBe('loading')
    expect(captured.context.localWeatherTexture).toBeNull()
    expect(snapshots.every(snapshot => snapshot.status === 'loading')).toBe(
      true
    )
    await settle(() => images.at(-1)!.complete())
    expect(captured.assets.status).toBe('ready')
    expect(captured.context.localWeatherTexture).toBe(images.at(-1)!.texture)
    mounted.unmount()
    for (const request of images) {
      expect(
        disposal.mock.contexts.filter(texture => texture === request.texture)
      ).toHaveLength(1)
    }
    expect(disposal.mock.contexts).not.toContain(borrowed.localWeatherTexture)
    log('cancelled-same-url', {
      strict,
      stalePublished: false,
      borrowedDisposed: false
    })
  }
)

test.each([false, true])(
  'removing a pending jitter URL aborts it and keeps the generated replacement (StrictMode: %s)',
  async strict => {
    const requests: Array<{ signal: AbortSignal; complete: () => void }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>(resolve => {
            requests.push({
              signal: options.signal!,
              complete: () =>
                resolve(
                  new Response(
                    new Uint8Array(
                      STBN_TEXTURE_WIDTH *
                        STBN_TEXTURE_HEIGHT *
                        STBN_TEXTURE_DEPTH
                    )
                  )
                )
            })
          })
      )
    )
    const renderView = (props: Partial<CloudsProps>) =>
      strict ? <StrictMode>{view(props)}</StrictMode> : view(props)
    const mounted = render(renderView({ stbnTexture: '/delayed-jitter.bin' }))
    expect(requests.length).toBe(strict ? 2 : 1)
    expect(requests.at(-1)!.signal.aborted).toBe(false)
    snapshots.length = 0
    mounted.rerender(renderView({ stbnTexture: undefined }))
    expect(snapshots[0]).toMatchObject({
      status: 'ready',
      enabled: true,
      renderingEnabled: true,
      stbn: null
    })
    expect(requests.every(request => request.signal.aborted)).toBe(true)
    const generated = captured.context.stbnTexture
    expect(captured.assets.status).toBe('ready')
    await settle(() => requests.forEach(request => request.complete()))
    expect(captured.context.resolvedStbnTexture).toBe(generated)
    expect(captured.assets).toEqual({ status: 'ready', error: null })
    expect(requests.length).toBe(strict ? 2 : 1)
    mounted.unmount()
    log('jitter-url-removal', {
      strict,
      cancelled: requests.length,
      fallbackRetained: true
    })
  }
)

test.each(['shapeTexture', 'shapeDetailTexture', 'stbnTexture'] as const)(
  '%s URL validates bytes and reports malformed HTTP-200 payloads',
  async property => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>missing</html>')))
    )
    await settle(() => {
      render(view({ [property]: '/missing.bin' }))
    })
    expect(captured.assets.status).toBe('error')
    expect(captured.assets.error).toMatchObject({
      name: 'CloudTextureLoadError',
      url: '/missing.bin',
      status: 200,
      actualBytes: 20
    })
    expect(captured.context.enabled).toBe(true)
    expect(captured.pass.renderingEnabled).toBe(false)
    log('react-volume-validation', { property, rejected: true })
  }
)

test('Strict Mode cleans trial loads and the final owned texture without touching supplied textures', async () => {
  const disposal = vi.spyOn(Texture.prototype, 'dispose')
  const mounted = render(
    <StrictMode>{view({ localWeatherTexture: '/weather.png' })}</StrictMode>
  )
  expect(images.length).toBe(2)
  await settle(() => {
    images[0]!.complete()
    images[1]!.complete()
  })
  expect(captured.assets.status).toBe('ready')
  expect(captured.context.localWeatherTexture).toBe(images[1]!.texture)
  mounted.unmount()
  for (const request of images) {
    expect(
      disposal.mock.contexts.filter(texture => texture === request.texture)
    ).toHaveLength(1)
  }
  for (const texture of Object.values(borrowed)) {
    expect(disposal.mock.contexts).not.toContain(texture)
  }
  log('strict-assets', { requests: 2, disposedOnce: 2, borrowedDisposed: 0 })
})

test('unmount before completion ignores and disposes the late texture', async () => {
  const disposal = vi.spyOn(Texture.prototype, 'dispose')
  const mounted = render(view({ turbulenceTexture: '/turbulence.png' }))
  mounted.unmount()
  await settle(() => images[0]!.complete())
  expect(
    disposal.mock.contexts.filter(texture => texture === images[0]!.texture)
  ).toHaveLength(1)
  log('unmount-loading', { lateDisposedOnce: true })
})

test('borrowed procedural textures remain caller-owned and count as supplied assets', () => {
  const procedural = {
    texture: new Texture(),
    size: 16,
    needsRender: true,
    render: vi.fn(),
    dispose: vi.fn()
  }
  const mounted = render(view({ localWeatherTexture: procedural }))
  expect(captured.assets.status).toBe('ready')
  expect(captured.context.localWeatherTexture).toBe(procedural)
  mounted.unmount()
  expect(procedural.dispose).not.toHaveBeenCalled()
  log('borrowed-procedural', { ready: true, disposed: false })
})

test('the generated jitter volume is context-owned and survives Strict Mode replay', () => {
  const disposal = vi.spyOn(Data3DTexture.prototype, 'dispose')
  const mounted = render(
    <StrictMode>{view({ stbnTexture: undefined })}</StrictMode>
  )
  const jitter = captured.context.stbnTexture
  expect(captured.assets.status).toBe('ready')
  expect(disposal.mock.contexts).not.toContain(jitter)
  mounted.unmount()
  expect(
    disposal.mock.contexts.filter(texture => texture === jitter)
  ).toHaveLength(1)
  expect(disposal.mock.contexts).not.toContain(borrowed.stbnTexture)
  log('generated-jitter-ownership', {
    liveDisposedOnce: true,
    borrowedDisposed: false
  })
})

test('a jitter URL uses the peer dimensions and nearest filtering', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          new Uint8Array(
            STBN_TEXTURE_WIDTH * STBN_TEXTURE_HEIGHT * STBN_TEXTURE_DEPTH
          )
        )
      )
    )
  )
  let mounted: ReturnType<typeof render>
  await settle(() => {
    mounted = render(view({ stbnTexture: '/jitter.bin' }))
  })
  const jitter = captured.context.resolvedStbnTexture!
  expect(captured.assets.status).toBe('ready')
  expect(jitter.image).toMatchObject({
    width: STBN_TEXTURE_WIDTH,
    height: STBN_TEXTURE_HEIGHT,
    depth: STBN_TEXTURE_DEPTH
  })
  expect(jitter.minFilter).toBe(NearestFilter)
  expect(jitter.magFilter).toBe(NearestFilter)
  mounted!.unmount()
  log('peer-jitter-dimensions', {
    width: jitter.image.width,
    height: jitter.image.height,
    depth: jitter.image.depth
  })
})
