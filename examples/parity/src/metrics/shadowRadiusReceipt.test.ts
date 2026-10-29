// Step 1, the site-2 radius receipt, red-proven on the CPU with
// synthetic lanes: the summariser reads a lane correctly and REFUSES a missing
// one. It proves nothing about the lane on hardware, a separate stage

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// By PACKAGE NAME, never ../../src (dogfooding.test.ts enforces it). It
// resolves to build/index.js, which `pnpm check` builds before testing, so a
// new export is present here
import { shadowRadiusFromFootprintCPU } from 'three-clouds-webgpu'
import { describe, expect, it } from 'vitest'

import {
  evaluateShadowRadiusReceipt,
  formatShadowRadiusReceipt,
  SHADOW_RADIUS_MAX,
  SITE2_PCF_ARM_THRESHOLD,
  summariseShadowRadius,
  type ShadowRadiusSummary
} from './shadowRadiusReceipt'

/**
 * A lane in the layout the node writes: R = radius, G = validity.
 * Radii come from the SHIPPED law (shadowRadiusFromFootprintCPU) applied to
 * footprints in pixels, so the fixture cannot drift from what the shader does.
 */
const laneFrom = (
  footprintsPx: readonly number[],
  skyCount = 0
): Float32Array => {
  const out = new Float32Array((footprintsPx.length + skyCount) * 4)
  footprintsPx.forEach((px, i) => {
    out[i * 4] = shadowRadiusFromFootprintCPU(px)
    out[i * 4 + 1] = 1
  })
  // Far-plane pixels: the reconstruction gives them a tiny footprint, so their
  // radius reads 0, the value a genuinely sub-band receiver also reads
  for (let i = 0; i < skyCount; i++) {
    const j = (footprintsPx.length + i) * 4
    out[j] = 0
    out[j + 1] = 0
  }
  return out
}

const receipt = (
  over: Partial<Parameters<typeof evaluateShadowRadiusReceipt>[0]>
): string[] =>
  evaluateShadowRadiusReceipt({
    summary: null,
    laneAbsent: false,
    shadow: true,
    lighting: 'post',
    skip: null,
    // A frame-sized lane is the DEFAULT so the other tests keep testing what
    // they were written for. The size check has its own cases below
    lanePixels: 100,
    framePixels: 100,
    ...over
  })

describe('summariseShadowRadius', () => {
  it('reads the distribution off the lane', () => {
    // 10px is the band's floor (radius 0), 50px its ceiling (radius 3)
    const s = summariseShadowRadius(laneFrom([10, 20, 30, 40, 50]))!
    expect(s.classified).toBe(5)
    expect(s.min).toBeCloseTo(0, 10)
    expect(s.median).toBeCloseTo(shadowRadiusFromFootprintCPU(30), 10)
    expect(s.max).toBeCloseTo(SHADOW_RADIUS_MAX, 10)
  })

  it('armedFraction counts the port early-out, not "radius > 0"', () => {
    // 11px -> 0.075: NON-ZERO but BELOW the 0.1 early-out, so the port point
    // samples it. A receipt that counted "radius > 0" would call this armed and
    // would report the branch live on a case where it never runs
    const below = shadowRadiusFromFootprintCPU(11)
    expect(below).toBeGreaterThan(0)
    expect(below).toBeLessThan(SITE2_PCF_ARM_THRESHOLD)

    const s = summariseShadowRadius(laneFrom([11, 11, 30, 50]))!
    expect(s.armedFraction).toBeCloseTo(0.5, 10)
    expect(s.atCeilingFraction).toBeCloseTo(0.25, 10)
  })

  it('excludes far-plane pixels via G, not via "radius === 0"', () => {
    // THE DISCRIMINATOR: same four receivers, plus 96 sky pixels in the second
    // Filtering on R instead of G would make them agree (sky reads 0), but they
    // must differ on `classified` while matching on every statistic
    const receivers = [11, 11, 30, 50]
    const dense = summariseShadowRadius(laneFrom(receivers))!
    const sparse = summariseShadowRadius(laneFrom(receivers, 96))!

    expect(dense.classified).toBe(4)
    expect(sparse.classified).toBe(4)
    expect(sparse.sampled).toBe(100)
    expect(sparse.armedFraction).toBeCloseTo(dense.armedFraction, 12)
    expect(sparse.median).toBeCloseTo(dense.median, 12)

    // And the failure a G-blind summariser would produce, stated as a number so
    // the guard is not merely "they are equal": 96 sky zeros would drag the
    // armed fraction from 0.5 to 0.02
    expect(sparse.armedFraction).not.toBeCloseTo(2 / 100, 3)
  })

  it('returns null — not zeros — when nothing consumes', () => {
    expect(summariseShadowRadius(laneFrom([], 64))).toBeNull()
  })
})

