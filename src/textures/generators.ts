// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: CloudShape.ts, CloudShapeDetail.ts, Turbulence.ts, LocalWeather.ts
//       (sizes and the DEFAULT_*_URL fallbacks)

import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE
} from '../constants'
import { cloudShape, cloudShapeDetail } from './cloudShape'
import { localWeather } from './localWeather'
import {
  Procedural3DTexture,
  ProceduralTexture2D,
  type ProceduralTextureLike
} from './ProceduralTexture'
import { turbulence } from './turbulence'

// Sizes and default URLs come from src/constants.ts, which owns them for the
// baked loader: a generated texture and its baked fallback must be the same
// size, or the fallback silently changes the march's sampling

// Turbulence and local weather have no size constant there (the loader reads
// the PNG), so they are declared here and only here
export const TURBULENCE_SIZE = 128
export const LOCAL_WEATHER_SIZE = 512

// 128^3 base shape
export class CloudShape extends Procedural3DTexture {
  constructor() {
    super({
      size: CLOUD_SHAPE_TEXTURE_SIZE,
      generate: point => cloudShape(point)
    })
  }
}

// 32^3 detail, used to erode the base shape at edges
export class CloudShapeDetail extends Procedural3DTexture {
  constructor() {
    super({
      size: CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
      generate: point => cloudShapeDetail(point)
    })
  }
}

// 128^2 curl-noise turbulence, packed as `0.5 * curl + 0.5`
export class Turbulence extends ProceduralTexture2D {
  constructor() {
    super({ size: TURBULENCE_SIZE, generate: uv => turbulence(uv) })
  }
}

// 512^2 weather: low/mid/high cloud coverage in R/G/B
export class LocalWeather extends ProceduralTexture2D {
  constructor() {
    super({ size: LOCAL_WEATHER_SIZE, generate: uv => localWeather(uv) })
  }
}

export type { ProceduralTextureLike }
