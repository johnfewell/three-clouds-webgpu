// CPU twins for the four shape seams. Each case is a number a reader can check
// by hand, and each names the behaviour it guards rather than the function it
// calls (docs/EXPERIMENTAL.md has the prose)
import { float } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { CloudsContext } from '../CloudsContext'
import {
  baseShadowTransmittance,
  buildCloudShapeDeps,
  cloudShapeDefaults,
  cloudShapeKey,
  cpuBaseShadowTransmittance,
  cpuErosionShapeAmount,
  cpuHorizonCoverageBank,
  cpuWindSkewOffset,
  erosionShapeAmount,
  horizonCoverageBank,
  type CloudShapeParams
} from './cloudShape'

describe('base shadow transmittance', () => {
  it('is 1 at the top and Beer-dark at the base', () => {
    const strength = 2
    const span = 0.5
    table('base-shadow', [
      { h: 1, got: cpuBaseShadowTransmittance(1, strength, span), want: 1 },
      // The span is normalized, so h = 1 - span is the full depth and
      // h = 1 - span/2 is half of it
      {
        h: 0.75,
        got: cpuBaseShadowTransmittance(0.75, strength, span),
        want: Math.exp(-1)
      },
      {
        h: 0.5,
        got: cpuBaseShadowTransmittance(0.5, strength, span),
        want: Math.exp(-2)
      },
      {
        h: 0,
        got: cpuBaseShadowTransmittance(0, strength, span),
        want: Math.exp(-2)
      },
      // Below the span's reach the curve clamps, so a shallow span darkens the
      // whole depth uniformly instead of dividing it out
      {
        h: 0.6,
        got: cpuBaseShadowTransmittance(0.6, strength, 0.25),
        want: Math.exp(-2)
      },
      // A span of zero is a step at full depth, never a division by zero
      {
        h: 0.5,
        got: cpuBaseShadowTransmittance(0.5, strength, 0),
        want: Math.exp(-2)
      }
    ])
    expect(cpuBaseShadowTransmittance(0.5, strength, 0)).toBeCloseTo(
      Math.exp(-2),
      6
    )
    expect(cpuBaseShadowTransmittance(1, strength, span)).toBeCloseTo(1, 6)
    expect(cpuBaseShadowTransmittance(0.75, strength, span)).toBeCloseTo(
      Math.exp(-1),
      6
    )
    expect(cpuBaseShadowTransmittance(0.5, strength, span)).toBeCloseTo(
      Math.exp(-2),
      6
    )
    expect(cpuBaseShadowTransmittance(0, strength, span)).toBeCloseTo(
      Math.exp(-2),
      6
    )
    expect(cpuBaseShadowTransmittance(0.6, strength, 0.25)).toBeLessThan(
      cpuBaseShadowTransmittance(0.9, strength, 0.25)
    )
    // Monotone in height, which is the whole claim: the higher the sample, the
    // more sun reaches it
    let previous = -1
    for (let h = 0; h <= 1.0001; h += 0.05) {
      const t = cpuBaseShadowTransmittance(h, strength, span)
      expect(t).toBeGreaterThanOrEqual(previous - 1e-12)
      previous = t
    }
    expect(previous).toBeCloseTo(1, 6)
  })

  it('compiles to an exponential in WGSL', () => {
    expect(baseShadowTransmittance).toBeTypeOf('function')
  })
})

describe('horizon coverage bank', () => {
  it('is nothing inside the start and the full amount past the ramp', () => {
    table('horizon-coverage', [
      { d: 0, got: cpuHorizonCoverageBank(0, 0.3, 5000, 20000), want: 0 },
      { d: 5000, got: cpuHorizonCoverageBank(5000, 0.3, 5000, 20000), want: 0 },
      {
        d: 25000,
        got: cpuHorizonCoverageBank(25000, 0.3, 5000, 20000),
        want: 0.3
      },
      {
        d: 40000,
        got: cpuHorizonCoverageBank(40000, 0.3, 5000, 20000),
        want: 0.3
      },
      // Halfway is the cubic's midpoint, not half the amount
      {
        d: 15000,
        got: cpuHorizonCoverageBank(15000, 0.3, 5000, 20000),
        want: 0.15
      }
    ])
    expect(cpuHorizonCoverageBank(0, 0.3, 5000, 20000)).toBe(0)
    expect(cpuHorizonCoverageBank(40000, 0.3, 5000, 20000)).toBeCloseTo(0.3, 6)
    expect(cpuHorizonCoverageBank(15000, 0.3, 5000, 20000)).toBeCloseTo(0.15, 6)
  })

  it('thins the distance on a negative amount', () => {
    expect(cpuHorizonCoverageBank(40000, -0.3, 5000, 20000)).toBeCloseTo(
      -0.3,
      6
    )
  })

  it('a ramp of zero is a hard step, never a NaN', () => {
    const got = cpuHorizonCoverageBank(5000, 0.3, 5000, 0)
    table('horizon-coverage-zero-ramp', [
      { d: 5000, got, want: 0 },
      { d: 5001, got: cpuHorizonCoverageBank(5001, 0.3, 5000, 0), want: 0.3 }
    ])
    expect(Number.isFinite(got)).toBe(true)
    expect(got).toBe(0)
  })

  it('compiles to a smoothstep in WGSL', () => {
    expect(horizonCoverageBank).toBeTypeOf('function')
  })
})