describe('evaluateShadowRadiusReceipt', () => {
  it('REFUSES when the lane is absent on a shadow case', () => {
    const reasons = receipt({ laneAbsent: true })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/REFUSED/)
    expect(reasons[0]).toMatch(/UNMEASURED/)
    // The refusal must say what NOT to conclude, because both wrong readings
    // have already been made in this task's history: reading a missing lane as
    // zero, and quoting r1sp's FORCED radius 3 as the computed one
    expect(reasons[0]).toMatch(/do not read a missing lane as radius 0/)
    expect(reasons[0]).toMatch(/FORCED radius of 3/)
  })

  it('does NOT refuse when the lane is present — the positive control', () => {
    // Without this the refusal test passes for a function that refuses always
    const summary = summariseShadowRadius(laneFrom([30, 50]))
    expect(receipt({ summary, laneAbsent: false })).toEqual([])
  })

  it('calls an empty classified set VACUOUS rather than measured', () => {
    const reasons = receipt({ summary: null, laneAbsent: false })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/VACUOUS/)
    expect(reasons[0]).toMatch(/classified = 0/)
  })

  it('REFUSES a lane that is not frame-sized — a set of one is not a sample', () => {
    // THE CASE THAT HAPPENED: a 1x1 lane reported `classified=1/1` and
    // passed every guard. A confident zero over one pixel is what this task
    // refuses, caught only because the log printed the denominator
    const oneMeasured = summariseShadowRadius(laneFrom([11]))
    expect(oneMeasured!.classified).toBe(1)
    expect(oneMeasured!.armedFraction).toBe(0)

    const reasons = receipt({
      summary: oneMeasured,
      lanePixels: 1,
      framePixels: 921600
    })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/REFUSED/)
    expect(reasons[0]).toMatch(/BROKEN INSTRUMENT/)
    expect(reasons[0]).toMatch(/1 pixels and the frame has 921600/)
  })

  it('refuses when the lane size cannot be checked at all', () => {
    // An unverifiable lane is not a verified one. Without this, a caller that
    // simply forgot to forward the sizes would silently get the old behaviour
    for (const over of [
      { lanePixels: null },
      { framePixels: null },
      { lanePixels: null, framePixels: null }
    ]) {
      const reasons = receipt({
        summary: summariseShadowRadius(laneFrom([30])),
        ...over
      })
      expect(reasons).toHaveLength(1)
      expect(reasons[0]).toMatch(/could not be checked/)
    }
  })

  it('checks the size BEFORE vacuity — order matters', () => {
    // A wrong-sized lane that is also empty must report the SIZE fault: its
    // emptiness is meaningless until the lane is known to be the frame
    const reasons = receipt({
      summary: null,
      lanePixels: 1,
      framePixels: 921600
    })
    expect(reasons[0]).toMatch(/BROKEN INSTRUMENT/)
    expect(reasons[0]).not.toMatch(/VACUOUS/)
  })

  it('is silent on a case with no shadow, and says so on lights mode', () => {
    // shadow:false has no site-2 consumer at all: silence is correct, and it
    // is what keeps the refusal from firing on 50 of the 65 ladder cases
    expect(receipt({ shadow: false, laneAbsent: true })).toEqual([])
    // lighting:'lights' (case 35 only) takes the light node, not this lane
    const lights = receipt({ lighting: 'lights', laneAbsent: true })
    expect(lights).toHaveLength(1)
    expect(lights[0]).toMatch(/not applicable/)
    expect(lights[0]).not.toMatch(/REFUSED/)
  })

  it('honours a declared skip ahead of everything else', () => {
    const reasons = receipt({ laneAbsent: true, skip: 'no ground in frame' })
    expect(reasons[0]).toMatch(/not applicable — no ground in frame/)
  })
})

