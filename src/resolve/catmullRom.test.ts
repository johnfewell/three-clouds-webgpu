import { describe, expect, it } from 'vitest'

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[catmullRom] ${label}`)
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

// CPU twin of the Catmull-Rom weight computation (catmullRomSampling.glsl:49–52)
function catmullRomWeights(f: number): [number, number, number, number] {
  const w0 = f * (-0.5 + f * (1.0 - 0.5 * f))
  const w1 = 1.0 + f * f * (-2.5 + 1.5 * f)
  const w2 = f * (0.5 + f * (2.0 - 1.5 * f))
  const w3 = f * f * (-0.5 + 0.5 * f)
  return [w0, w1, w2, w3]
}

describe('catmullRom CPU twin', () => {
  it('9-tap weights sum to 1 at various sub-texel offsets', () => {
    const offsets = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]
    const rows: Record<string, string>[] = []

    for (const fx of offsets) {
      for (const fy of offsets) {
        const [wx0, wx1, wx2, wx3] = catmullRomWeights(fx)
        const [wy0, wy1, wy2, wy3] = catmullRomWeights(fy)
        const xSum = wx0 + wx1 + wx2 + wx3
        const ySum = wy0 + wy1 + wy2 + wy3

        const totalWeight =
          wx0 * wy0 +
          (wx1 + wx2) * wy0 +
          wx3 * wy0 +
          wx0 * (wy1 + wy2) +
          (wx1 + wx2) * (wy1 + wy2) +
          wx3 * (wy1 + wy2) +
          wx0 * wy3 +
          (wx1 + wx2) * wy3 +
          wx3 * wy3

        expect(xSum).toBeCloseTo(1, 10)
        expect(ySum).toBeCloseTo(1, 10)
        expect(totalWeight).toBeCloseTo(1, 10)

        if (fy === 0.0) {
          rows.push({
            fx: fx.toFixed(2),
            w0: wx0.toFixed(6),
            w1: wx1.toFixed(6),
            w2: wx2.toFixed(6),
            w3: wx3.toFixed(6),
            sum: xSum.toFixed(10)
          })
        }
      }
    }
    logTable('weights (1D, fy=0)', rows)
  })

  it('constant image → returns the constant', () => {
    const C = 0.42
    const [wx0, wx1, wx2, wx3] = catmullRomWeights(0.3)
    const [wy0, wy1, wy2, wy3] = catmullRomWeights(0.7)

    const result =
      C * wx0 * wy0 +
      C * (wx1 + wx2) * wy0 +
      C * wx3 * wy0 +
      C * wx0 * (wy1 + wy2) +
      C * (wx1 + wx2) * (wy1 + wy2) +
      C * wx3 * (wy1 + wy2) +
      C * wx0 * wy3 +
      C * (wx1 + wx2) * wy3 +
      C * wx3 * wy3

    expect(result).toBeCloseTo(C, 10)
    logTable('constant image', [
      { constant: String(C), result: result.toFixed(10) }
    ])
  })

  it('linear ramp reproduced within 1e-6', () => {
    const texSize = 8
    const fx = 0.4
    const fy = 0.6

    const [wx0, wx1, wx2, wx3] = catmullRomWeights(fx)
    const [wy0, wy1, wy2, wy3] = catmullRomWeights(fy)

    const sampleU = 0.5
    const sampleV = 0.5
    const centerX = Math.floor(sampleU * texSize - 0.5) + 0.5
    const centerY = Math.floor(sampleV * texSize - 0.5) + 0.5

    // Linear ramp: value = (x + y) / (2 * texSize)
    function ramp(tx: number, ty: number) {
      return (tx + ty) / (2 * texSize)
    }

    // For the test: verify weights × linear samples ≈ linear at the sample point
    const expectedValue =
      (sampleU * texSize + sampleV * texSize) / (2 * texSize)

    // Since Catmull-Rom exactly reproduces linear functions, the weighted sum
    // of a linear ramp should equal the ramp at the sample point
    let result = 0
    const xs = [centerX - 1, centerX, centerX + 1, centerX + 2]
    const ys = [centerY - 1, centerY, centerY + 1, centerY + 2]
    const wxs = [wx0, wx1, wx2, wx3]
    const wys = [wy0, wy1, wy2, wy3]
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        result += ramp(xs[i]!, ys[j]!) * wxs[i]! * wys[j]!
      }
    }

    expect(Math.abs(result - expectedValue)).toBeLessThan(1e-6)
    logTable('linear ramp', [
      {
        expected: expectedValue.toFixed(6),
        actual: result.toFixed(6),
        diff: Math.abs(result - expectedValue).toExponential(2)
      }
    ])
  })
})

describe('catmullRom exports', () => {
  it('re-exports textureCatmullRom from core', async () => {
    const { textureCatmullRom } = await import('./catmullRom')
    expect(textureCatmullRom).toBeDefined()
    expect(typeof textureCatmullRom).toBe('function')
  })
})