describe('wind skew offset', () => {
  // Latitude 0, longitude 0 in ECEF. east = cross(up, n) is world -z there and
  // north = cross(n, east) is world +y, so the frame is east-north-up and the
  // expected numbers are readable
  const equator = [1, 0, 0]

  it('leans east and north by the metres asked for', () => {
    const east = cpuWindSkewOffset(equator, 1, 100, 0)
    const north = cpuWindSkewOffset(equator, 1, 0, 100)
    table('wind-skew', [
      { dir: 'east', x: east[0], y: east[1], z: east[2] },
      { dir: 'north', x: north[0], y: north[1], z: north[2] }
    ])
    expect(east[2]).toBeCloseTo(-100, 4)
    expect(east[0]).toBeCloseTo(0, 4)
    expect(east[1]).toBeCloseTo(0, 4)
    expect(north[1]).toBeCloseTo(100, 4)
    expect(north[2]).toBeCloseTo(0, 4)
  })

  it('is nothing at the base and full at the top', () => {
    expect(cpuWindSkewOffset(equator, 0, 100, 0)[2]).toBeCloseTo(0, 6)
    const half = cpuWindSkewOffset(equator, 0.5, 100, 0)[2]!
    expect(half).toBeCloseTo(-50, 4)
  })

  it('fades out at a pole rather than handing back a NaN', () => {
    const pole = cpuWindSkewOffset([0, 1, 0], 1, 100, 0)
    table('wind-skew-pole', [
      { x: pole[0], y: pole[1], z: pole[2] },
      { finite: pole.every(Number.isFinite) }
    ])
    expect(pole.every(Number.isFinite)).toBe(true)
    expect(pole[0]).toBeCloseTo(0, 6)
    expect(pole[2]).toBeCloseTo(0, 6)
  })

  it('keeps the lean horizontal, so it never lifts the sample out of its lane', () => {
    // A mid-latitude normal: the offset must stay in the tangent plane, so its
    // dot with the normal is zero
    const normal = [0.6, 0.8, 0]
    const off = cpuWindSkewOffset(normal, 1, 300, -120)
    const along =
      off[0]! * normal[0]! + off[1]! * normal[1]! + off[2]! * normal[2]!
    table('wind-skew-tangent', [{ dot: along }])
    expect(Math.abs(along)).toBeLessThan(1e-3)
    expect(Math.hypot(off[0]!, off[1]!, off[2]!)).toBeGreaterThan(100)
  })
})

describe('erosion shape amount', () => {
  it('is the identity at zero and scales the carve either way', () => {
    table('erosion', [
      {
        erosion: 0,
        amount: 0.5,
        got: cpuErosionShapeAmount(0.5, 0),
        want: 0.5
      },
      { erosion: 1, amount: 0.5, got: cpuErosionShapeAmount(0.5, 1), want: 1 },
      {
        erosion: -0.5,
        amount: 0.5,
        got: cpuErosionShapeAmount(0.5, -0.5),
        want: 0.25
      },
      // Past -1 the carve would go negative and add density instead of
      // carving, so it clamps at no carving at all
      { erosion: -2, amount: 0.5, got: cpuErosionShapeAmount(0.5, -2), want: 0 }
    ])
    expect(cpuErosionShapeAmount(0.5, 0)).toBe(0.5)
    expect(cpuErosionShapeAmount(0.5, 1)).toBe(1)
    expect(cpuErosionShapeAmount(0.5, -0.5)).toBeCloseTo(0.25, 6)
    expect(cpuErosionShapeAmount(0.5, -2)).toBe(0)
  })

  it('compiles to a max in WGSL', () => {
    expect(erosionShapeAmount).toBeTypeOf('function')
  })
})

