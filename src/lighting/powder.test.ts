import { describe, expect, it } from 'vitest'

function logTable(label: string, rows: Record<string, string | number>[]) {
  console.log(`\n[powder] ${label}`)
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

// CPU twin: 1 − powderScale · exp(−extinction · powderExponent)
function cpuPowderTerm(
  extinction: number,
  powderScale: number,
  powderExponent: number
): number {
  return 1 - powderScale * Math.exp(-extinction * powderExponent)
}

const POWDER_SCALE = 0.8
const POWDER_EXPONENT = 150

describe('powder CPU twin', () => {
  it('extinction = 0 → 1 − powderScale (0.2 at defaults)', () => {
    const result = cpuPowderTerm(0, POWDER_SCALE, POWDER_EXPONENT)
    expect(result).toBeCloseTo(1 - POWDER_SCALE, 6)
    expect(result).toBeCloseTo(0.2, 6)
    logTable('extinction=0', [
      {
        extinction: '0',
        powderScale: String(POWDER_SCALE),
        result: result.toFixed(6)
      }
    ])
  })

  it('extinction >> 1/powderExponent → 1', () => {
    const result = cpuPowderTerm(1, POWDER_SCALE, POWDER_EXPONENT)
    expect(result).toBeCloseTo(1, 6)
    logTable('extinction=1 (large)', [
      { extinction: '1', result: result.toFixed(10) }
    ])
  })

  it('monotonic: increasing extinction → increasing powder term', () => {
    const extinctions = [0, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0]
    const results = extinctions.map(e =>
      cpuPowderTerm(e, POWDER_SCALE, POWDER_EXPONENT)
    )

    logTable(
      'monotonicity',
      extinctions.map((e, i) => ({
        extinction: e.toFixed(4),
        powderTerm: results[i]!.toFixed(6)
      }))
    )

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]!)
    }
    // Strict monotonicity in the non-saturated range
    expect(results[1]).toBeGreaterThan(results[0]!)
    expect(results[2]).toBeGreaterThan(results[1]!)
  })

  it('powderScale = 0 → always 1 (identity)', () => {
    expect(cpuPowderTerm(0, 0, POWDER_EXPONENT)).toBe(1)
    expect(cpuPowderTerm(0.5, 0, POWDER_EXPONENT)).toBe(1)
    expect(cpuPowderTerm(1, 0, POWDER_EXPONENT)).toBe(1)
  })

  it('midrange extinction has visible darkening', () => {
    const mid = cpuPowderTerm(0.01, POWDER_SCALE, POWDER_EXPONENT)
    expect(mid).toBeGreaterThan(0.2)
    expect(mid).toBeLessThan(1)
    logTable('midrange', [
      { extinction: '0.01', expected: '>0.2 and <1', actual: mid.toFixed(6) }
    ])
  })
})

describe('powder WGSL compilation', () => {
  it('compiles to WGSL', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const { float } = await import('three/tsl')
    const { powderTerm } = await import('./powder')
    const { contextNode } = createContextStub()

    const result = powderTerm(float(0.01), float(0.8), float(150))
    const { fragment } = compileWGSL(result, { contextNode })
    expect(fragment).toContain('exp')
    logTable('WGSL', [
      { check: 'compiled', result: 'yes' },
      { check: 'contains exp', result: String(fragment.includes('exp')) },
      { check: 'length', result: String(fragment.length) }
    ])
  })

  it('powderScale=0 compiles (identity)', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { createContextStub } = await import('../../test/helpers/contextStub')
    const { float } = await import('three/tsl')
    const { powderTerm } = await import('./powder')
    const { contextNode } = createContextStub()

    const result = powderTerm(float(0.01), float(0), float(150))
    const { fragment } = compileWGSL(result, { contextNode })
    expect(fragment).toBeDefined()
    logTable('WGSL powderScale=0', [{ check: 'compiled', result: 'yes' }])
  })
})
