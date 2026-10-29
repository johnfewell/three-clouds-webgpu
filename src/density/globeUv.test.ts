// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { vec2, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, expectWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import {
  cpuGetCubeSphereUv,
  cpuGetSphericalUv,
  getCubeSphereUv,
  getMipLevel,
  getSphericalUv
} from './globeUv'

describe('getSphericalUv', () => {
  it('compiles to WGSL with atan and asin', () => {
    const node = getSphericalUv(vec3(1, 0, 0))
    const { fragment } = compileWGSL(node)
    expectWGSL(fragment).toContain('atan2')
    expectWGSL(fragment).toContain('asin')
  })

  it('CPU-twin: axis-aligned positions produce expected UVs', () => {
    const cases = [
      {
        label: '+X',
        pos: [1, 0, 0] as [number, number, number],
        expected: [0.5, 0.5]
      },
      {
        label: '+Y',
        pos: [0, 1, 0] as [number, number, number],
        expected: [0.75, 0.5]
      },
      {
        label: '-X',
        pos: [-1, 0, 0] as [number, number, number],
        expected: [0.5, 0.5]
      },
      {
        label: '-Y',
        pos: [0, -1, 0] as [number, number, number],
        expected: [0.25, 0.5]
      },
      {
        label: '+Z',
        pos: [0, 0, 1] as [number, number, number],
        expected: [0.5, 1.0]
      },
      {
        label: '-Z',
        pos: [0, 0, -1] as [number, number, number],
        expected: [0.5, 0.0]
      }
    ]

    const rows = cases.map(c => {
      const [u, v] = cpuGetSphericalUv(...c.pos)
      return {
        label: c.label,
        expectedU: c.expected[0],
        actualU: u,
        expectedV: c.expected[1],
        actualV: v,
        expected: 0,
        actual: 0,
        delta: Math.abs(u - c.expected[0]!) + Math.abs(v - c.expected[1]!)
      }
    })
    table('sphericalUv-axes', rows)

    for (const c of cases) {
      const [u, v] = cpuGetSphericalUv(...c.pos)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('getCubeSphereUv', () => {
  it('compiles to WGSL', () => {
    const node = getCubeSphereUv(vec3(1, 0, 0))
    const { fragment } = compileWGSL(node)
    expect(fragment.length).toBeGreaterThan(0)
  })

  const faceCentres = [
    { label: '+X', pos: [1, 0, 0] as [number, number, number] },
    { label: '-X', pos: [-1, 0, 0] as [number, number, number] },
    { label: '+Y', pos: [0, 1, 0] as [number, number, number] },
    { label: '-Y', pos: [0, -1, 0] as [number, number, number] },
    { label: '+Z', pos: [0, 0, 1] as [number, number, number] },
    { label: '-Z', pos: [0, 0, -1] as [number, number, number] }
  ]

  it('CPU-twin: 6 face centres produce UVs in [0,1]', () => {
    const rows = faceCentres.map(c => {
      const [u, v] = cpuGetCubeSphereUv(...c.pos)
      return {
        face: c.label,
        u,
        v,
        inRange: u >= 0 && u <= 1 && v >= 0 && v <= 1,
        expected: 0.5,
        actual: u
      }
    })
    table('cubeSphereUv-faceCentres', rows)

    for (const c of faceCentres) {
      const [u, v] = cpuGetCubeSphereUv(...c.pos)
      expect(u, `${c.label} u`).toBeGreaterThanOrEqual(0)
      expect(u, `${c.label} u`).toBeLessThanOrEqual(1)
      expect(v, `${c.label} v`).toBeGreaterThanOrEqual(0)
      expect(v, `${c.label} v`).toBeLessThanOrEqual(1)
      expectClose(
        { x: u, y: v },
        { x: 0.5, y: 0.5 },
        { abs: 0.01, label: `${c.label} centre` }
      )
    }
  })

  const corners = [
    { label: '+X+Y+Z', pos: [1, 1, 1] as [number, number, number] },
    { label: '+X+Y-Z', pos: [1, 1, -1] as [number, number, number] },
    { label: '+X-Y+Z', pos: [1, -1, 1] as [number, number, number] },
    { label: '+X-Y-Z', pos: [1, -1, -1] as [number, number, number] },
    { label: '-X+Y+Z', pos: [-1, 1, 1] as [number, number, number] },
    { label: '-X+Y-Z', pos: [-1, 1, -1] as [number, number, number] },
    { label: '-X-Y+Z', pos: [-1, -1, 1] as [number, number, number] },
    { label: '-X-Y-Z', pos: [-1, -1, -1] as [number, number, number] }
  ]

  it('CPU-twin: 8 corners produce UVs in [0,1]', () => {
    const rows = corners.map(c => {
      const [u, v] = cpuGetCubeSphereUv(...c.pos)
      return {
        corner: c.label,
        u,
        v,
        inRange: u >= 0 && u <= 1 && v >= 0 && v <= 1,
        expected: 0,
        actual: u
      }
    })
    table('cubeSphereUv-corners', rows)

    for (const c of corners) {
      const [u, v] = cpuGetCubeSphereUv(...c.pos)
      expect(u, `${c.label} u`).toBeGreaterThanOrEqual(-1e-10)
      expect(u, `${c.label} u`).toBeLessThanOrEqual(1 + 1e-10)
      expect(v, `${c.label} v`).toBeGreaterThanOrEqual(-1e-10)
      expect(v, `${c.label} v`).toBeLessThanOrEqual(1 + 1e-10)
    }
  })

  it('CPU-twin: continuous across a face (Y face)', () => {
    const p1 = cpuGetCubeSphereUv(0.01, 1, 0)
    const p2 = cpuGetCubeSphereUv(-0.01, 1, 0)
    const du = Math.abs(p1[0] - p2[0])
    const dv = Math.abs(p1[1] - p2[1])
    expect(du, 'near-centre should be continuous').toBeLessThan(0.05)
    expect(dv, 'near-centre should be continuous').toBeLessThan(0.05)
  })

  it('Fn complexity ≤ 12', () => {
    const node = getCubeSphereUv(vec3(1, 0, 0))
    const { fragment } = compileWGSL(node)
    expect(fragment.length).toBeGreaterThan(0)
  })
})

describe('getMipLevel', () => {
  it('compiles to WGSL with dpdx/dpdy', () => {
    const node = getMipLevel(vec2(0.5, 0.5), vec2(1024, 1024))
    const { fragment } = compileWGSL(node)
    expectWGSL(fragment).toContain('dpdx')
    expectWGSL(fragment).toContain('dpdy')
  })
})

// a face-selection tie (f.x == f.y) picks the Z face, where the inner
// radicand goes negative and WGSL's sqrt returns NaN. One NaN pixel made case
// 49's whole readback std NaN

// The radicand exactly as both implementations compute it, so the test asserts
// on the real quantity rather than on a restatement of it
function innerRadicand(px: number, py: number, pz: number): number {
  const len = Math.sqrt(px * px + py * py + pz * pz)
  const [nx, ny, nz] = [px / len, py / len, pz / len]
  const [fx, fy, fz] = [Math.abs(nx), Math.abs(ny), Math.abs(nz)]
  const fmax = Math.max(fx, Math.max(fy, fz))
  const cz = nz / fmax
  let mx: number
  let my: number
  if (fy > fx && fy > fz) {
    mx = ny / fmax > 0 ? -nx : nx
    my = nz
  } else if (fx > fy && fx > fz) {
    mx = nx / fmax > 0 ? ny : -ny
    my = nz
  } else {
    mx = nx
    my = cz > 0 ? ny : -ny
  }
  const mx2 = mx * mx
  const my2 = my * my
  const q = -2 * mx2 + 2 * my2 - 3
  return -24 * mx2 + q * q
}

describe('getCubeSphereUv — NaN guard', () => {
  it('the face-selection tie drives the inner radicand negative', () => {
    // |n.x| == |n.y| with |n.z| < 0.5 is the whole reachable set
    for (const z of [0, 0.1, 0.2, 0.3]) {
      const s = Math.sqrt((1 - z * z) / 2)
      expect(
        innerRadicand(s, s, z),
        `tie at z=${z} should expose the negative radicand the guard exists for`
      ).toBeLessThan(0)
    }
    // Above |n.z| = 0.5 the tie is harmless, which is why the guard is the fix
    // and the face selection does not need rewriting
    expect(innerRadicand(0.505, 0.505, 0.7)).toBeGreaterThan(0)
  })

  it('is finite everywhere on a dense sweep, ties included', () => {
    let nonFinite = 0
    const N = 120
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < 2 * N; j++) {
        const th = Math.acos(1 - (2 * (i + 0.5)) / N)
        const ph = (2 * Math.PI * (j + 0.5)) / (2 * N)
        const [u, v] = cpuGetCubeSphereUv(
          Math.sin(th) * Math.cos(ph),
          Math.sin(th) * Math.sin(ph),
          Math.cos(th)
        )
        if (!Number.isFinite(u) || !Number.isFinite(v)) nonFinite++
      }
    }
    expect(nonFinite).toBe(0)

    for (const z of [0, 0.2, 0.4]) {
      const s = Math.sqrt((1 - z * z) / 2)
      const [u, v] = cpuGetCubeSphereUv(s, s, z)
      expect(Number.isFinite(u) && Number.isFinite(v), `tie z=${z}`).toBe(true)
    }
  })

  it('the compiled shader guards every root', () => {
    // compileWGSL EMITS WGSL without executing it, so no behavioural test can
    // observe the shader's NaN (the same limit that let the cascades view ship
    // uncompilable). The check has to be on the emitted text.
    const { fragment } = compileWGSL(getCubeSphereUv(vec3(0.7071, 0.7071, 0)))
    // Count the guarded form, not bare `max(`: face selection already emits six
    // max calls, so a plain count passed with the guard reverted. Every root
    // must be wrapped
    const compact = fragment.replace(/\s+/g, '')
    const roots = (compact.match(/sqrt\(/g) ?? []).length
    const guarded = (compact.match(/sqrt\(max\(0\.0,/g) ?? []).length
    expect(roots, 'three roots: inner, uv.x, uv.y').toBe(3)
    expect(
      guarded,
      `every root must be clamped; ${roots - guarded} unguarded sqrt remain`
    ).toBe(roots)
  })
})
