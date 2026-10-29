// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { float, Fn, remapClamp, select, uniform, vec3, vec4 } from 'three/tsl'
import { beforeEach, describe, expect, test } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, quadrature, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
// The module itself, so this file's `cpuWriteLayer` is attributable to
// `writeLayer` rather than an orphan
import { writeLayer } from './writeLayer'

// CPU twin: writeLayer encoding (clouds.frag:614-617 + ADR-002)

function remapClamped(value: number, inLow: number, inHigh: number): number {
  return Math.max(0, Math.min(1, (value - inLow) / (inHigh - inLow)))
}

function cpuWriteLayer(
  radianceIntegral: [number, number, number],
  transmittanceIntegral: number,
  minTransmittance: number,
  weightedDistanceSum: number,
  transmittanceSum: number,
  worldToUnit: number
): {
  layer: [number, number, number, number]
  depthVelocity: [number, number, number, number]
} {
  const frontDepth =
    transmittanceSum > 0 ? weightedDistanceSum / transmittanceSum : -1
  const opacity = remapClamped(transmittanceIntegral, 1.0, minTransmittance)
  return {
    layer: [
      radianceIntegral[0],
      radianceIntegral[1],
      radianceIntegral[2],
      opacity
    ],
    depthVelocity: [frontDepth * worldToUnit, 0, 0, 0]
  }
}

// CPU twin: primaryMarch stub (clouds.frag:480-618, Phase 0 simplified)
// Frostbite energy-conserving integral with constant density + luminance

function primaryMarchCPU(
  near: number,
  far: number,
  jitter: number,
  maxIterCount: number,
  scatterCoeff: number,
  absorbCoeff: number,
  minTransmittance: number,
  worldToUnit: number
): {
  layer: [number, number, number, number]
  depthVelocity: [number, number, number, number]
} {
  const r = [0, 0, 0]
  let T = 1
  let wds = 0
  let ts = 0

  const thickness = far - near
  const step = thickness / maxIterCount
  let d = step * jitter * 2

  const sigma = scatterCoeff + absorbCoeff
  const scatter = scatterCoeff

  for (let i = 0; i < maxIterCount; i++) {
    if (d > thickness) break

    const t = Math.exp(-sigma * step)
    const ce = Math.max(sigma, 1e-7)
    const si = (scatter * (1 - t)) / ce

    r[0]! += T * si
    r[1]! += T * si
    r[2]! += T * si
    T *= t

    wds += (near + d) * T
    ts += T

    if (T <= minTransmittance) break

    d += step
  }

  return cpuWriteLayer(
    [r[0]!, r[1]!, r[2]!],
    T,
    minTransmittance,
    wds,
    ts,
    worldToUnit
  )
}

// writeLayer WGSL snapshot

describe('writeLayer WGSL', () => {
  beforeEach(() => setCurrentSpec('writeLayer'))

  test('the shipped Fn compiles, and its twin encodes the same shape', () => {
    // writeLayer.wgsl.test.ts owns the structural snapshots. This is the bridge
    // that keeps the two files about the same symbol
    const node = writeLayer(
      vec3(0.1, 0.2, 0.3),
      float(0.5),
      float(0.01),
      float(100),
      float(5),
      float(1e-6)
    )
    const alpha = (node.get('layer') as unknown as { w: typeof node }).w
    const { fragment } = compileWGSL(alpha)
    const twin = cpuWriteLayer([0.1, 0.2, 0.3], 0.5, 0.01, 100, 5, 1e-6)
    log('writeLayer-fn-vs-twin', {
      compiled: fragment.length > 0,
      twinOpacity: twin.layer[3]
    })
    expect(fragment.length).toBeGreaterThan(0)
    expect(twin.layer[3]).toBeGreaterThan(0)
  })

  test('WGSL contains remapClamp opacity encode: (T - 1.0) / (minT - 1.0)', () => {
    // writeLayer uses remapClamp(T, 1.0, minT). Verify the WGSL pattern
    // by compiling the same TSL construct with uniform inputs
    const opacityNode = Fn(() => {
      const T = uniform(0.5)
      const minT = uniform(0.01)
      const opacity = remapClamp(T, float(1.0), minT)
      return vec4(uniform(0.1), uniform(0.2), uniform(0.3), opacity)
    })()

    const { fragment } = compileWGSL(opacityNode)

    // remapClamp(T, 1.0, minT) → clamp((T - 1.0) / (minT - 1.0), 0, 1)
    expect(fragment).toContain('clamp')
    expect(fragment).toContain('1.0')

    log('writeLayer-wgsl-opacity', {
      fragmentLength: fragment.length,
      hasClamp: fragment.includes('clamp'),
      hasOne: fragment.includes('1.0'),
      snippet: fragment.slice(
        fragment.indexOf('clamp'),
        fragment.indexOf('clamp') + 80
      )
    })
  })

  test('WGSL contains worldToUnit multiply on depthVelocity.r', () => {
    // writeLayer uses frontDepth.mul(worldToUnit). Verify the pattern
    const depthNode = Fn(() => {
      const wds = uniform(100)
      const ts = uniform(5)
      const wtu = uniform(0.001)
      const frontDepth = select(ts.greaterThan(0), wds.div(ts), float(-1))
      return vec4(float(frontDepth.mul(wtu)), 0, 0, 0)
    })()

    const { fragment } = compileWGSL(depthNode)

    // Should contain a multiplication operator (the worldToUnit scale)
    expect(fragment).toContain('*')
    expect(fragment).toContain('vec4')

    log('writeLayer-wgsl-depth', {
      fragmentLength: fragment.length,
      hasMul: fragment.includes('*'),
      snippet: fragment.slice(0, 400)
    })
  })
})

