import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  checkAtlasChannels,
  checkShadedFraction,
  evaluateCommittedMetrics
} from '../../../../scripts/verify-results.mjs'
import { table } from '../../../../test/helpers/cpuTwin'
import {
  evaluate as evaluateBrowser,
  type Metrics,
  type PlateCheck,
  type Thresholds
} from './evaluate'
import { evaluate as evaluateCapture } from './evaluator.mjs'

const ROOT = resolve(import.meta.dirname, '../../../..')
const RESULTS_DIR = join(ROOT, 'parity', 'results')
const THRESHOLDS_PATH = join(
  ROOT,
  'examples',
  'parity',
  'cases',
  'thresholds.json'
)

interface StoredMetrics extends Metrics {
  case: string
  phase: number
  metricsVersion?: unknown
  plate: PlateCheck['plate']
  shadedFraction?: unknown
  /** the packed debug plate's per-channel agreement */
  atlasChannels?: unknown
  // What the capture recorded, read back so the artifact can be checked
  // against the evaluator rather than only against a reconstruction
  result?: string
  reasons?: string[]
}

function committedMetricsPaths(): string[] {
  const paths: string[] = []
  for (const phase of readdirSync(RESULTS_DIR, { withFileTypes: true })) {
    if (!phase.isDirectory()) continue
    const phaseDir = join(RESULTS_DIR, phase.name)
    for (const caseEntry of readdirSync(phaseDir, { withFileTypes: true })) {
      if (!caseEntry.isDirectory()) continue
      const metricsPath = join(phaseDir, caseEntry.name, 'metrics.json')
      if (existsSync(metricsPath)) paths.push(metricsPath)
    }
  }
  return paths.sort()
}

function plateCheck(
  thresholds: Thresholds,
  metrics: StoredMetrics
): PlateCheck {
  return {
    minStd: thresholds.plate?.minStd ?? 0.002,
    minCloudFraction: thresholds.plate?.minCloudFraction ?? 0.0005,
    plate: metrics.plate
  }
}

