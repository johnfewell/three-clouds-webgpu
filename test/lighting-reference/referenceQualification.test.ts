import { expect, test } from 'vitest'

import { sphereDirections } from '../../scripts/lighting-experiments/quadrature.mjs'
import {
  createHomogeneousMedium,
  createRng,
  samplePhaseDirection,
  traceInScatteredRadiance
} from '../../scripts/lighting-reference/medium.mjs'
import { phaseFunction } from '../../src/lighting/phaseFunction'
import { log, setCurrentSpec } from '../helpers/log'

const scene = {
  stepSize: 2,
  shadowStepSize: 2,
  scatterAnisotropy1: 0.7,
  scatterAnisotropy2: -0.2,
  scatterAnisotropyMix: 0.5
}
const options = {
  origin: [0, 0, 0],
  direction: [0, 0, 1],
  sunDirection: [0, 0, 1],
  scene,
  medium: createHomogeneousMedium({
    height: 100,
    sigmaS: 0.005,
    sigmaT: 0.005
  }),
  samples: 100000,
  seed: 7,
  maxBounces: 32
}

test.each([7, 987654321])(
  'uniform surrounding sky conserves energy, seed %s',
  seed => {
    setCurrentSpec('lighting-reference-qualification')
    const traced = traceInScatteredRadiance({
      ...options,
      seed,
      skyRadiance: () => [1, 0.5, 0.25]
    })
    const expected = 1 - Math.exp(-0.5)
    expect(traced.truncatedSamples).toBe(0)
    expect(Math.abs(traced.sky[0]! - expected)).toBeLessThan(0.006)
    expect(traced.sky[1]).toBeCloseTo(traced.sky[0]! * 0.5, 12)
    expect(traced.sky[2]).toBeCloseTo(traced.sky[0]! * 0.25, 12)
    expect(traced.skySingle[0]).toBeLessThan(traced.sky[0]!)
    log(`uniform-sky-${seed}`, {
      expected,
      actual: traced.sky[0],
      truncated: traced.truncatedSamples
    })
  }
)

test('zero sky produces zero sky light, and camera background is excluded', () => {
  expect(
    traceInScatteredRadiance({
      ...options,
      samples: 1000,
      skyRadiance: () => [0, 0, 0]
    }).sky
  ).toEqual([0, 0, 0])
  const empty = createHomogeneousMedium({ height: 100, sigmaS: 0, sigmaT: 0 })
  expect(
    traceInScatteredRadiance({
      ...options,
      medium: empty,
      samples: 1000,
      skyRadiance: () => [1, 1, 1]
    }).sky
  ).toEqual([0, 0, 0])
})

test('reports bounce truncation instead of claiming a converged reference', () => {
  const result = traceInScatteredRadiance({
    ...options,
    samples: 1000,
    maxBounces: 0,
    skyRadiance: () => [1, 1, 1]
  })
  expect(result.truncatedSamples).toBeGreaterThan(0)
  expect(result.sky).toEqual(result.skySingle)
})

test('phase-mixture continuation has unit weight and the expected first moment', () => {
  const rng = createRng(7)
  let moment = 0
  for (let i = 0; i < 100000; i++) {
    const sample = samplePhaseDirection([0, 0, 1], scene, rng)
    expect(sample.weight).toBe(1)
    moment += sample.direction[2]!
  }
  expect(moment / 100000).toBeCloseTo(0.25, 2)
})

test('invalid budgets fail loudly', () => {
  expect(() => traceInScatteredRadiance({ ...options, samples: 0 })).toThrow(
    'samples'
  )
  expect(() =>
    traceInScatteredRadiance({ ...options, scene: { ...scene, stepSize: 0 } })
  ).toThrow('stepSize')
})

test('rejects invalid physical inputs and artificial path clipping', () => {
  expect(() =>
    createHomogeneousMedium({ height: 100, sigmaS: 0.02, sigmaT: 0.01 })
  ).toThrow('Invalid homogeneous')
  expect(() =>
    traceInScatteredRadiance({ ...options, direction: [0, 0, 2] })
  ).toThrow('unit direction')
  expect(() =>
    traceInScatteredRadiance({ ...options, maxDistance: 100 })
  ).toThrow('boundary model')
  expect(() =>
    traceInScatteredRadiance({
      ...options,
      scene: { ...scene, scatterAnisotropy1: 1 }
    })
  ).toThrow('strictly between')
  expect(() =>
    traceInScatteredRadiance({
      ...options,
      medium: { ...options.medium, extinctionAt: () => NaN }
    })
  ).toThrow('Extinction')
})

test('colored hemispheres agree with independent single-scattering quadrature', () => {
  const directions = sphereDirections(2048)
  const sky = (direction: readonly number[]) =>
    direction[2]! > 0 ? [1, 0.1, 0.2] : [0.2, 0.4, 1]
  const expected = [0, 0, 0]
  const steps = 256
  for (let step = 0; step < steps; step++) {
    const z = ((step + 0.5) * 100) / steps
    const cameraWeight = (0.01 * Math.exp(-0.02 * z) * 100) / steps
    for (const direction of directions) {
      const dz = direction[2]!
      const distance = dz > 0 ? (100 - z) / dz : -z / dz
      const phase = phaseFunction(dz, 1, 0.7, -0.2, 0.5)
      const weight =
        (cameraWeight * phase * Math.exp(-0.02 * distance) * 4 * Math.PI) /
        directions.length
      const incident = sky(direction)
      for (let channel = 0; channel < 3; channel++)
        expected[channel]! += weight * incident[channel]!
    }
  }
  const traced = traceInScatteredRadiance({
    ...options,
    medium: createHomogeneousMedium({
      height: 100,
      sigmaS: 0.01,
      sigmaT: 0.02
    }),
    samples: 200000,
    maxBounces: 0,
    skyRadiance: sky
  })
  for (let channel = 0; channel < 3; channel++) {
    expect(
      Math.abs(traced.skySingle[channel]! - expected[channel]!)
    ).toBeLessThan(0.002)
    log(`colored-sky-channel-${channel}`, {
      actual: traced.skySingle[channel],
      expected: expected[channel]
    })
  }
})

test('isotropic upper sky matches the closed-form 100 m slab at 200k samples', () => {
  // For tau=2: I=0.5*[exp(-tau)*(ln(tau)+gamma)-(tau-1)*E1(tau)]
  // E1(2)=0.04890051070806112, obtained from its defining exponential integral
  const expected =
    0.5 *
    (Math.exp(-2) * (Math.log(2) + 0.5772156649015329) - 0.04890051070806112)
  const traced = traceInScatteredRadiance({
    ...options,
    medium: createHomogeneousMedium({
      height: 100,
      sigmaS: 0.02,
      sigmaT: 0.02
    }),
    scene: { ...scene, scatterAnisotropy1: 0, scatterAnisotropy2: 0 },
    samples: 200000,
    maxBounces: 0,
    skyRadiance: direction => (direction[2]! > 0 ? [1, 1, 1] : [0, 0, 0])
  })
  expect(Math.abs(traced.skySingle[0]! - expected)).toBeLessThan(0.0015)
  const expectedSun = (2 * Math.exp(-2)) / (4 * Math.PI)
  expect(Math.abs(traced.single - expectedSun)).toBeLessThan(0.0015)
  log('isotropic-slab-sky', {
    actual: traced.skySingle[0],
    expected,
    samples: 200000
  })
  log('isotropic-slab-sun', { actual: traced.single, expected: expectedSun })
})
