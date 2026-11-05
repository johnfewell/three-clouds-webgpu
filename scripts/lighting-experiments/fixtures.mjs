// Fixture density is baked once and shared byte-for-byte by CPU and GPU
import { createHash } from 'node:crypto'
import { DataUtils } from 'three'

import { loadAssets } from '../lighting-reference/assets.mjs'
import { createDensityEvaluator } from '../lighting-reference/density.mjs'
import { LAYERS, SCENE } from '../lighting-reference/scene.mjs'

export const MANIFEST = Object.freeze({
  version: 1,
  resolution: [320, 180],
  volumeSize: 64,
  bottomRadius: 6360000,
  minimum: [-1800, 6360750, -1800],
  maximum: [1800, 6362200, 1800],
  phase: [0.7, -0.2, 0.5],
  shapes: ['cumulus', 'deck', 'broken'],
  thickness: [0.5, 1, 2],
  sunElevations: [10, 45],
  viewAzimuths: [0, 90, 180],
  cameraDistance: 6000,
  fov: 36,
  reference: {
    samples: [64, 128],
    seeds: [7, 987654321],
    bounces: [32, 64],
    stepSizes: [20, 10],
    maxSeconds: 600
  },
  shadowSteps: 128,
  primaryStep: 10
})

const clamp = value => Math.min(1, Math.max(0, value))
const smooth = value => {
  const t = clamp(value)
  return t * t * (3 - 2 * t)
}

function lobe(x, y, z, cx, cy, cz, rx, ry, rz) {
  return smooth(
    (1 - Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz)) * 5
  )
}

function shapeMask(shape, point) {
  const [x, ecefY, z] = point
  const y = ecefY - MANIFEST.bottomRadius
  const boundary = Math.min(
    ...point.flatMap((value, axis) => [
      (value - MANIFEST.minimum[axis]) / 160,
      (MANIFEST.maximum[axis] - value) / 160
    ])
  )
  if (shape === 'deck') return smooth(boundary)
  const a = lobe(x, y, z, -450, 1300, 0, 700, 500, 720)
  const b = lobe(x, y, z, 380, 1450, -130, 700, 640, 660)
  const c = lobe(x, y, z, 100, 1840, 150, 470, 350, 450)
  if (shape === 'cumulus') return Math.max(a, b, c) * smooth(boundary)
  return (
    Math.max(
      lobe(x, y, z, -800, 1150, -450, 470, 250, 420),
      lobe(x, y, z, 550, 1200, 600, 650, 300, 500),
      lobe(x, y, z, 750, 1260, -750, 450, 350, 400)
    ) * smooth(boundary)
  )
}

export function makeFixture(
  shape = 'cumulus',
  thickness = 1,
  size = MANIFEST.volumeSize
) {
  if (
    !MANIFEST.shapes.includes(shape) ||
    !MANIFEST.thickness.includes(thickness)
  )
    throw new Error('Unknown frozen fixture')
  if (!Number.isInteger(size) || size < 8 || size > 128)
    throw new Error('Invalid voxel resolution')
  const scene = {
    ...SCENE,
    coverage: 0.85,
    shapeDetail: false,
    turbulence: false
  }
  const layers = LAYERS.map((layer, i) => ({
    ...layer,
    height: i === 0 ? 1450 : 0,
    altitude: 750,
    shapeAmount: 0.45,
    densityScale: 0.012 * thickness
  }))
  const evaluate = createDensityEvaluator(loadAssets(), scene, layers)
  const data = new Uint16Array(size ** 3)
  let nonzero = 0
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const point = [x, y, z].map(
          (v, axis) =>
            MANIFEST.minimum[axis] +
            ((v + 0.5) / size) *
              (MANIFEST.maximum[axis] - MANIFEST.minimum[axis])
        )
        const value =
          evaluate.densityAt(point, 0).densitySum * shapeMask(shape, point)
        const index = (z * size + y) * size + x
        data[index] = DataUtils.toHalfFloat(value)
        if (data[index] !== 0) nonzero++
      }
  if (!nonzero) throw new Error('Fixture has zero occupied voxels')
  return {
    shape,
    thickness,
    size,
    data,
    nonzero,
    minimum: MANIFEST.minimum,
    maximum: MANIFEST.maximum,
    hash: createHash('sha256').update(new Uint8Array(data.buffer)).digest('hex')
  }
}

