import { TextureLoader, type Texture } from 'three'
import {
  loadBakedCloudTextures,
  type BakedCloudTextureUrls
} from 'three-clouds-webgpu'

interface ImageLifecycle {
  decoded: boolean
  disposals: number
}

export async function measureAssetFailureOwnership(
  urls: BakedCloudTextureUrls,
  badUrl: string
) {
  const originalLoad = Reflect.get(TextureLoader.prototype, 'load')
  const originalFetch = Reflect.get(window, 'fetch')
  const images: Record<string, ImageLifecycle> = {}
  const late: { complete?: () => void } = {}
  const completions = new Map<string, () => void>()
  const decoded = [urls.localWeather, urls.turbulence].map(
    url =>
      new Promise<void>(resolve => {
        completions.set(url, resolve)
      })
  )
  TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    const lifecycle = { decoded: false, disposals: 0 }
    images[url] = lifecycle
    const texture = originalLoad.call(
      this,
      url,
      (loaded: Texture<HTMLImageElement>) => {
        lifecycle.decoded = true
        if (url === urls.turbulence) {
          late.complete = () => onLoad?.(loaded)
        } else {
          onLoad?.(loaded)
        }
        completions.get(url)?.()
      },
      onProgress,
      error => {
        completions.get(url)?.()
        onError?.(error)
      }
    )
    texture.addEventListener('dispose', () => {
      lifecycle.disposals++
    })
    return texture
  }
  window.fetch = async (input, options) => {
    const response = await originalFetch.call(window, input, options)
    if (input === badUrl) await Promise.all(decoded)
    return response
  }
  try {
    const failure = await loadBakedCloudTextures({
      ...urls,
      shape: badUrl
    }).then(
      () => null,
      (error: Error & Record<string, unknown>) => ({
        name: error.name,
        asset: error.asset,
        url: error.url,
        status: error.status,
        expectedBytes: error.expectedBytes,
        actualBytes: error.actualBytes
      })
    )
    const beforeLate = structuredClone(images)
    late.complete?.()
    await Promise.resolve()
    const afterLate = structuredClone(images)
    return { failure, beforeLate, afterLate }
  } finally {
    TextureLoader.prototype.load = originalLoad
    window.fetch = originalFetch
  }
}
