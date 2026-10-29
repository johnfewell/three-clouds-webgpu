import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mechanical guard for the accepted non-parity register (58t): an entry may
// only cite documented, designed non-parity, never a bug, an error or
// unfinished work, and a hard cap stops it quietly absorbing the ladder

interface Thresholds {
  accepted: Array<{ pattern: string; reason: string }>
  plate: { minStd: number; minCloudFraction: number }
  phases: Record<string, { ssim: number }>
}

const thresholds = JSON.parse(
  readFileSync(resolve(__dirname, 'thresholds.json'), 'utf8')
) as Thresholds

const FORBIDDEN =
  /\b(bug|error|crash|undefined|null|mismatch|not yet|tracked for|pending|TODO|broken|fix)\b/i

describe('accepted non-parity register', () => {
  it('every entry cites an ADR', () => {
    for (const entry of thresholds.accepted) {
      expect(entry.reason, entry.pattern).toMatch(/ADR-\d{3}/)
    }
  })

  it('no entry cites a bug, an error or unfinished work', () => {
    for (const entry of thresholds.accepted) {
      expect(entry.reason, entry.pattern).not.toMatch(FORBIDDEN)
    }
  })

  // Cap moves only with a ruled entry. 4 to 5 on 2026-09-02 (ADR-014, case 45)
  // 5 to 6 on 2026-10-05 (ADR-011 Amendment 13, debug-shadow-map)
  // Re-pinning this number is the decision the guard exists to force
  it('the register stays small and never global', () => {
    expect(thresholds.accepted.length).toBeLessThanOrEqual(6)
    for (const entry of thresholds.accepted) {
      expect(entry.pattern).not.toBe('*')
      expect(entry.pattern.replace(/\*/g, '').length).toBeGreaterThanOrEqual(4)
    }
  })

  it('the plate check is configured and phases keep the design floors', () => {
    expect(thresholds.plate.minStd).toBeGreaterThan(0)
    expect(thresholds.plate.minCloudFraction).toBeGreaterThan(0)
    // Design floor 0.95 for phases 0-3 (phase 2's 0.92 was restored once v4
    // gated at the reference L). A floor below design must carry a
    // recorded basis: silent erosion is what this pin prevents
    const designFloors: Record<string, number> = {
      '0': 0.95,
      '1': 0.95,
      '2': 0.95,
      '3': 0.95
    }
    for (const [phase, floor] of Object.entries(designFloors)) {
      const ssim = thresholds.phases[phase]!.ssim
      expect(ssim, `phase ${phase}`).toBeGreaterThanOrEqual(floor)
      if (ssim < 0.95) {
        expect(
          (thresholds.phases[phase] as { ssimBasis?: string }).ssimBasis,
          `phase ${phase}: a lowered floor must carry its basis`
        ).toBeTruthy()
      }
    }
    expect(thresholds.phases['4']!.ssim).toBeGreaterThanOrEqual(0.98)
  })
})
