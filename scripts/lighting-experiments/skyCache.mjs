// Phase-free directional sky samples and independent integrated angular weights
import { DataUtils } from 'three'

import { phaseFunction } from '../lighting-reference/medium.mjs'
import { boxInterval, MANIFEST, voxelMedium } from './fixtures.mjs'
import { candidateDirections, sphereDirections } from './quadrature.mjs'

export function makeSkyCache(
  fixture,
  upper = [1, 0.5, 0.25],
  lower = upper,
  size = 32,
  steps = 128
) {
  const started = performance.now()
  const medium = voxelMedium(fixture)
  const { minimum, maximum } = fixture
  const directions = candidateDirections().corners8
  const volumes = directions.map(() => new Uint16Array(size ** 3 * 4))
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const point = [x, y, z].map(
          (v, axis) =>
            minimum[axis] + ((v + 0.5) / size) * (maximum[axis] - minimum[axis])
        )
        const index = ((z * size + y) * size + x) * 4
        for (
          let directionIndex = 0;
          directionIndex < directions.length;
          directionIndex++
        ) {
          const direction = directions[directionIndex]
          const interval = boxInterval(point, direction, minimum, maximum)
          const step = interval ? interval[1] / steps : 0
          let depth = 0
          for (let i = 0; i < steps; i++) {
            const distance = (i + 0.5) * step
            depth +=
              medium.extinctionAt([
                point[0] + direction[0] * distance,
                point[1] + direction[1] * distance,
                point[2] + direction[2] * distance
              ]) * step
          }
          const transmission = Math.exp(-depth)
          const radiance = direction[1] >= 0 ? upper : lower
          for (let channel = 0; channel < 3; channel++)
            volumes[directionIndex][index + channel] = DataUtils.toHalfFloat(
              transmission * radiance[channel]
            )
          volumes[directionIndex][index + 3] = DataUtils.toHalfFloat(1)
        }
      }
  return {
    size,
    volumes,
    buildMilliseconds: performance.now() - started,
    steps,
    directions
  }
}

export function makePhaseWeights(
  width = 64,
  height = 32,
  integrationDirections = 8192
) {
  const directions = sphereDirections(integrationDirections)
  const cells = directions.map(
    d => (d[0] >= 0 ? 1 : 0) + (d[1] >= 0 ? 2 : 0) + (d[2] >= 0 ? 4 : 0)
  )
  const tables = [
    new Uint16Array(width * height * 4),
    new Uint16Array(width * height * 4)
  ]
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const theta = (Math.PI * (y + 0.5)) / height
      const phi = 2 * Math.PI * ((x + 0.5) / width - 0.5)
      const view = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi)
      ]
      const weights = new Float64Array(8)
      for (let i = 0; i < directions.length; i++) {
        const d = directions[i]
        weights[cells[i]] +=
          (phaseFunction(
            view[0] * d[0] + view[1] * d[1] + view[2] * d[2],
            1,
            ...MANIFEST.phase
          ) *
            4 *
            Math.PI) /
          directions.length
      }
      for (let i = 0; i < 8; i++)
        tables[i >> 2][(y * width + x) * 4 + (i % 4)] = DataUtils.toHalfFloat(
          weights[i]
        )
    }
  return { width, height, tables, phase: MANIFEST.phase, integrationDirections }
}