export function boxInterval(origin, direction, minimum, maximum) {
  let start = 0
  let end = Infinity
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis])
        return null
      continue
    }
    const a = (minimum[axis] - origin[axis]) / direction[axis]
    const b = (maximum[axis] - origin[axis]) / direction[axis]
    start = Math.max(start, Math.min(a, b))
    end = Math.min(end, Math.max(a, b))
  }
  return end > start ? [start, end] : null
}

export function voxelMedium(fixture, scattering = 1, absorption = 0) {
  const { size, minimum, maximum } = fixture
  const data = Float32Array.from(fixture.data, DataUtils.fromHalfFloat)
  const extent = maximum.map((value, axis) => value - minimum[axis])
  const index = (x, y, z) => (z * size + y) * size + x
  function density(point) {
    const u = (point[0] - minimum[0]) / extent[0]
    const v = (point[1] - minimum[1]) / extent[1]
    const w = (point[2] - minimum[2]) / extent[2]
    if (u < 0 || u > 1 || v < 0 || v > 1 || w < 0 || w > 1) return 0
    const x = u * size - 0.5,
      y = v * size - 0.5,
      z = w * size - 0.5
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z)
    const fx = x - ix,
      fy = y - iy,
      fz = z - iz
    const x0 = Math.max(0, ix),
      y0 = Math.max(0, iy),
      z0 = Math.max(0, iz)
    const x1 = Math.min(size - 1, ix + 1),
      y1 = Math.min(size - 1, iy + 1),
      z1 = Math.min(size - 1, iz + 1)
    const a = data[index(x0, y0, z0)] * (1 - fx) + data[index(x1, y0, z0)] * fx
    const b = data[index(x0, y1, z0)] * (1 - fx) + data[index(x1, y1, z0)] * fx
    const c = data[index(x0, y0, z1)] * (1 - fx) + data[index(x1, y0, z1)] * fx
    const d = data[index(x0, y1, z1)] * (1 - fx) + data[index(x1, y1, z1)] * fx
    return (a * (1 - fy) + b * fy) * (1 - fz) + (c * (1 - fy) + d * fy) * fz
  }
  const majorant =
    data.reduce((highest, value) => Math.max(highest, value), 0) *
    (scattering + absorption)
  function track(origin, direction, rng, collision) {
    const interval = boxInterval(origin, direction, minimum, maximum)
    if (interval == null || majorant === 0) return collision ? null : 1
    let distance = interval[0]
    let transmission = 1
    for (let iteration = 0; iteration < 1000000; iteration++) {
      distance += -Math.log1p(-rng()) / majorant
      if (distance >= interval[1]) return collision ? null : transmission
      const point = [
        origin[0] + direction[0] * distance,
        origin[1] + direction[1] * distance,
        origin[2] + direction[2] * distance
      ]
      const probability =
        (density(point) * (scattering + absorption)) / majorant
      if (probability > 1 + 1e-10 || probability < 0)
        throw new Error('Invalid extinction majorant')
      if (collision) {
        if (rng() < probability) return { point, distance }
      } else {
        transmission *= 1 - probability
        if (transmission === 0) return 0
      }
    }
    throw new Error('Tracking budget exhausted')
  }

  return {
    density,
    majorant,
    sampleCollision: (origin, direction, rng) =>
      track(origin, direction, rng, true),
    transmittance: (origin, direction, rng) =>
      track(origin, direction, rng, false),
    extinctionAt: point => density(point) * (scattering + absorption),
    densityAt: point => {
      const d = density(point)
      return {
        extinction: d * (scattering + absorption),
        scattering: d * scattering
      }
    },
    intervals: (origin, direction) => {
      const interval = boxInterval(origin, direction, minimum, maximum)
      return interval ? [interval] : []
    }
  }
}
