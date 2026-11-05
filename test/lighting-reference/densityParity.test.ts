// The CPU density evaluator against the port's own CPU twins
//
// The evaluator in scripts/lighting-reference/ is an independent transcription
// of the GPU's density pipeline, so this pins its maths against the twins the
// port already ships. The texture reads are not pinned here: the lighting
// experiment's baseline arm checks them against the GPU

import { describe, expect, it } from 'vitest'

import { loadAssets } from '../../scripts/lighting-reference/assets.mjs'
import {
  createDensityEvaluator,
  cubeSphereUv
} from '../../scripts/lighting-reference/density.mjs'
import { LAYERS, SCENE } from '../../scripts/lighting-reference/scene.mjs'
import { cpuGetCubeSphereUv } from '../../src/density/globeUv'
import { getLayerDensityCPU } from '../../src/density/layerDensity'
import { cpuSampleMedia } from '../../src/density/sampleShape'
import { cpuSampleWeather } from '../../src/density/sampleWeather'
import { table } from '../helpers/cpuTwin'

const assets = loadAssets()
const evaluator = createDensityEvaluator(assets, SCENE, LAYERS)

/** A spread of positions across the cloud bands, in ECEF metres */
function samplePositions(count: number): [number, number, number][] {
  const positions: [number, number, number][] = []
  const radius = SCENE.bottomRadius
  for (let i = 0; i < count; i++) {
    const longitude = (i / count) * Math.PI * 2
    const latitude = (((i * 7) % count) / count) * Math.PI - Math.PI / 2
    const height = 750 + ((i * 13) % 16) * 100
    const r = radius + height
    positions.push([
      r * Math.cos(latitude) * Math.cos(longitude),
      r * Math.cos(latitude) * Math.sin(longitude),
      r * Math.sin(latitude)
    ])
  }
  return positions
}

describe('the CPU density evaluator', () => {
  it('places the cube-sphere UV where the port does', () => {
    const positions = samplePositions(64)
    let worst = 0
    for (const position of positions) {
      const [x, y, z] = position
      const mine = cubeSphereUv(x, y, z)
      const theirs = cpuGetCubeSphereUv(x, y, z)
      worst = Math.max(
        worst,
        Math.abs(mine[0] - theirs[0]),
        Math.abs(mine[1] - theirs[1])
      )
    }
    table('density-uv', [
      { field: 'worst difference', expected: 0, actual: worst }
    ])
    expect(worst).toBeLessThan(1e-12)
  })

  it("computes the same density as the port's own CPU twins", () => {
    const positions = samplePositions(48)
    let worstDensity = 0
    let worstExtinction = 0
    for (const position of positions) {
      const [px, py, pz] = position
      const height = Math.hypot(px, py, pz) - SCENE.bottomRadius
      const uv = cubeSphereUv(px, py, pz)
      const weatherSample = assets.weather.sample(
        uv[0] * SCENE.localWeatherRepeat[0] + SCENE.localWeatherOffset[0],
        uv[1] * SCENE.localWeatherRepeat[1] + SCENE.localWeatherOffset[1],
        0
      )
      const shapeValue = assets.shape.sample(
        px * SCENE.shapeRepeat[0] + SCENE.shapeOffset[0],
        py * SCENE.shapeRepeat[1] + SCENE.shapeOffset[1],
        pz * SCENE.shapeRepeat[2] + SCENE.shapeOffset[2]
      )

      // The weather side, through the port's twin
      const weather = cpuSampleWeather(
        height,
        [
          LAYERS[0]!.altitude,
          LAYERS[1]!.altitude,
          LAYERS[2]!.altitude,
          LAYERS[3]!.altitude
        ],
        [
          LAYERS[0]!.altitude + LAYERS[0]!.height,
          LAYERS[1]!.altitude + LAYERS[1]!.height,
          LAYERS[2]!.altitude + LAYERS[2]!.height,
          LAYERS[3]!.altitude + LAYERS[3]!.height
        ],
        weatherSample as [number, number, number, number],
        [1, 1, 1, 1],
        [0.35, 0.35, 0.35, 0.35],
        SCENE.coverage,
        [0.6, 0.6, 0.5, 0.6],
        [1, 1, 1, 1],
        false
      )

      // The media side, through the port's twin
      const media = cpuSampleMedia(
        weather.density,
        weather.heightFraction,
        shapeValue,
        [1, 1, 0.4, 1],
        [0.2, 0.2, 0.003, 0.2],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0.75, 0.75, 0.75, 0.75],
        [0.25, 0.25, 0.25, 0.25],
        SCENE.scatteringCoefficient,
        SCENE.absorptionCoefficient,
        { shapeDetail: false, mipLevel: 0, jitter: 1 }
      )

      const mine = evaluator.densityAt(position, 0)
      // The twin's MediaSample reports the summed density, not the lanes
      worstDensity = Math.max(
        worstDensity,
        Math.abs(mine.densitySum - media.density)
      )
      worstExtinction = Math.max(
        worstExtinction,
        Math.abs(mine.extinction - media.extinction)
      )
    }
    table('density-twin', [
      { field: 'worst density difference', expected: 0, actual: worstDensity },
      {
        field: 'worst extinction difference',
        expected: 0,
        actual: worstExtinction
      }
    ])
    expect(worstDensity).toBeLessThan(1e-9)
    expect(worstExtinction).toBeLessThan(1e-9)
  })

  it('reproduces the height profile the port computes', () => {
    const heightFraction = 0.375
    const expected = getLayerDensityCPU(heightFraction, 0, 0, 0.75, 0.25)
    table('density-profile', [
      { field: 'profile', expected: 0.53125, actual: expected }
    ])
    expect(expected).toBeCloseTo(0.53125, 12)
  })
})
