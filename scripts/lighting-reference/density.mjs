// The CPU twin of the GPU density pipeline
//
// Every arm reads the same density field, from the same baked assets with the
// same layer uniforms. This is an independent transcription of src/density/
//
// Cite: src/density/sampleWeather.ts (the weather read)
// Cite: src/density/sampleShape.ts (the shape and profile maths)

import { LAYERS, SCENE } from './scene.mjs'

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/** The remapClamp the port uses, with the twin's degenerate-range rule */
function remapClamped(x, low, high) {
  const range = high - low
  if (Math.abs(range) < 1e-10) return x >= high ? 1 : 0
  return clamp01((x - low) / range)
}

/** The cube-sphere UV, transcribed from src/density/globeUv.ts */
export function cubeSphereUv(px, py, pz) {
  const len = Math.sqrt(px * px + py * py + pz * pz)
  const nx = px / len
  const ny = py / len
  const nz = pz / len
  const fx = Math.abs(nx)
  const fy = Math.abs(ny)
  const fz = Math.abs(nz)
  const fmax = Math.max(fx, fy, fz)
  const cx = nx / fmax
  const cy = ny / fmax
  const cz = nz / fmax

  let mx
  let my
  if (fy > fx && fy > fz) {
    mx = cy > 0 ? -nx : nx
    my = nz
  } else if (fx > fy && fx > fz) {
    mx = cx > 0 ? ny : -ny
    my = nz
  } else {
    mx = nx
    my = cz > 0 ? ny : -ny
  }

  const mx2 = mx * mx
  const my2 = my * my
  const q = -2 * mx2 + 2 * my2 - 3
  const q2 = q * q
  const inner = -24 * mx2 + q2
  const uvx =
    Math.sqrt(
      Math.max(0, 1.5 + mx2 - my2 - 0.5 * Math.sqrt(Math.max(0, inner)))
    ) * Math.sign(mx)
  const denom = 3 - uvx * uvx
  const uvy = Math.sqrt(Math.max(0, 6 / denom)) * my
  return [uvx * 0.5 + 0.5, uvy * 0.5 + 0.5]
}

/** The coverage parabola, transcribed from src/density/shapeAltering.ts */
function shapeAltering(heightFraction, bias) {
  const biased = Math.pow(heightFraction, bias)
  const x = Math.max(-1, Math.min(1, biased * 2 - 1))
  return 1 - x * x
}

const CHANNEL_INDEX = { r: 0, g: 1, b: 2, a: 3 }

/**
 * Build the density evaluator
 *
 * @param {object} assets the decoded weather map, shape volume and detail
 *   volume, as returned by scripts/lighting-reference/assets.mjs
 * @param {object} scene the shared scene state
 * @param {Array} layers the four layer slots
 */
export function createDensityEvaluator(assets, scene = SCENE, layers = LAYERS) {
  const bandTops = layers.map(layer => layer.altitude + layer.height)
  const active = layers.map(layer => layer.height > 0)

  /**
   * The density at a world-space position
   *
   * @param {number[]} position ECEF metres
   * @param {number} mipLevel the march's mip level at this sample
   */
  function densityAt(position, mipLevel = 0) {
    const [x, y, z] = position
    const height = Math.hypot(x, y, z) - scene.bottomRadius

    const uv = cubeSphereUv(x, y, z)
    const texCoordU =
      uv[0] * scene.localWeatherRepeat[0] + scene.localWeatherOffset[0]
    const texCoordV =
      uv[1] * scene.localWeatherRepeat[1] + scene.localWeatherOffset[1]
    const weather = assets.weather.sample(texCoordU, texCoordV, mipLevel)

    const shapeValue = assets.shape.sample(
      x * scene.shapeRepeat[0] + scene.shapeOffset[0],
      y * scene.shapeRepeat[1] + scene.shapeOffset[1],
      z * scene.shapeRepeat[2] + scene.shapeOffset[2]
    )

    let detailValue = 0
    if (scene.shapeDetail) {
      detailValue = assets.shapeDetail.sample(
        x * scene.shapeDetailRepeat[0] + scene.shapeDetailOffset[0],
        y * scene.shapeDetailRepeat[1] + scene.shapeDetailOffset[1],
        z * scene.shapeDetailRepeat[2] + scene.shapeDetailOffset[2]
      )
    }

    const densities = [0, 0, 0, 0]
    for (let i = 0; i < 4; i++) {
      const layer = layers[i]
      if (!active[i]) continue
      const range = bandTops[i] - layer.altitude
      const heightFraction =
        range > 0 ? clamp01((height - layer.altitude) / range) : 0

      let value = weather[CHANNEL_INDEX[layer.channel]]
      if (layer.weatherExponent !== 1) {
        value = Math.pow(value, layer.weatherExponent)
      }
      const heightScale = shapeAltering(heightFraction, layer.shapeAlteringBias)
      const factor = 1 - scene.coverage * heightScale
      const cfw = layer.coverageFilterWidth
      const mixed = value * (1 - cfw) + cfw
      let density = 0
      if (cfw > 0) density = clamp01((mixed - factor) / cfw)

      const carve = layer.shapeAmount
      density = remapClamped(density, (1 - shapeValue) * carve, 1)

      if (scene.shapeDetail) {
        const hfRemap = remapClamped(heightFraction, 0.2, 0.4)
        const fluffy = Math.pow(detailValue, 6)
        const whippy = 1 - detailValue
        const modifier0 = fluffy * (1 - hfRemap) + whippy * hfRemap
        const modifier = modifier0 * layer.shapeDetailAmount
        const detailDensity = remapClamped(density * 2, modifier * 0.5, 1)
        density =
          density + (detailDensity - density) * detailFadeStrength(mipLevel)
      }

      const profile = layer.densityProfile
      const layerDensity =
        profile.expTerm * Math.exp(profile.exponent * heightFraction) +
        profile.linearTerm * heightFraction +
        profile.constantTerm
      densities[i] = clamp01(density * layer.densityScale * layerDensity)
    }

    let densitySum = 0
    for (let i = 0; i < 4; i++) densitySum += densities[i]
    const scattering = densitySum * scene.scatteringCoefficient
    const extinction = densitySum * scene.absorptionCoefficient + scattering
    return { densitySum, scattering, extinction, densities }
  }

  /** The extinction at a position, in 1/metre */
  function extinctionAt(position, mipLevel = 0) {
    return densityAt(position, mipLevel).extinction
  }

  return { densityAt, extinctionAt }
}

/**
 * The detail fade, in the port's terms: 1 at mip level 0, 0 from 0.5 up
 * Cite: src/density/sampleShape.ts (DETAIL_FADE_MIP)
 */
export function detailFadeStrength(mipLevel) {
  return Math.max(0, Math.min(1, 1 - mipLevel / 0.5))
}

/**
 * The march's mip level at a distance from the camera
 *
 * Cite: src/march/primaryMarch.ts (log2(max(1, rayStartTexelsPerPixel +
 *   rayDistance * 1e-5)))
 */
export function mipLevelForDistance(distance) {
  return Math.log2(Math.max(1, 1 + distance * 1e-5))
}