describe('formatShadowRadiusReceipt', () => {
  it('puts the armed fraction in the one log line', () => {
    const s: ShadowRadiusSummary = summariseShadowRadius(
      laneFrom([11, 11, 30, 50], 96)
    )!
    const line = formatShadowRadiusReceipt(s)
    expect(line).toMatch(/armed=50\.00%/)
    expect(line).toMatch(/classified=4\/100/)
    expect(line).toMatch(/max=3\.0000/)
  })
})

describe('the receipt reaches metrics.json', () => {
  // capture.mjs re-keys in-page results FIELD BY FIELD, twice, and three
  // correct receipts once reached no artifact through a dropped field (three times,
  // in the shadow capture lane). A missing field fails nothing, so this is guarded
  const RUNNER = readFileSync(
    join(__dirname, '../../scripts/capture.mjs'),
    'utf8'
  )

  it('crosses the metricsWriter boundary — the THIRD one', () => {
    // metrics.json is written by formatMetricsJson ALONE, so the WRITER is a
    // third hop after capture.mjs's two: without it the receipt reached the
    // capture log and metrics.json had no shadowRadius key (measured)
    const writer = readFileSync(
      join(__dirname, '../capture/metricsWriter.ts'),
      'utf8'
    )
    expect(writer, 'shadowRadius must be DECLARED on CaptureMetrics').toMatch(
      /shadowRadius\?:/
    )
    expect(writer, 'and EMITTED by formatMetricsJson').toContain(
      'shadowRadius: m.shadowRadius'
    )
  })

  it('crosses BOTH capture.mjs re-key boundaries', () => {
    // metricsObj assembly, then the metrics.json mapping
    const hits = RUNNER.match(/^\s*shadowRadius:/gm) ?? []
    expect(
      hits.length,
      'shadowRadius must appear at BOTH capture.mjs re-key boundaries'
    ).toBeGreaterThanOrEqual(2)
  })

  it('forwards every field of the summary', () => {
    const written = RUNNER.slice(RUNNER.indexOf('shadowRadius:'))
    const summary = summariseShadowRadius(laneFrom([30]))!
    for (const key of Object.keys(summary)) {
      expect(written, `${key} is computed but never written`).toContain(
        `${key}:`
      )
    }
  })

  it('writes the refusal, not only the number', () => {
    // A receipt that persists its summary but drops laneAbsent/reasons records
    // a measurement it did not take as an absent field: the same silence,
    // one level down
    for (const key of [
      'laneAbsent',
      'reasons',
      'error',
      'lanePixels',
      'framePixels'
    ]) {
      expect(RUNNER, `${key} must survive into metrics.json`).toContain(
        `${key}: result.shadowRadius.${key}`
      )
    }
  })

  it('sizes the lane RT wherever it sizes the linear RT', () => {
    // The CPU cannot see a render target's size, so only this source guard
    // stops the 1x1 lane RT coming back. Comments are STRIPPED first: the
    // explanation names both symbols, and a guard must not match its own prose
    const sideB = readFileSync(join(__dirname, '../sideB.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const sized = [...sideB.matchAll(/(\w+)(?:\?)?\.setSize\(/g)].map(m => m[1])
    expect(
      sized,
      'linearRT sizing moved — this guard is anchored to it'
    ).toContain('linearRT')
    expect(
      sized,
      'shadowRadiusRT is not resized. It is constructed 1x1, so the receipt ' +
        'would summarise ONE pixel and report a confident armedFraction over it'
    ).toContain('shadowRadiusRT')
  })

  it('calls the probe method side B actually exposes', () => {
    const sideB = readFileSync(join(__dirname, '../sideB.ts'), 'utf8')
    const main = readFileSync(join(__dirname, '../main.ts'), 'utf8')
    expect(sideB).toContain('renderShadowRadius')
    expect(sideB).toContain('shadowRadiusRT')
    expect(main).toContain('async readShadowRadius()')
    expect(RUNNER).toContain('p.readShadowRadius')
  })
})