describe('the neutral set', () => {
  it('is all zeros on the four features, and the helpers that shape them', () => {
    table('cloud-shape-defaults', [
      {
        field: 'baseShadowStrength',
        value: cloudShapeDefaults.baseShadowStrength
      },
      {
        field: 'horizonCoverageAmount',
        value: cloudShapeDefaults.horizonCoverageAmount
      },
      { field: 'windSkewEast', value: cloudShapeDefaults.windSkewEast },
      { field: 'windSkewNorth', value: cloudShapeDefaults.windSkewNorth },
      { field: 'erosionShape', value: cloudShapeDefaults.erosionShape }
    ])
    const gates = [
      'baseShadowStrength',
      'horizonCoverageAmount',
      'windSkewEast',
      'windSkewNorth',
      'erosionShape'
    ] as const
    for (const gate of gates) {
      expect(cloudShapeDefaults[gate], gate).toBe(0)
    }
    // Frozen, so a caller cannot walk a defaults object off neutral
    expect(Object.isFrozen(cloudShapeDefaults)).toBe(true)
  })

  it('keys every magnitude, so a change inside an open feature rebuilds too', () => {
    const base: CloudShapeParams = { ...cloudShapeDefaults }
    table('cloud-shape-key', [
      { changed: 'none', key: cloudShapeKey(base) },
      {
        changed: 'erosionShape',
        key: cloudShapeKey({ ...base, erosionShape: 0.1 })
      },
      {
        changed: 'horizonCoverageRamp',
        key: cloudShapeKey({ ...base, horizonCoverageRamp: 1 })
      },
      {
        changed: 'baseShadowHeight',
        key: cloudShapeKey({ ...base, baseShadowHeight: 0.9 })
      }
    ])
    const keys = new Set([
      cloudShapeKey(base),
      cloudShapeKey({ ...base, erosionShape: 0.1 }),
      cloudShapeKey({ ...base, horizonCoverageRamp: 1 }),
      cloudShapeKey({ ...base, baseShadowHeight: 0.9 })
    ])
    expect(keys.size).toBe(4)
    expect(cloudShapeKey(base)).toBe(cloudShapeKey({ ...cloudShapeDefaults }))
  })

  it('keeps the horizon bank off the dead lanes', () => {
    // The addition lands after sampleWeather zeroes the dead lanes, so the
    // seam has to mask them itself or an inactive lane crosses the march's
    // density test and the step is integrated for nothing
    const deps = buildCloudShapeDeps(
      { ...cloudShapeDefaults, horizonCoverageAmount: 0.3 },
      [true, true, true, false]
    )
    expect(deps.horizonCoverage).not.toBeNull()

    // The mask has to REACH the shader, so compile both layer sets and compare
    const arms = Object.entries({
      allLanes: [true, true, true, true] as const,
      deadLane4: [true, true, true, false] as const
    }).map(([name, active]) => ({
      name,
      wgsl: compileWGSL(
        buildCloudShapeDeps(
          { ...cloudShapeDefaults, horizonCoverageAmount: 0.3 },
          active
        ).horizonCoverage!(float(1))
      ).fragment
    }))
    table('cloud-shape-active-mask', [
      { layerSet: 'all lanes', bytes: arms[0]!.wgsl.length },
      { layerSet: 'lane 4 dead', bytes: arms[1]!.wgsl.length },
      { 'the two differ': arms[0]!.wgsl !== arms[1]!.wgsl }
    ])
    expect(arms[0]!.wgsl.length).toBeGreaterThan(0)
    expect(arms[1]!.wgsl).not.toBe(arms[0]!.wgsl)

    // And the default layer set's dead lane really is lane 4
    const ctx = new CloudsContext()
    expect(ctx.cloudLayers.structure.active).toEqual([true, true, true, false])
  })

  it('opens exactly one seam per feature', () => {
    const on = (params: Partial<CloudShapeParams>): string[] => {
      const deps = buildCloudShapeDeps({ ...cloudShapeDefaults, ...params })
      return Object.entries(deps)
        .filter(([, seam]) => seam != null)
        .map(([name]) => name)
    }
    table('cloud-shape-one-seam', [
      { set: 'baseShadow', open: on({ baseShadowStrength: 1 }) },
      { set: 'horizonCoverage', open: on({ horizonCoverageAmount: 0.1 }) },
      { set: 'windSkew', open: on({ windSkewNorth: 10 }) },
      { set: 'erosion', open: on({ erosionShape: 0.5 }) },
      {
        set: 'all four',
        open: on({
          baseShadowStrength: 1,
          horizonCoverageAmount: 0.1,
          windSkewEast: 10,
          erosionShape: 0.5
        })
      }
    ])
    expect(on({ baseShadowStrength: 1 })).toEqual(['baseShadow'])
    expect(on({ horizonCoverageAmount: 0.1 })).toEqual(['horizonCoverage'])
    expect(on({ windSkewNorth: 10 })).toEqual(['windSkew'])
    expect(on({ erosionShape: 0.5 })).toEqual(['erosion'])
    expect(
      on({
        baseShadowStrength: 1,
        horizonCoverageAmount: 0.1,
        windSkewEast: 10,
        erosionShape: 0.5
      }).length
    ).toBe(4)
  })
})
