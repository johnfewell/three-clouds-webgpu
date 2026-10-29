import type { BakedCloudTextureUrls } from 'three-clouds-webgpu'
import localWeather from 'three-clouds-webgpu/assets/local_weather.png?url'
import shapeDetail from 'three-clouds-webgpu/assets/shape_detail.bin?url'
import shape from 'three-clouds-webgpu/assets/shape.bin?url'
import turbulence from 'three-clouds-webgpu/assets/turbulence.png?url'

export function assetUrls(): BakedCloudTextureUrls {
  const base = new URLSearchParams(location.search).get('assets')
  if (base == null) return { localWeather, shape, shapeDetail, turbulence }
  const root = new URL(base.endsWith('/') ? base : `${base}/`, location.href)
  return {
    localWeather: new URL('local_weather.png', root).href,
    shape: new URL('shape.bin', root).href,
    shapeDetail: new URL('shape_detail.bin', root).href,
    turbulence: new URL('turbulence.png', root).href
  }
}
