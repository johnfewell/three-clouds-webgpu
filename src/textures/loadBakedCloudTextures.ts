// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import {
  Data3DTexture,
  LinearFilter,
  LinearMipMapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  TextureLoader,
  UnsignedByteType,
  type MagnificationTextureFilter,
  type Texture
} from 'three'

import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE
} from '../constants'
import { BLUE_NOISE_RANK_MAP_BASE64 } from './blueNoiseRankMap'

/**
 * The four baked textures a {@link CloudsContext} marches against
 * Ownership transfers to the caller after a successful load, without jitter
 */
export interface BakedCloudTextures {
  localWeatherTexture: Texture
  turbulenceTexture: Texture
  shapeTexture: Data3DTexture
  shapeDetailTexture: Data3DTexture
}

/**
 * Where to fetch each of the four. The shapes are raw 3D payloads sized by
 * {@link CLOUD_SHAPE_TEXTURE_SIZE} and {@link CLOUD_SHAPE_DETAIL_TEXTURE_SIZE}
 * rather than images, so they cannot go through a `TextureLoader`.
 *
 * The defaults for all four are exported from the package root.
 */
export interface BakedCloudTextureUrls {
  localWeather: string
  turbulence: string
  shape: string
  shapeDetail: string
}

/** Optional cancellation while the loader still owns its pending resources */
export interface LoadBakedCloudTexturesOptions {
  /** Abort pending loads, not textures already returned to the caller */
  signal?: AbortSignal
}

/** Logical asset identity, independent of its URL or transport */
export type CloudTextureAsset = keyof BakedCloudTextureUrls | 'stbn'

interface TextureLoadDetails {
  asset: CloudTextureAsset
  url: string
  status?: number
  expectedBytes?: number
  actualBytes?: number
}

/**
 * Identifies a failed asset without requiring callers to parse its message
 * Cancellation instead rejects with a DOMException named AbortError
 */
export class CloudTextureLoadError extends Error {
  /** The failed logical asset, even when several assets share a URL */
  readonly asset: CloudTextureAsset
  /** The caller-supplied URL, not a resolved cache key */
  readonly url: string
  /** HTTP status when a volume response was received, absent for images */
  readonly status?: number
  /** Required raw volume byte count when a payload-size mismatch was found */
  readonly expectedBytes?: number
  /** Received raw volume byte count when a payload-size mismatch was found */
  readonly actualBytes?: number

  constructor(details: TextureLoadDetails, message: string, cause?: unknown) {
    super(`Cloud asset ${details.asset} (${details.url}): ${message}`, {
      cause
    })
    this.name = 'CloudTextureLoadError'
    this.asset = details.asset
    this.url = details.url
    this.status = details.status
    this.expectedBytes = details.expectedBytes
    this.actualBytes = details.actualBytes
  }
}

