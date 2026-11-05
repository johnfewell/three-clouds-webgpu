import { DataUtils } from 'three'
import { expect, test } from 'vitest'

import {
  makeFixture,
  voxelMedium,
  type Fixture
} from '../../scripts/lighting-experiments/fixtures.mjs'
import { makePhaseWeights } from '../../scripts/lighting-experiments/skyCache.mjs'
import {
  createRng,
  traceInScatteredRadiance
} from '../../scripts/lighting-reference/medium.mjs'
import { log } from '../helpers/log'

function constantFixture(): Fixture {
  return {
    shape: 'test',
    thickness: 1,
    size: 2,
    data: new Uint16Array(8).fill(DataUtils.toHalfFloat(0.01)),
    nonzero: 8,
    minimum: [0, 0, 0],
    maximum: [100, 100, 100],
    hash: 'test'
  }
}

test('bounded ratio and delta tracking match homogeneous attenuation', () => {
  const medium = voxelMedium(constantFixture())
  const rng = createRng(7)
  let transmission = 0,
    hits = 0
  for (let i = 0; i < 100000; i++) {
    transmission += medium.transmittance([50, 0, 50], [0, 1, 0], rng)
    if (medium.sampleCollision([50, 0, 50], [0, 1, 0], rng)) hits++
  }
  const expected = Math.exp(-100 * medium.majorant)
  expect(Math.abs(transmission / 100000 - expected)).toBeLessThan(0.005)
  expect(Math.abs(hits / 100000 - (1 - expected))).toBeLessThan(0.005)
  log('voxel-tracking', { transmission: transmission / 100000, expected })
})

test('full multiple-scattering sky conserves energy in the bounded voxel fixture', () => {
  const medium = voxelMedium(constantFixture())
  const traced = traceInScatteredRadiance({
    origin: [50, 0, 50],
    direction: [0, 1, 0],
    sunDirection: [0, 1, 0],
    medium,
    scene: {
      stepSize: 1,
      shadowStepSize: 1,
      scatterAnisotropy1: 0.7,
      scatterAnisotropy2: -0.2,
      scatterAnisotropyMix: 0.5
    },
    samples: 200000,
    seed: 7,
    maxBounces: 64,
    skyRadiance: () => [1, 1, 1]
  })
  const expected = 1 - Math.exp(-100 * medium.majorant)
  expect(Math.abs(traced.sky[0]! - expected)).toBeLessThan(0.005)
  expect(traced.truncatedSamples).toBe(0)
  log('voxel-sky', { actual: traced.sky[0], expected })
})

test.each(['cumulus', 'deck', 'broken'])(
  '%s fixture is occupied and its trilinear majorant holds',
  shape => {
    const fixture = makeFixture(shape, 1, 16)
    const medium = voxelMedium(fixture)
    expect(fixture.nonzero).toBeGreaterThan(0)
    const rng = createRng(19)
    for (let i = 0; i < 1000; i++) {
      const point = fixture.minimum.map(
        (value, axis) => value + rng() * (fixture.maximum[axis]! - value)
      )
      expect(medium.extinctionAt(point)).toBeLessThanOrEqual(medium.majorant)
    }
    log(`fixture-${shape}`, {
      occupied: fixture.nonzero,
      majorant: medium.majorant
    })
  }
)

test('integrated half-float phase tables conserve uniform-sky energy', () => {
  const tables = makePhaseWeights(16, 8, 2048)
  for (let i = 0; i < 16 * 8; i++) {
    let sum = 0
    for (const table of tables.tables)
      for (let c = 0; c < 4; c++)
        sum += DataUtils.fromHalfFloat(table[i * 4 + c]!)
    expect(Math.abs(sum - 1)).toBeLessThan(0.002)
  }
})
