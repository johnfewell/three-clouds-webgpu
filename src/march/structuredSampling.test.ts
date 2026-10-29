import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function logTable(
  label: string,
  rows: Record<string, string | number | boolean>[]
) {
  console.log(`\n[structuredSampling] ${label}`)
  if (rows.length === 0) return
  const keys = Object.keys(rows[0]!)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k]).length))
  )
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join(' | ')
  console.log(header)
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  for (const row of rows) {
    console.log(
      keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' | ')
    )
  }
}

type V3 = [number, number, number]
type V4 = [number, number, number, number]

function v3Dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function v3Length(v: V3): number {
  return Math.sqrt(v3Dot(v, v))
}

function v3Abs(v: V3): V3 {
  return [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])]
}

function v3Sign(v: V3): V3 {
  return [Math.sign(v[0]), Math.sign(v[1]), Math.sign(v[2])]
}

function v3Mul(a: V3, b: V3): V3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

function cpuSwapIfBigger(a: V4, b: V4): { a: V4; b: V4 } {
  return a[3] > b[3] ? { a: b, b: a } : { a, b }
}

const A = 0.85065080835204
const B = 0.5257311121191336
const KT = 0.6180339887498948
const KT2 = 0.38196601125010515

// CPU twin: structuredSampling.glsl:6–26
function cpuGetIcosahedralVertices(direction: V3): { v1: V3; v2: V3; v3: V3 } {
  const absD = v3Abs(direction)
  const selector1 = v3Dot(absD, [1, KT2, -KT])
  const selector2 = v3Dot(absD, [-KT, 1, KT2])
  const selector3 = v3Dot(absD, [KT2, -KT, 1])
  const octant = v3Sign(direction)
  const v1 = v3Mul(selector1 > 0 ? [A, B, 0] : [-B, 0, A], octant)
  const v2 = v3Mul(selector2 > 0 ? [0, A, B] : [A, -B, 0], octant)
  const v3 = v3Mul(selector3 > 0 ? [B, 0, A] : [0, A, -B], octant)
  return { v1, v2, v3 }
}

// CPU twin: structuredSampling.glsl:81–101
function cpuIntersectStructuredPlanes(
  normal: V3,
  rayOrigin: V3,
  rayDirection: V3,
  samplePeriod: number
): { stepOffset: number; stepSize: number } {
  const NoD = v3Dot(rayDirection, normal)
  const stepSize = samplePeriod / Math.abs(NoD)
  let stepOffset = -(v3Dot(rayOrigin, normal) % samplePeriod) / NoD
  if (stepOffset < 0) stepOffset += stepSize
  return { stepOffset, stepSize }
}

// Non-degenerate directions (sign(0) = 0 zeroes vertex components for axis-aligned)
function normalize(v: V3): V3 {
  const len = v3Length(v)
  return [v[0] / len, v[1] / len, v[2] / len]
}

const TEST_DIRECTIONS: V3[] = [
  normalize([1, 1, 1]),
  normalize([-1, 1, 1]),
  normalize([1, -1, 1]),
  normalize([1, 1, -1]),
  normalize([-1, -1, 1]),
  normalize([1, -1, -1])
]

describe('swapIfBigger', () => {
  it('swaps only on strict greater-than and preserves exact ties', () => {
    const low: V4 = [1, 2, 3, 0.25]
    const high: V4 = [4, 5, 6, 0.75]
    const tied: V4 = [7, 8, 9, 0.75]

    expect(cpuSwapIfBigger(high, low)).toEqual({ a: low, b: high })
    expect(cpuSwapIfBigger(high, tied)).toEqual({ a: high, b: tied })

    logTable('strict swap', [
      { case: 'greater', inputA: high[3], inputB: low[3], swapped: true },
      { case: 'tie', inputA: high[3], inputB: tied[3], swapped: false }
    ])
  })
})

