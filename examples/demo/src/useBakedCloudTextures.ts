import { useEffect, useMemo, useState } from 'react'
import type { Data3DTexture } from 'three'
import {
  createJitterTexture,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  loadBakedCloudTextures,
  type BakedCloudTextures
} from 'three-clouds-webgpu'

export function useBakedCloudTextures(): BakedCloudTextures | null {
  const [textures, setTextures] = useState<BakedCloudTextures | null>(null)

  useEffect(() => {
    let active = true
    let loadedTextures: BakedCloudTextures | null = null
    void loadBakedCloudTextures({
      localWeather: DEFAULT_LOCAL_WEATHER_URL,
      turbulence: DEFAULT_TURBULENCE_URL,
      shape: DEFAULT_SHAPE_URL,
      shapeDetail: DEFAULT_SHAPE_DETAIL_URL
    }).then(loaded => {
      if (active) {
        loadedTextures = loaded
        setTextures(loaded)
      } else {
        loaded.localWeatherTexture.dispose()
        loaded.shapeTexture.dispose()
        loaded.shapeDetailTexture.dispose()
        loaded.turbulenceTexture.dispose()
      }
    })
    return () => {
      active = false
      if (loadedTextures != null) {
        loadedTextures.localWeatherTexture.dispose()
        loadedTextures.shapeTexture.dispose()
        loadedTextures.shapeDetailTexture.dispose()
        loadedTextures.turbulenceTexture.dispose()
      }
    }
  }, [])

  return textures
}

export function useJitterTexture(): Data3DTexture {
  const texture = useMemo(() => createJitterTexture(), [])
  useEffect(() => () => texture.dispose(), [texture])
  return texture
}