describe('single-source metric evaluator', () => {
  it('all three consumers import the shared implementation', () => {
    const consumers = [
      {
        name: 'TypeScript facade',
        path: join(import.meta.dirname, 'evaluate.ts'),
        importPath: './evaluator.mjs'
      },
      {
        name: 'capture runner',
        path: join(ROOT, 'examples', 'parity', 'scripts', 'capture.mjs'),
        importPath: '../src/metrics/evaluator.mjs'
      },
      {
        name: 'committed-results verifier',
        path: join(ROOT, 'scripts', 'verify-results.mjs'),
        importPath: '../examples/parity/src/metrics/evaluator.mjs'
      }
    ]

    for (const consumer of consumers) {
      const source = readFileSync(consumer.path, 'utf8')
      expect(source, `${consumer.name} imports the shared module`).toContain(
        `from '${consumer.importPath}'`
      )
      expect(source, `${consumer.name} has no evaluator copy`).not.toMatch(
        /function (?:evaluate|evaluateMetrics|checkPlate|checkMetricsVersion)\s*\(/
      )
      expect(source, `${consumer.name} has no version copy`).not.toMatch(
        /const METRICS_VERSION\s*=/
      )
    }
  })

  it('returns identical verdicts through all consumers on committed results', () => {
    const thresholds = JSON.parse(
      readFileSync(THRESHOLDS_PATH, 'utf8')
    ) as Thresholds
    const paths = committedMetricsPaths()
    const counts = { pass: 0, 'expected-difference': 0, fail: 0 }

    expect(paths.length).toBeGreaterThan(0)
    for (const metricsPath of paths) {
      const metrics = JSON.parse(
        readFileSync(metricsPath, 'utf8')
      ) as StoredMetrics
      const phaseThresholds = thresholds.phases[metrics.phase] ?? {}
      const check = plateCheck(thresholds, metrics)
      const captureVerdict = evaluateCapture(
        {
          ssim: metrics.ssim,
          deMean: metrics.deMean,
          deP95: metrics.deP95,
          histDist: metrics.histDist
        },
        phaseThresholds,
        metrics.case,
        thresholds.accepted,
        check
      )
      const browserVerdict = evaluateBrowser(
        {
          ssim: Number(metrics.ssim),
          deMean: Number(metrics.deMean),
          deP95: Number(metrics.deP95),
          histDist: Number(metrics.histDist)
        },
        phaseThresholds,
        metrics.case,
        thresholds.accepted,
        check
      )
      const verifyVerdict = evaluateCommittedMetrics(
        metrics,
        phaseThresholds,
        metrics.case,
        thresholds.accepted,
        check
      )

      // The shared evaluator answers the METRIC question only and production
      // composes the shaded-fraction receipt on top. That composition is written
      // twice (capture.mjs:845-855, verify-results checkShadedFraction)
      const sf = metrics.shadedFraction as
        { skipped?: boolean; error?: string; reasons?: string[] } | undefined
      const receiptReasons =
        sf == null
          ? []
          : sf.skipped
            ? []
            : sf.error
              ? [`shaded-fraction receipt could not be taken: ${sf.error}`]
              : (sf.reasons ?? [])
      // the atlas-channel gate composes the same way, from the same
      // two sources (capture.mjs and verify-results checkAtlasChannels)
      const ac = metrics.atlasChannels as
        { error?: string; reasons?: string[] } | undefined
      const atlasReasons =
        ac == null
          ? []
          : ac.error
            ? [`atlas-channel receipt could not be taken: ${ac.error}`]
            : (ac.reasons ?? [])
      const composed = { ...captureVerdict }
      for (const extra of [receiptReasons, atlasReasons]) {
        if (extra.length > 0) {
          composed.reasons = [...composed.reasons, ...extra]
          composed.result = 'fail'
        }
      }

      expect(browserVerdict, metricsPath).toEqual(captureVerdict)
      expect(verifyVerdict, metricsPath).toEqual(composed)
      // Reason text compares with its numbers normalised: a capture formats
      // reasons from the in-memory metric, the artifact stores it rounded, so
      // a value on a toFixed boundary disagrees in its last digit alone
      const digits = (text: string): string =>
        text.replace(/\d+\.\d+/g, '<num>')
      expect(
        {
          result: metrics.result,
          reasons: (metrics.reasons ?? []).map(digits)
        },
        `${metricsPath} records a verdict the evaluator does not re-derive`
      ).toEqual({
        result: verifyVerdict.result,
        reasons: verifyVerdict.reasons.map(digits)
      })
      counts[composed.result]++
    }

    table('shared-evaluator-committed-verdicts', [
      { result: 'pass', count: counts.pass },
      {
        result: 'expected-difference',
        count: counts['expected-difference']
      },
      { result: 'fail', count: counts.fail }
    ])
  })
})

// The verify-time mirror of the two receipts: the rule
// changes that could be mirrored wrongly and still agree with themselves
describe('verify-results receipt mirrors', () => {
  const sf = (fraction: number, rise: number) => ({
    fraction,
    meanOn: 0.25,
    meanOff: 0.25 + rise,
    rise,
    classified: 921600
  })
  const OFF = { A: [false, false], B: [false] }

  it('checkShadedFraction grades an ABSENT compare as ratio, so old evidence keeps its rule', () => {
    // shadow-sphere as committed before the comparison-policy correction: A 9.63 % / B 4.28 %
    const stored = {
      A: sf(0.096265, 0.010407),
      B: sf(0.042842, 0.003405),
      ratio: 0.445039,
      flagsOff: OFF,
      flagsRestored: { A: [true, true], B: [true] }
    }
    expect(checkShadedFraction(stored).join('\n')).toMatch(/ratio 0\.445/)
    // and the same numbers with the declared policy pass
    expect(checkShadedFraction({ ...stored, compare: 'b-only' })).toEqual([])
  })

  it('checkShadedFraction under b-only still refuses a dead side B', () => {
    expect(
      checkShadedFraction({
        A: sf(0.5, 0),
        B: sf(0.0428, 0),
        ratio: 0.0856,
        flagsOff: OFF,
        flagsRestored: { A: [true, true], B: [true] },
        compare: 'b-only'
      }).join('\n')
    ).toMatch(/side B plate did not brighten/)
  })

  const ac = (ratio: Record<string, number>, tolerance = 0.05) => ({
    A: { r: 0.45, g: 0.0012, b: 0.0045 },
    B: { r: 6.88, g: 0.0012, b: 0.0045 },
    ratio,
    deviation: { r: 14.29, g: 0, b: 0 },
    gated: ['g', 'b'],
    tolerance,
    reasons: []
  })

  it('checkAtlasChannels scores only the gated channels', () => {
    // r is 15.29x apart, which is the documented frontDepth divergence
    expect(checkAtlasChannels(ac({ r: 15.2889, g: 1.0, b: 1.0 }))).toEqual([])
    // green off by 20 % is the optical-depth defect the gate exists for
    expect(
      checkAtlasChannels(ac({ r: 15.2889, g: 1.2, b: 1.0 })).join('\n')
    ).toMatch(/atlas channel g: B\/A 1\.2000/)
  })

  it('checkAtlasChannels refuses a receipt that gated nothing', () => {
    expect(checkAtlasChannels(ac({ r: 1, g: 1, b: 1 }, 0.05)).length).toBe(0)
    expect(
      checkAtlasChannels({
        ...ac({ r: 1, g: 1, b: 1 }),
        gated: []
      }).join('\n')
    ).toMatch(/gated no channel/)
  })

  it('checkAtlasChannels refuses a gated channel with no signal on side A', () => {
    expect(checkAtlasChannels(ac({ r: 1, g: 0, b: 1 })).join('\n')).toMatch(
      /gated channel g has no signal on side A/
    )
  })
})
