// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// Cite: localWeather.frag:12–83, turbulence.frag:12–51

import { float, Fn, smoothstep, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

import { createPerlinFbm, worleyNoise } from './tileableNoise'

// localWeather's own Worley fbm, not cloudShape's despite the shared original
// name `getWorleyFbm`: an octave sum over `1 - worley`, unbounded because each
// caller's smoothstep does the ranging. `octaveCount` unrolls at graph time
function localWeatherWorleyFbm(
  point: Node<'vec3'>,
  frequency: number,
  amplitude: number,
  lacunarity: number,
  gain: number,
  octaveCount: number
): Node<'float'> {
  let noise: Node<'float'> = float(0)
  let f = frequency
  let a = amplitude
  for (let i = 0; i < octaveCount; i++) {
    noise = noise.add(
      float(1)
        .sub(worleyNoise(point, float(f)))
        .mul(a)
    )
    f *= lacunarity
    a *= gain
  }
  return noise
}

const perlinFbm8 = /*#__PURE__*/ createPerlinFbm(8)

// The 512² local weather texture. Green (mid) is computed first because red
// (low) subtracts it, which stops low and mid stacking into a solid deck (red
// first would still look plausible, with a different layer relationship)

// Alpha is 1, faithfully: the reference computes a 4-octave Perlin into alpha
// and overwrites it with 1.0 on the next line (localWeather.frag:77–82), so
// that dead value is not ported
export const localWeather = /*#__PURE__*/ Fn(([uv]: [Node<'vec2'>]) => {
  const point = vec3(uv.x, uv.y, 0)

  // Mid clouds, offset by 0.5 on every axis so it does not correlate with low
  const mid = smoothstep(
    float(1),
    float(1.4),
    localWeatherWorleyFbm(point.add(vec3(0.5)), 8, 0.4, 2, 0.95, 4)
  )

  const low = smoothstep(
    float(0.8),
    float(1.4),
    localWeatherWorleyFbm(point, 16, 0.4, 2, 0.95, 4)
  )
    .sub(mid)
    .clamp(0, 1)

  // High clouds: anisotropic frequency (6, 12, 1), 8 octaves
  const high = smoothstep(
    float(-0.5),
    float(0.5),
    perlinFbm8(point, vec3(6, 12, 1))
  )

  return vec4(low, mid, high, 1)
})
