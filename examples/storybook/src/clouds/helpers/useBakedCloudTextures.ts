// The four baked textures, AWAITED before <Clouds> mounts, as examples/r3f
// does. Rendering while they were in flight made a fresh load converge to a
// visibly different cloud field than a cached one, after a storm of WebGPU
// validation errors

import { useEffect, useState } from 'react'
import {
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
    let live = true
    void loadBakedCloudTextures({
      localWeather: DEFAULT_LOCAL_WEATHER_URL,
      turbulence: DEFAULT_TURBULENCE_URL,
      shape: DEFAULT_SHAPE_URL,
      shapeDetail: DEFAULT_SHAPE_DETAIL_URL
    }).then(loaded => {
      if (live) setTextures(loaded)
    })
    return () => {
      live = false
    }
  }, [])
  return textures
}
