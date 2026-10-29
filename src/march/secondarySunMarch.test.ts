import { describe, expect, it } from 'vitest'

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[secondarySunMarch] ${label}`)
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

describe('iterationCount CPU twin', () => {
  it('mip 0 → maxIterationCount+1 minus jitter', async () => {
    const { iterationCountCPU } = await import('./secondarySunMarch')
    const rows: Record<string, string | number>[] = []

    for (const maxIter of [1, 2, 3, 5]) {
      for (const jitter of [0, 0.25, 0.5, 0.99]) {
        const count = iterationCountCPU(maxIter, 0, jitter)
        const expected = Math.max(0, Math.trunc(maxIter + 1 - jitter))
        rows.push({
          maxIter,
          mip: 0,
          jitter,
          count,
          expected,
          match: count === expected ? 'yes' : 'NO'
        })
        expect(count).toBe(expected)
      }
    }

    logTable('iteration count at mip 0', rows)
  })

  it('mip 1 → 1 minus jitter → 0 or 1', async () => {
    const { iterationCountCPU } = await import('./secondarySunMarch')
    const rows: Record<string, string | number>[] = []

    for (const maxIter of [1, 2, 3, 5]) {
      for (const jitter of [0, 0.5, 0.99, 1.0]) {
        const count = iterationCountCPU(maxIter, 1, jitter)
        const expected = Math.max(0, Math.trunc(1 - jitter))
        rows.push({
          maxIter,
          mip: 1,
          jitter,
          count,
          expected,
          match: count === expected ? 'yes' : 'NO'
        })
        expect(count).toBe(expected)
      }
    }

    logTable('iteration count at mip 1', rows)
  })

  it('mip 0.5 gives intermediate counts', async () => {
    const { iterationCountCPU } = await import('./secondarySunMarch')
    const count = iterationCountCPU(2, 0.5, 0)
    expect(count).toBe(2)
    const count2 = iterationCountCPU(5, 0.5, 0)
    expect(count2).toBe(3)
  })
})

describe('marchOpticalDepth CPU twin (constant field)', () => {
  it('OD accumulation matches geometric series', async () => {
    const { marchOpticalDepthCPU, geometricSeriesOD, iterationCountCPU } =
      await import('./secondarySunMarch')
    const rows: Record<string, string | number>[] = []

    const extinction = 0.01
    const minStep = 100
    const scale = 2

    for (const maxIter of [1, 2, 3, 5]) {
      for (const jitter of [0, 0.5]) {
        const count = iterationCountCPU(maxIter, 0, jitter)
        const { opticalDepth } = marchOpticalDepthCPU(
          extinction,
          maxIter,
          0,
          jitter,
          minStep,
          scale
        )
        const expected = geometricSeriesOD(extinction, count, minStep, scale)

        rows.push({
          maxIter,
          jitter,
          iterations: count,
          od: opticalDepth.toFixed(6),
          geometric: expected.toFixed(6),
          match: Math.abs(opticalDepth - expected) < 1e-10 ? 'yes' : 'NO'
        })

        expect(opticalDepth).toBeCloseTo(expected, 10)
      }
    }

    logTable('OD vs geometric series (scale=2)', rows)
  })

  it('OD with scale=1 is extinction × totalDistance', async () => {
    const { marchOpticalDepthCPU, iterationCountCPU } =
      await import('./secondarySunMarch')
    const extinction = 0.02
    const minStep = 50
    const scale = 1

    const count = iterationCountCPU(3, 0, 0)
    const { opticalDepth } = marchOpticalDepthCPU(
      extinction,
      3,
      0,
      0,
      minStep,
      scale
    )
    const expected = extinction * minStep
    expect(opticalDepth).toBeCloseTo(expected, 10)

    logTable('OD with scale=1', [
      {
        iterations: count,
        stepSize: (minStep / count).toFixed(2),
        totalDistance: minStep,
        od: opticalDepth.toFixed(6),
        expected: expected.toFixed(6)
      }
    ])
  })

  it('zero iterations returns fudge factor 0.5', async () => {
    const { marchOpticalDepthCPU } = await import('./secondarySunMarch')
    const { opticalDepth } = marchOpticalDepthCPU(0.01, 2, 1, 0.5, 100, 2)
    expect(opticalDepth).toBe(0.5)
  })
})