function abortError(): DOMException {
  return new DOMException('Cloud texture loading was aborted', 'AbortError')
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

function disposalScope(): (texture: Texture) => void {
  const disposed = new WeakSet<Texture>()
  return texture => {
    if (disposed.has(texture)) return
    disposed.add(texture)
    texture.dispose()
  }
}

function abortable<T>(loading: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void loading.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export function loadCloudTexture(
  asset: CloudTextureAsset,
  url: string,
  { signal }: LoadBakedCloudTexturesOptions = {}
): Promise<Texture> {
  return new Promise((resolve, reject) => {
    checkAbort(signal)
    const dispose = disposalScope()
    let pending: Texture | undefined
    const state: { value: 'pending' | 'failed' | 'succeeded' } = {
      value: 'pending'
    }
    const fail = (error: Error): void => {
      if (state.value !== 'pending') return
      state.value = 'failed'
      signal?.removeEventListener('abort', onAbort)
      if (pending != null) dispose(pending)
      reject(error)
    }
    const onAbort = (): void => fail(abortError())
    const onLoad = (texture: Texture): void => {
      if (state.value !== 'pending') {
        if (state.value === 'failed') dispose(texture)
        return
      }
      texture.minFilter = LinearMipMapLinearFilter
      texture.magFilter = LinearFilter
      texture.wrapS = RepeatWrapping
      texture.wrapT = RepeatWrapping
      texture.colorSpace = NoColorSpace
      texture.needsUpdate = true
      state.value = 'succeeded'
      signal?.removeEventListener('abort', onAbort)
      resolve(texture)
    }
    const onError = (cause: unknown): void => {
      fail(
        new CloudTextureLoadError({ asset, url }, 'image load failed', cause)
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      pending = new TextureLoader().load(url, onLoad, undefined, onError)
      if (signal?.aborted === true) onAbort()
      if (state.value === 'failed' && pending != null) dispose(pending)
    } catch (cause) {
      onError(cause)
    }
  })
}

function volumeTexture(
  buffer: ArrayBuffer,
  dimensions: readonly [number, number, number],
  filter: MagnificationTextureFilter
): Data3DTexture {
  const texture = new Data3DTexture(new Uint8Array(buffer), ...dimensions)
  texture.format = RedFormat
  texture.minFilter = filter
  texture.magFilter = filter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

export async function loadCloudVolume(
  asset: CloudTextureAsset,
  url: string,
  dimensions: readonly [number, number, number],
  filter: MagnificationTextureFilter = LinearFilter,
  { signal }: LoadBakedCloudTexturesOptions = {}
): Promise<Data3DTexture> {
  checkAbort(signal)
  let status: number | undefined
  try {
    const response = await fetch(url, { signal })
    status = response.status
    checkAbort(signal)
    if (!response.ok) {
      throw new CloudTextureLoadError({ asset, url, status }, `HTTP ${status}`)
    }
    const buffer = await response.arrayBuffer()
    checkAbort(signal)
    const expectedBytes = dimensions.reduce(
      (product, size) => product * size,
      1
    )
    if (buffer.byteLength !== expectedBytes) {
      throw new CloudTextureLoadError(
        { asset, url, status, expectedBytes, actualBytes: buffer.byteLength },
        `expected ${expectedBytes} bytes for ${dimensions.join('x')}, received ${buffer.byteLength}`
      )
    }
    return volumeTexture(buffer, dimensions, filter)
  } catch (cause) {
    checkAbort(signal)
    if (cause instanceof CloudTextureLoadError) throw cause
    throw new CloudTextureLoadError(
      { asset, url, status },
      'volume load failed',
      cause
    )
  }
}

/**
 * Load the four baked assets the original ships, with the same filters and
 * wrapping it applies. Assign the result to the matching context properties:
 *
 * ```ts
 * const cloudsContext = cloudsPass.cloudsContext
 * const baked = await loadBakedCloudTextures({
 *   localWeather: DEFAULT_LOCAL_WEATHER_URL,
 *   turbulence: DEFAULT_TURBULENCE_URL,
 *   shape: DEFAULT_SHAPE_URL,
 *   shapeDetail: DEFAULT_SHAPE_DETAIL_URL
 * })
 * cloudsContext.localWeatherTexture = baked.localWeatherTexture
 * cloudsContext.shapeTexture = baked.shapeTexture
 * cloudsContext.shapeDetailTexture = baked.shapeDetailTexture
 * cloudsContext.turbulenceTexture = baked.turbulenceTexture
 * ```
 *
 * The 3D loads use `fetch`, so a cross-origin file:// page needs the assets
 * served over http. Success transfers all four textures to the caller.
 * Failure or abort disposes all loader-owned textures, including late images.
 * Abort cancels fetches, not image transport, and has no effect after success.
 *
 * @remarks
 * Requires: all four URLs, with successful HTTP responses and exact volume sizes
 * Readiness: resolved textures are CPU-loaded, not proof of a rendered frame
 * Ownership: dispose returned textures once, or transfer them to one owner
 * Failure: CloudTextureLoadError identifies the asset, AbortError is cancellation
 */
export async function loadBakedCloudTextures(
  urls: BakedCloudTextureUrls,
  { signal }: LoadBakedCloudTexturesOptions = {}
): Promise<BakedCloudTextures> {
  checkAbort(signal)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const owned = new Set<Texture>()
  const dispose = disposalScope()
  let failed = false
  const own = async <T extends Texture>(loading: Promise<T>): Promise<T> => {
    const texture = await loading
    if (failed) dispose(texture)
    else owned.add(texture)
    return texture
  }
  const options = { signal: controller.signal }
  try {
    const [
      localWeatherTexture,
      turbulenceTexture,
      shapeTexture,
      shapeDetailTexture
    ] = await abortable(
      Promise.all([
        own(loadCloudTexture('localWeather', urls.localWeather, options)),
        own(loadCloudTexture('turbulence', urls.turbulence, options)),
        own(
          loadCloudVolume(
            'shape',
            urls.shape,
            [
              CLOUD_SHAPE_TEXTURE_SIZE,
              CLOUD_SHAPE_TEXTURE_SIZE,
              CLOUD_SHAPE_TEXTURE_SIZE
            ],
            LinearFilter,
            options
          )
        ),
        own(
          loadCloudVolume(
            'shapeDetail',
            urls.shapeDetail,
            [
              CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
              CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
              CLOUD_SHAPE_DETAIL_TEXTURE_SIZE
            ],
            LinearFilter,
            options
          )
        )
      ]),
      controller.signal
    )
    checkAbort(controller.signal)
    return {
      localWeatherTexture,
      turbulenceTexture,
      shapeTexture,
      shapeDetailTexture
    }
  } catch (error) {
    failed = true
    controller.abort()
    owned.forEach(dispose)
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

const JITTER_WIDTH = 128
const JITTER_HEIGHT = 128
const JITTER_DEPTH = 64
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949

function lowbias32(x: number): number {
  x = (x + 0x9e3779b9) | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x21f0aaad)
  x ^= x >>> 15
  x = Math.imul(x, 0x735a2d97)
  x ^= x >>> 15
  return x >>> 0
}

function jitterVolume(data: Uint8Array): Data3DTexture {
  const texture = new Data3DTexture(
    data,
    JITTER_WIDTH,
    JITTER_HEIGHT,
    JITTER_DEPTH
  )
  texture.format = RedFormat
  texture.type = UnsignedByteType
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * The white-noise hash volume the jitter defaulted to before blue noise. It is
 * still exported because the parity harness samples it, and its bytes are part
 * of the ladder's committed evidence, so replacing the default with it would
 * move every captured metric.
 */
export function createHashJitterTexture(): Data3DTexture {
  const size = JITTER_WIDTH * JITTER_HEIGHT * JITTER_DEPTH
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = lowbias32(i) & 0xff
  }
  return jitterVolume(data)
}

/**
 * The 128x128x64 blue-noise jitter volume the context uses when you do not
 * assign one, built offline by `scripts/generate-blue-noise.mjs` and embedded
 * as a rank map. Slice k is that map shifted by k times the golden ratio
 * conjugate, so consecutive slices decorrelate. Generated per call and cached
 * by {@link CloudsContext.stbnTexture}.
 *
 * To sample NVIDIA's STBN exactly as the original does instead, load it from
 * upstream and assign it (see ADR-009).
 */
export function createJitterTexture(): Data3DTexture {
  const map = Uint8Array.from(atob(BLUE_NOISE_RANK_MAP_BASE64), c =>
    c.charCodeAt(0)
  )
  const area = JITTER_WIDTH * JITTER_HEIGHT
  const data = new Uint8Array(area * JITTER_DEPTH)
  for (let k = 0; k < JITTER_DEPTH; k++) {
    const offset = Math.floor(0.5 + ((k * GOLDEN_RATIO_CONJUGATE) % 1) * 256)
    for (let p = 0; p < area; p++) {
      data[k * area + p] = (map[p]! + offset) & 0xff
    }
  }
  return jitterVolume(data)
}