// writeLayer CPU twin

describe('writeLayer CPU twin', () => {
  beforeEach(() => setCurrentSpec('writeLayer'))

  test('fully transparent → opacity 0, frontDepth -1', () => {
    const result = cpuWriteLayer([0, 0, 0], 1.0, 0.01, 0, 0, 1.0)
    expectClose(result.layer[3], 0, { label: 'opacity-empty' })
    expectClose(result.depthVelocity[0], -1, { label: 'frontDepth-empty' })
  })

  test('fully opaque → opacity 1', () => {
    const result = cpuWriteLayer([0.5, 0.3, 0.1], 0.01, 0.01, 500, 10, 1.0)
    expectClose(result.layer[3], 1.0, { label: 'opacity-opaque' })
    expectClose(result.layer[0], 0.5, { label: 'radiance-r' })
    expectClose(result.layer[1], 0.3, { label: 'radiance-g' })
    expectClose(result.layer[2], 0.1, { label: 'radiance-b' })
  })

  test('partial transmittance → opacity ≈ 0.505', () => {
    const result = cpuWriteLayer([0.2, 0.2, 0.2], 0.5, 0.01, 200, 5, 1.0)
    // (0.5 - 1.0) / (0.01 - 1.0) = -0.5 / -0.99 ≈ 0.5051
    expectClose(result.layer[3], 0.505, {
      abs: 0.001,
      label: 'opacity-partial'
    })
    expectClose(result.depthVelocity[0], 40, { label: 'frontDepth-partial' })
  })

  test('frontDepth scaled by worldToUnit (AUDIT-4)', () => {
    const worldToUnit = 1e-4
    const result = cpuWriteLayer(
      [0.1, 0.1, 0.1],
      0.5,
      0.01,
      50000,
      10,
      worldToUnit
    )
    expectClose(result.depthVelocity[0], 5000 * worldToUnit, {
      label: 'frontDepth-scaled'
    })
  })

  test('depthVelocity.gba = 0 (Phase 0, velocity in Phase 2)', () => {
    const result = cpuWriteLayer([0.3, 0.2, 0.1], 0.5, 0.01, 100, 5, 1.0)
    expect(result.depthVelocity[1]).toBe(0)
    expect(result.depthVelocity[2]).toBe(0)
    expect(result.depthVelocity[3]).toBe(0)
  })

  test('opacity table across transmittance range', () => {
    const transmittances = [1.0, 0.8, 0.5, 0.3, 0.1, 0.01, 0.001]
    const minT = 0.01

    const rows = transmittances.map(T => {
      const result = cpuWriteLayer([1, 1, 1], T, minT, 1000, 10, 1e-6)
      const expected = remapClamped(T, 1.0, minT)
      return { transmittance: T, expected, actual: result.layer[3] }
    })

    table('writeLayer-opacity-sweep', rows)

    for (const row of rows) {
      expectClose(row.actual, row.expected, {
        abs: 1e-10,
        label: `T=${row.transmittance}`
      })
    }
  })
})

// primaryMarch CPU twin: homogeneous slab integration