describe('getIcosahedralVertices', () => {
  it('non-degenerate directions → unit-length triangle vertices', () => {
    const rows: Record<string, string>[] = []
    for (const dir of TEST_DIRECTIONS) {
      const { v1, v2, v3 } = cpuGetIcosahedralVertices(dir)
      const l1 = v3Length(v1)
      const l2 = v3Length(v2)
      const l3 = v3Length(v3)
      expect(l1).toBeCloseTo(1, 4)
      expect(l2).toBeCloseTo(1, 4)
      expect(l3).toBeCloseTo(1, 4)

      rows.push({
        dir: `(${dir.map(v => v.toFixed(3)).join(',')})`,
        v1: `(${v1.map(v => v.toFixed(3)).join(',')})`,
        v2: `(${v2.map(v => v.toFixed(3)).join(',')})`,
        v3: `(${v3.map(v => v.toFixed(3)).join(',')})`,
        '|v1|': l1.toFixed(4),
        '|v2|': l2.toFixed(4),
        '|v3|': l3.toFixed(4)
      })
    }
    logTable('directions → vertices', rows)
  })

  it('vertices form a triangle containing the direction', () => {
    for (const dir of TEST_DIRECTIONS) {
      const { v1, v2, v3 } = cpuGetIcosahedralVertices(dir)
      const d1 = v3Dot(v1, dir)
      const d2 = v3Dot(v2, dir)
      const d3 = v3Dot(v3, dir)
      // At least one vertex should have positive dot with the direction
      expect(Math.max(d1, d2, d3)).toBeGreaterThan(0)
    }
  })
})

describe('intersectStructuredPlanes', () => {
  it('returns stepOffset in [0, stepSize)', () => {
    const origins: V3[] = [
      [0, 0, 0],
      [100, 200, 300],
      [-50, 75, 12.5]
    ]
    const normals: V3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ]
    const period = 10

    const rows: Record<string, string>[] = []
    for (const origin of origins) {
      for (const normal of normals) {
        // March along the normal
        const dir: V3 = normal
        const { stepOffset, stepSize } = cpuIntersectStructuredPlanes(
          normal,
          origin,
          dir,
          period
        )
        expect(stepOffset).toBeGreaterThanOrEqual(0)
        expect(stepOffset).toBeLessThan(stepSize)
        expect(stepSize).toBeCloseTo(period, 4)
        rows.push({
          origin: `(${origin.join(',')})`,
          normal: `(${normal.join(',')})`,
          stepOffset: stepOffset.toFixed(4),
          stepSize: stepSize.toFixed(4)
        })
      }
    }
    logTable('intersectStructuredPlanes', rows)
  })

  it('oblique direction → stepSize > samplePeriod', () => {
    const normal: V3 = [1, 0, 0]
    // Not aligned with the normal
    const dir: V3 = [0.5, 0.5, Math.SQRT1_2]
    const { stepSize } = cpuIntersectStructuredPlanes(
      normal,
      [0, 0, 0],
      dir,
      10
    )
    // 10 / |dot(dir, normal)| = 10/0.5 = 20
    expect(stepSize).toBeGreaterThan(10)
    expect(stepSize).toBeCloseTo(20, 4)
  })
})

describe('WGSL compilation', () => {
  it('structured-sampling functions compile', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const { float, vec3: tslVec3 } = await import('three/tsl')
    const { getStructureNormal, intersectStructuredPlanes } =
      await import('./structuredSampling')
    const { contextNode } = createContextStub()

    // getStructureNormal encompasses vertex selection, strict sorting and weights
    const normal = getStructureNormal(tslVec3(1, 0, 0), float(0.3))
    const { fragment: fragNormal } = compileWGSL(normal, { contextNode })
    expect(fragNormal).toContain('if')
    expect(fragNormal).toMatch(/if \([^\n]+ > [^\n]+\)/)

    const source = readFileSync(
      new URL('./structuredSampling.ts', import.meta.url),
      'utf8'
    )
    expect(source).toContain('If(a.w.greaterThan(b.w)')
    expect(source).not.toContain('step(bVal.w, aVal.w)')

    // intersectStructuredPlanes, wrapped in a Fn so property access works in TSL
    const { Fn: tslFn } = await import('three/tsl')
    const testPlanes = tslFn(() => {
      const result = intersectStructuredPlanes(
        tslVec3(1, 0, 0),
        tslVec3(0, 0, 0),
        tslVec3(1, 0, 0),
        float(10)
      )
      return result.x
    })
    const { fragment: fragPlanes } = compileWGSL(testPlanes(), { contextNode })
    expect(fragPlanes).toContain('if')

    logTable('WGSL compilation', [
      {
        fn: 'getStructureNormal',
        length: String(fragNormal.length),
        compiled: 'yes'
      },
      {
        fn: 'intersectStructuredPlanes',
        length: String(fragPlanes.length),
        compiled: 'yes'
      }
    ])
  })
})
