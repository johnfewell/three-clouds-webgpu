// @vitest-environment jsdom

import { Texture, TextureLoader } from 'three'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance
} from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  CloudTextureLoadError,
  loadBakedCloudTextures,
  loadCloudTexture
} from './loadBakedCloudTextures'

const urls = {
  localWeather: '/assets/weather.png',
  turbulence: '/assets/turbulence.png',
  shape: '/assets/shape.bin',
  shapeDetail: '/assets/detail.bin'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

interface ImageRequest {
  texture: Texture
  complete: () => void
  fail: (cause: unknown) => void
}

const images = new Map<string, ImageRequest>()
const volumes = new Map<string, ReturnType<typeof deferred<Response>>>()
const signals: AbortSignal[] = []
let disposal: MockInstance<() => void>
let imageLoad: MockInstance<TextureLoader['load']>

function response(size: number, status = 200): Response {
  return new Response(new ArrayBuffer(size), { status })
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function completeImages(): void {
  for (const request of images.values()) request.complete()
}

function completeVolumes(): void {
  volumes.get(urls.shape)!.resolve(response(128 ** 3))
  volumes.get(urls.shapeDetail)!.resolve(response(32 ** 3))
}

beforeEach(() => {
  setCurrentSpec('baked_asset_lifecycle')
  images.clear()
  volumes.clear()
  signals.length = 0
  disposal = vi.spyOn(Texture.prototype, 'dispose')
  imageLoad = vi
    .spyOn(TextureLoader.prototype, 'load')
    .mockImplementation((url, onLoad, _onProgress, onError) => {
      const texture = new Texture<HTMLImageElement>()
      images.set(url, {
        texture,
        complete: () => onLoad?.(texture),
        fail: cause => onError?.(cause)
      })
      return texture
    })
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, options: RequestInit) => {
      const loading = deferred<Response>()
      volumes.set(input, loading)
      signals.push(options.signal!)
      return loading.promise
    })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('volume validation and diagnostics', () => {
  test.each([0, 128 ** 3 - 1, 128 ** 3 + 1])(
    'rejects %i shape bytes before creating a volume',
    async actualBytes => {
      const loading = loadBakedCloudTextures(urls)
      const assertion = expect(loading).rejects.toMatchObject({
        name: 'CloudTextureLoadError',
        asset: 'shape',
        url: urls.shape,
        status: 200,
        expectedBytes: 128 ** 3,
        actualBytes
      })
      volumes.get(urls.shape)!.resolve(response(actualBytes))
      await assertion
      expect(disposal).toHaveBeenCalledTimes(2)
      completeImages()
      volumes.get(urls.shapeDetail)!.resolve(response(32 ** 3))
      await flush()
      expect(disposal).toHaveBeenCalledTimes(2)
      log('invalid-volume', {
        expectedBytes: 128 ** 3,
        actualBytes,
        rejected: true
      })
    }
  )

  test('HTTP-200 HTML fallback identifies asset, URL and payload size', async () => {
    const html = '<!doctype html><html>not an asset</html>'
    const loading = loadBakedCloudTextures(urls)
    const assertion = expect(loading).rejects.toMatchObject({
      asset: 'shapeDetail',
      url: urls.shapeDetail,
      expectedBytes: 32 ** 3,
      actualBytes: html.length,
      status: 200
    })
    volumes.get(urls.shapeDetail)!.resolve(new Response(html))
    await assertion
    log('html-fallback', {
      status: 200,
      actualBytes: html.length,
      rejected: true
    })
  })

  test('HTTP and network failures retain actionable details and causes', async () => {
    const loading = loadBakedCloudTextures(urls)
    const assertion = expect(loading).rejects.toMatchObject({
      asset: 'shape',
      url: urls.shape,
      status: 404,
      message: expect.stringContaining('HTTP 404')
    })
    volumes.get(urls.shape)!.resolve(response(0, 404))
    await assertion
    const cause = new Error('offline')
    const retry = loadBakedCloudTextures(urls)
    const retryAssertion = expect(retry).rejects.toMatchObject({
      asset: 'shapeDetail',
      url: urls.shapeDetail,
      cause
    })
    volumes.get(urls.shapeDetail)!.reject(cause)
    await retryAssertion
    log('load-errors', { http: 404, networkCause: 'offline' })
  })

  test('image errors retain the asset, URL and original cause', async () => {
    const cause = new Event('error')
    const loading = loadBakedCloudTextures(urls)
    const assertion = expect(loading).rejects.toMatchObject({
      name: 'CloudTextureLoadError',
      asset: 'localWeather',
      url: urls.localWeather,
      cause
    })
    images.get(urls.localWeather)!.fail(cause)
    await assertion
    log('image-error', { asset: 'localWeather', url: urls.localWeather })
  })
})

test.each(['none', 'image', 'volume'])(
  'failure cleans resources with %s completed first and late images',
  async early => {
    const loading = loadBakedCloudTextures(urls)
    const assertion = expect(loading).rejects.toBeInstanceOf(
      CloudTextureLoadError
    )
    if (early === 'image') images.get(urls.localWeather)!.complete()
    if (early === 'volume') volumes.get(urls.shape)!.resolve(response(128 ** 3))
    await flush()
    volumes.get(urls.shapeDetail)!.resolve(response(0, 500))
    await assertion
    completeImages()
    volumes.get(urls.shape)!.resolve(response(128 ** 3))
    await flush()
    expect(disposal).toHaveBeenCalledTimes(early === 'volume' ? 3 : 2)
    expect(new Set(disposal.mock.contexts).size).toBe(
      disposal.mock.calls.length
    )
    expect(signals.every(signal => signal.aborted)).toBe(true)
    log('failure-cleanup-order', {
      early,
      disposed: disposal.mock.calls.length
    })
  }
)

test('abort before loading starts rejects without allocating or requesting', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    loadBakedCloudTextures(urls, { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetch).not.toHaveBeenCalled()
  expect(imageLoad).not.toHaveBeenCalled()
  expect(disposal).not.toHaveBeenCalled()
  log('early-abort', { requests: 0, allocations: 0 })
})

test('abort cleans completed and late resources exactly once despite repeated teardown', async () => {
  const controller = new AbortController()
  const loading = loadBakedCloudTextures(urls, { signal: controller.signal })
  const assertion = expect(loading).rejects.toMatchObject({
    name: 'AbortError'
  })
  images.get(urls.localWeather)!.complete()
  volumes.get(urls.shape)!.resolve(response(128 ** 3))
  await flush()
  controller.abort()
  controller.abort()
  await assertion
  completeImages()
  completeVolumes()
  await flush()
  expect(disposal).toHaveBeenCalledTimes(3)
  expect(new Set(disposal.mock.contexts).size).toBe(3)
  expect(signals.every(signal => signal.aborted)).toBe(true)
  log('abort-cleanup', { disposedExactlyOnce: 3, fetchSignalsAborted: true })
})

test('success transfers four textures; later abort does not dispose caller resources', async () => {
  const controller = new AbortController()
  const loading = loadBakedCloudTextures(urls, { signal: controller.signal })
  completeImages()
  completeVolumes()
  const result = await loading
  expect(Object.keys(result).sort()).toEqual([
    'localWeatherTexture',
    'shapeDetailTexture',
    'shapeTexture',
    'turbulenceTexture'
  ])
  const context = { dispose: vi.fn() }
  const originalDispose = context.dispose
  Object.assign(context, result)
  expect(context.dispose).toBe(originalDispose)
  controller.abort()
  expect(disposal).not.toHaveBeenCalled()
  for (const texture of Object.values(result)) texture.dispose()
  expect(disposal).toHaveBeenCalledTimes(4)
  log('ownership-transfer', { textureKeys: 4, abortAfterSuccessDisposals: 0 })
})

test('abort settles promptly after images complete even if a transport ignores its signal', async () => {
  const controller = new AbortController()
  const loading = loadBakedCloudTextures(urls, { signal: controller.signal })
  completeImages()
  await flush()
  const assertion = expect(loading).rejects.toMatchObject({
    name: 'AbortError'
  })
  controller.abort()
  await assertion
  expect(disposal).toHaveBeenCalledTimes(2)
  completeVolumes()
  await flush()
  expect(disposal).toHaveBeenCalledTimes(2)
  log('uncooperative-transport', { promptRejection: true, imagesDisposed: 2 })
})

test('a synchronous image error disposes the texture returned after its callback', async () => {
  const texture = new Texture<HTMLImageElement>()
  imageLoad.mockImplementationOnce((_url, _onLoad, _progress, onError) => {
    onError?.(new Error('sync failure'))
    return texture
  })
  await expect(
    loadCloudTexture('localWeather', urls.localWeather)
  ).rejects.toBeInstanceOf(CloudTextureLoadError)
  expect(disposal.mock.contexts).toEqual([texture])
  log('sync-image-error', { disposed: 1 })
})