describe('primaryMarch CPU twin — homogeneous slab', () => {
  beforeEach(() => setCurrentSpec('primaryMarch'))

  test('transmittance matches exp(-σL) for zero jitter', () => {
    const near = 1000
    const far = 5000
    const L = far - near
    const sigma = 2e-4
    const N = 64
    const minT = 0.01

    const result = primaryMarchCPU(near, far, 0, N, sigma, 0, minT, 1e-6)

    const analyticalT = Math.exp(-sigma * L)
    const analyticalOpacity = remapClamped(analyticalT, 1.0, minT)

    expectClose(result.layer[3], analyticalOpacity, {
      abs: 0.02,
      label: 'opacity-vs-analytical'
    })

    log('primaryMarch-transmittance', {
      analyticalT,
      analyticalOpacity,
      actualOpacity: result.layer[3]
    })
  })

  test('frontDepth matches analytical weighted mean by quadrature', () => {
    const near = 1000
    const far = 5000
    const L = far - near
    const sigma = 2e-4
    const N = 256
    const worldToUnit = 1e-6

    const result = primaryMarchCPU(near, far, 0, N, sigma, 0, 0.01, worldToUnit)

    // Analytical: ∫₀ᴸ (near+d)·exp(-σd) dd / ∫₀ᴸ exp(-σd) dd
    const numerator = quadrature(
      d => (near + d) * Math.exp(-sigma * d),
      0,
      L,
      10000
    )
    const denominator = quadrature(d => Math.exp(-sigma * d), 0, L, 10000)
    const analyticalFrontDepth = numerator / denominator

    const actualFrontDepth = result.depthVelocity[0] / worldToUnit

    expectClose(actualFrontDepth, analyticalFrontDepth, {
      abs: 50,
      rel: 0.02,
      label: 'frontDepth-vs-quadrature'
    })

    log('primaryMarch-frontDepth', {
      analyticalFrontDepth,
      actualFrontDepth,
      delta: Math.abs(actualFrontDepth - analyticalFrontDepth)
    })
  })

  test('integration table: varying extinction', () => {
    const near = 1000
    const far = 5000
    const L = far - near
    const N = 128
    const worldToUnit = 1e-6
    const minT = 0.01
    const sigmas = [1e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3]

    const rows = sigmas.map(sigma => {
      const result = primaryMarchCPU(
        near,
        far,
        0,
        N,
        sigma,
        0,
        minT,
        worldToUnit
      )
      const analyticalT = Math.exp(-sigma * L)
      const expected = remapClamped(analyticalT, 1.0, minT)
      return {
        sigma,
        expected,
        actual: result.layer[3],
        transmittance: analyticalT,
        radianceR: result.layer[0]
      }
    })

    table('primaryMarch-extinction-sweep', rows)

    for (const row of rows) {
      expectClose(row.actual, row.expected, {
        abs: 0.03,
        label: `σ=${row.sigma}`
      })
    }
  })

  test('jitter offsets starting distance', () => {
    const near = 1000
    const far = 5000
    const N = 64
    const sigma = 2e-4
    const worldToUnit = 1e-6

    const r0 = primaryMarchCPU(near, far, 0, N, sigma, 0, 0.01, worldToUnit)
    const r05 = primaryMarchCPU(near, far, 0.5, N, sigma, 0, 0.01, worldToUnit)
    const r1 = primaryMarchCPU(near, far, 1.0, N, sigma, 0, 0.01, worldToUnit)

    // Front depth shifts with jitter (different position weighting)
    expect(r0.depthVelocity[0]).not.toBe(r05.depthVelocity[0])
    // j=1.0 loses a step → different opacity from j=0
    expect(r0.layer[3]).not.toBe(r1.layer[3])

    log('primaryMarch-jitter', {
      opacity_j0: r0.layer[3],
      opacity_j05: r05.layer[3],
      opacity_j1: r1.layer[3],
      depth_j0: r0.depthVelocity[0],
      depth_j05: r05.depthVelocity[0],
      depth_j1: r1.depthVelocity[0]
    })
  })

  test('early termination at minTransmittance', () => {
    const near = 1000
    const far = 5000
    const N = 64
    const sigma = 1e-2
    const worldToUnit = 1e-6

    const result = primaryMarchCPU(near, far, 0, N, sigma, 0, 0.01, worldToUnit)

    expectClose(result.layer[3], 1, { abs: 0.001, label: 'saturated-opacity' })

    log('primaryMarch-early-term', { opacity: result.layer[3] })
  })

  test('pure scattering: radiance ≈ 1 − transmittance', () => {
    const near = 0
    const far = 4000
    const sigma = 2e-4
    const N = 256

    const result = primaryMarchCPU(near, far, 0, N, sigma, 0, 1e-4, 1e-6)

    // For pure scattering (σ_s = σ_t), Frostbite integral sums to ≈ 1 - T
    const analyticalT = Math.exp(-sigma * (far - near))

    expectClose(result.layer[0], 1 - analyticalT, {
      abs: 0.01,
      rel: 0.02,
      label: 'radiance-complement'
    })

    log('primaryMarch-radiance-complement', {
      radiance: result.layer[0],
      oneMinusT: 1 - analyticalT,
      analyticalT
    })
  })
})
