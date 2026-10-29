import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { METRICS_VERSION } from '../metrics'
import {
  formatEnvJson,
  formatMetricsJson,
  validateMetricsJson,
  type CaptureEnv,
  type CaptureMetrics
} from './metricsWriter'

const FIXTURE_METRICS: CaptureMetrics = {
  caseName: 'baseline-medium',
  phase: 1,
  metrics: { ssim: 0.9512, deMean: 2.34, deP95: 5.67, histDist: 0.0123 },
  eval: { result: 'pass', reasons: [] },
  maxDiffDelta: 0.042,
  dimensions: { width: 1280, height: 720 },
  timing: { captureMs: 1234.5, metricsMs: 567.8 }
}

const FIXTURE_ENV: CaptureEnv = {
  chrome: 'Chromium 130.0.6723.0',
  adapter: 'Apple M2 Max',
  os: 'macOS 15.4',
  gpu: 'hardware'
}

describe('formatMetricsJson', () => {
  test('produces valid JSON with all required keys', () => {
    const json = formatMetricsJson(FIXTURE_METRICS)
    const parsed = validateMetricsJson(json)
    expect(parsed.case).toBe('baseline-medium')
    expect(parsed.phase).toBe(1)
    expect(parsed.ssim).toBeCloseTo(0.9512, 4)
    expect(parsed.result).toBe('pass')
    expect(parsed.reasons).toEqual([])
    expect(parsed.width).toBe(1280)
    expect(parsed.height).toBe(720)
    expect(parsed.captureMs).toBe(1235)
    expect(parsed.metricsMs).toBe(568)
  })

  test('rounds numbers appropriately', () => {
    const json = formatMetricsJson(FIXTURE_METRICS)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(String(parsed.ssim).split('.')[1]!.length).toBeLessThanOrEqual(6)
    expect(String(parsed.deMean).split('.')[1]!.length).toBeLessThanOrEqual(2)
  })

  test('handles fail result with reasons', () => {
    const failing: CaptureMetrics = {
      ...FIXTURE_METRICS,
      eval: {
        result: 'fail',
        reasons: ['ssim 0.8000 < 0.9500']
      }
    }
    const json = formatMetricsJson(failing)
    const parsed = validateMetricsJson(json)
    expect(parsed.result).toBe('fail')
    expect(parsed.reasons).toContain('ssim 0.8000 < 0.9500')
  })

  test('handles expected-difference result', () => {
    const accepted: CaptureMetrics = {
      ...FIXTURE_METRICS,
      eval: {
        result: 'expected-difference',
        reasons: ['ssim 0.9000 < 0.9500', 'accepted: float precision']
      }
    }
    const json = formatMetricsJson(accepted)
    const parsed = validateMetricsJson(json)
    expect(parsed.result).toBe('expected-difference')
  })

  // The two sides carry DELIBERATELY different numbers. With one shared
  // `flicker`, a formatter writing side A's numbers into both sides passed
  // Distinct values make that duplication fail
  test('includes sequence block, keeping the two sides distinct', () => {
    const withSeq: CaptureMetrics = {
      ...FIXTURE_METRICS,
      sequence: {
        flickerA: { mean: 2.5, max: 4.1, perFrame: [2.0, 3.0, 2.5] },
        flickerB: { mean: 3.7, max: 6.2, perFrame: [3.0, 4.4, 3.7] },
        ghostingA: { deMean: 1.2, deP95: 2.8 },
        ghostingB: { deMean: 1.9, deP95: 3.6 },
        motionA: { dx: 4.125, dy: -2.125, score: 0.9123456 },
        motionB: { dx: 3.875, dy: -1.875, score: 0.8765432 },
        motionDirection: {
          aligned: true,
          comparable: true,
          cosine: 0.9876543
        },
        frameCount: 16
      }
    }
    const json = formatMetricsJson(withSeq)
    const parsed = validateMetricsJson(json)
    expect(parsed.sequence).toBeDefined()
    expect(parsed.sequence!.frameCount).toBe(16)
    expect(parsed.sequence!.flickerA.mean).toBe(2.5)
    expect(parsed.sequence!.flickerA.max).toBe(4.1)
    expect(parsed.sequence!.flickerB.mean).toBe(3.7)
    expect(parsed.sequence!.flickerB.max).toBe(6.2)
    expect(parsed.sequence!.ghostingA!.mean).toBe(1.2)
    expect(parsed.sequence!.ghostingA!.p95).toBe(2.8)
    expect(parsed.sequence!.ghostingB!.mean).toBe(1.9)
    expect(parsed.sequence!.ghostingB!.p95).toBe(3.6)
    expect(parsed.sequence!.motionA).toEqual({
      dx: 4.13,
      dy: -2.12,
      score: 0.912346
    })
    expect(parsed.sequence!.motionB).toEqual({
      dx: 3.88,
      dy: -1.87,
      score: 0.876543
    })
    expect(parsed.sequence!.motionDirection).toEqual({
      aligned: true,
      comparable: true,
      cosine: 0.987654
    })
  })

  test('omits sequence block when absent', () => {
    const json = formatMetricsJson(FIXTURE_METRICS)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.sequence).toBeUndefined()
  })

  test('validates sequence field types', () => {
    const bad = JSON.stringify({
      metricsVersion: 3,
      case: 'x',
      phase: 0,
      ssim: 1,
      deMean: 0,
      deP95: 0,
      histDist: 0,
      result: 'pass',
      reasons: [],
      maxDiffDelta: 0,
      width: 1,
      height: 1,
      captureMs: 0,
      metricsMs: 0,
      sequence: {
        frameCount: 'bad',
        flickerA: { mean: 0, max: 0 },
        flickerB: { mean: 0, max: 0 }
      }
    })
    expect(() => validateMetricsJson(bad)).toThrow(
      'sequence.frameCount must be number'
    )
  })

  test('validates sequence flickerA/flickerB structure', () => {
    const bad = JSON.stringify({
      metricsVersion: 3,
      case: 'x',
      phase: 0,
      ssim: 1,
      deMean: 0,
      deP95: 0,
      histDist: 0,
      result: 'pass',
      reasons: [],
      maxDiffDelta: 0,
      width: 1,
      height: 1,
      captureMs: 0,
      metricsMs: 0,
      sequence: {
        frameCount: 16,
        flickerA: 'bad',
        flickerB: { mean: 0, max: 0 }
      }
    })
    expect(() => validateMetricsJson(bad)).toThrow(
      'sequence.flickerA must have numeric mean and max'
    )
  })

  test('validates sequence motion structure', () => {
    const bad = JSON.stringify({
      metricsVersion: METRICS_VERSION,
      case: 'x',
      phase: 0,
      ssim: 1,
      deMean: 0,
      deP95: 0,
      histDist: 0,
      result: 'pass',
      reasons: [],
      maxDiffDelta: 0,
      width: 1,
      height: 1,
      captureMs: 0,
      metricsMs: 0,
      sequence: {
        frameCount: 16,
        flickerA: { mean: 0, max: 0 },
        flickerB: { mean: 0, max: 0 },
        motionA: { dx: 2, dy: 1, score: 'bad' }
      }
    })
    expect(() => validateMetricsJson(bad)).toThrow(
      'sequence.motionA must have numeric dx, dy and score'
    )
  })
})

// capture.mjs writes these three fields and the old schema emitted
// none, so routing it through this writer without them would drop `plate`
// and disarm evaluate's black-frame gate
describe('renderer subgroups support', () => {
  // The shaft march runs once per 2x2 quad only when the device offered
  // `subgroups`, and without it three silently falls back to per fragment. A
  // receipt that cannot say which path ran is compatible with both
  const captureSource = readFileSync(
    resolve(import.meta.dirname, '../../scripts/capture.mjs'),
    'utf8'
  )
  const writerSource = readFileSync(
    resolve(import.meta.dirname, 'metricsWriter.ts'),
    'utf8'
  )

  test('null when unprobed, never omitted', () => {
    const json = formatMetricsJson(FIXTURE_METRICS)
    const parsed = validateMetricsJson(json)
    // the key must EXIST and be null. An absent key reads as "both paths agreed"
    expect('subgroups' in (parsed as unknown as Record<string, unknown>)).toBe(
      true
    )
    expect(parsed.subgroups).toBeNull()
  })

  test('round-trips a probed value', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({ ...FIXTURE_METRICS, subgroups: true })
    )
    expect(parsed.subgroups).toBe(true)
    const off = validateMetricsJson(
      formatMetricsJson({ ...FIXTURE_METRICS, subgroups: false })
    )
    expect(off.subgroups).toBe(false)
  })

  test('rejects a non-boolean', () => {
    // through the OUTPUT shape, which is what validateMetricsJson reads
    const shaped = JSON.parse(formatMetricsJson(FIXTURE_METRICS)) as Record<
      string,
      unknown
    >
    shaped.subgroups = 'yes'
    expect(() => validateMetricsJson(JSON.stringify(shaped))).toThrow(
      /subgroups/
    )
  })

  // The sites the note at capture.mjs warns about: the page-side read, the
  // metricsObj field, the evaluate mapping, the writer's own two shapes. A field
  // added to one and not the others is dropped in silence
  test('crosses every boundary from the page to the writer', () => {
    expect(captureSource).toMatch(/hasFeature\(\s*'subgroups'\s*\)/)
    expect(captureSource).toMatch(/subgroups: subgroups \?\? null/)
    expect(captureSource).toMatch(/subgroups: m\.subgroups/)
    // the writer declares it on the input, emits it, and types the output
    expect(writerSource).toMatch(/subgroups\?: boolean \| null/)
    expect(writerSource).toMatch(/subgroups: m\.subgroups \?\? null/)
  })

  test('the page read cannot throw out of page.evaluate', () => {
    // the try/catch turns a renderer without the method into null rather than
    // an evaluate rejection that kills the capture
    expect(captureSource).toMatch(/try \{[\s\S]{0,200}catch \{\s*return null/)
  })
})

describe('formatMetricsJson — fields capture.mjs writes', () => {
  test('defaults readback to linear per ADR-011', () => {
    const parsed = validateMetricsJson(formatMetricsJson(FIXTURE_METRICS))
    expect(parsed.readback).toBe('linear')
  })

  test('emits the plate block, preserving a null cloudFraction', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        plate: {
          A: { mean: 0.0421, std: 0.0113 },
          B: { mean: 0.0419, std: 0.0109 }
        }
      })
    )
    expect(parsed.plate?.A.mean).toBeCloseTo(0.0421, 6)
    expect(parsed.plate?.B.std).toBeCloseTo(0.0109, 6)
    // absent on side A and unset on B: must serialise as null, not undefined,
    // or the key vanishes from the JSON entirely
    expect(parsed.plate?.B.cloudFraction).toBeNull()
  })

  test('round-trips a measured cloudFraction', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        plate: {
          A: { mean: 0.04, std: 0.01 },
          B: { mean: 0.04, std: 0.01, cloudFraction: 0.0207 }
        }
      })
    )
    expect(parsed.plate?.B.cloudFraction).toBeCloseTo(0.0207, 6)
  })

  test('plate and ssimAttribution are null when not supplied', () => {
    const parsed = validateMetricsJson(formatMetricsJson(FIXTURE_METRICS))
    expect(parsed.plate).toBeNull()
    expect(parsed.ssimAttribution).toBeNull()
  })
})

// gpuMs was measured, logged and never persisted, which is also why
// the 1e6 unit defect survived (a log line nobody diffs). These pin the
// serialisation so it cannot silently stop again
describe('formatMetricsJson — gpuMs', () => {
  const summary = {
    sideA: {
      available: true,
      report: {
        medianMs: 8.3,
        passes: { total: 8.3 },
        sampleCount: 32
      }
    },
    sideB: {
      available: true,
      report: {
        medianMs: 38.55,
        passes: { render: 38.55 },
        sampleCount: 32
      }
    }
  } as const

  test('persists both sides with pass breakdown and sample count', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({ ...FIXTURE_METRICS, gpuMs: summary })
    )
    expect(parsed.gpuMs?.sideA?.medianMs).toBe(8.3)
    expect(parsed.gpuMs?.sideB?.medianMs).toBe(38.55)
    expect(parsed.gpuMs?.sideB?.passes.render).toBe(38.55)
    expect(parsed.gpuMs?.sideB?.sampleCount).toBe(32)
  })

  test('records the reason when a side is unavailable, rather than dropping it', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        gpuMs: {
          sideA: summary.sideA,
          sideB: { available: false, reason: 'timestamp-query not available' }
        }
      })
    )
    expect(parsed.gpuMs?.sideB).toBeNull()
    expect(parsed.gpuMs?.sideBReason).toContain('timestamp-query')
  })

  test('omits gpuMs entirely when no timing was collected', () => {
    const parsed = validateMetricsJson(formatMetricsJson(FIXTURE_METRICS))
    expect(parsed.gpuMs).toBeUndefined()
  })
})

describe('formatEnvJson', () => {
  test('produces valid JSON with env fields', () => {
    const json = formatEnvJson(FIXTURE_ENV)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.chrome).toBe('Chromium 130.0.6723.0')
    expect(parsed.adapter).toBe('Apple M2 Max')
    expect(parsed.os).toBe('macOS 15.4')
    expect(parsed.gpu).toBe('hardware')
  })
})

describe('validateMetricsJson', () => {
  test('rejects missing keys', () => {
    expect(() => validateMetricsJson('{}')).toThrow('Missing key')
  })

  // metricsVersion reached the other three copies of the contract
  // but not this writer. Pin the round-trip both ways: the writer stamps the
  // version, and the validator refuses a document without it
  test('round-trips metricsVersion', () => {
    const parsed = validateMetricsJson(formatMetricsJson(FIXTURE_METRICS))
    expect(parsed.metricsVersion).toBe(METRICS_VERSION)
  })

  test('rejects a document with no metricsVersion', () => {
    const noVersion = JSON.stringify({
      case: 'x',
      phase: 0,
      ssim: 1,
      deMean: 0,
      deP95: 0,
      histDist: 0,
      result: 'pass',
      reasons: [],
      maxDiffDelta: 0,
      width: 1,
      height: 1,
      captureMs: 0,
      metricsMs: 0
    })
    expect(() => validateMetricsJson(noVersion)).toThrow(
      'Missing key: metricsVersion'
    )
  })

  test('rejects invalid result value', () => {
    const bad = JSON.stringify({
      metricsVersion: 3,
      case: 'x',
      phase: 0,
      ssim: 1,
      deMean: 0,
      deP95: 0,
      histDist: 0,
      result: 'banana',
      reasons: [],
      maxDiffDelta: 0,
      width: 1,
      height: 1,
      captureMs: 0,
      metricsMs: 0
    })
    expect(() => validateMetricsJson(bad)).toThrow('Invalid result')
  })

  test('rejects non-array reasons', () => {
    const bad = JSON.stringify({
      metricsVersion: 3,
      case: 'x',
      phase: 0,
      ssim: 1,
      deMean: 0,
      deP95: 0,
      histDist: 0,
      result: 'pass',
      reasons: 'not-array',
      maxDiffDelta: 0,
      width: 1,
      height: 1,
      captureMs: 0,
      metricsMs: 0
    })
    expect(() => validateMetricsJson(bad)).toThrow('reasons must be array')
  })
})

describe('formatMetricsJson — shadedFraction receipt', () => {
  test('is null when not supplied (non-shadow cases)', () => {
    const parsed = validateMetricsJson(formatMetricsJson(FIXTURE_METRICS))
    expect(parsed.shadedFraction).toBeNull()
  })

  test('round-trips a receipt with its flags and reasons', () => {
    const side = {
      fraction: 0.2131,
      meanOn: 0.081,
      meanOff: 0.093,
      rise: 0.129,
      classified: 786432
    }
    const parsed = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        shadedFraction: {
          A: side,
          B: { ...side, fraction: 0.2074 },
          ratio: 0.973,
          flagsOff: { A: [false, false], B: [false] },
          flagsRestored: { A: [true, true], B: [true] },
          reasons: []
        }
      })
    )
    const sf = parsed.shadedFraction
    if (sf == null || 'error' in sf || 'skipped' in sf) {
      throw new Error('receipt missing')
    }
    expect(sf.ratio).toBeCloseTo(0.973, 6)
    expect(sf.B.fraction).toBeCloseTo(0.2074, 6)
    expect(sf.flagsOff).toEqual({ A: [false, false], B: [false] })
    expect(sf.flagsRestored.B).toEqual([true])
    expect(sf.reasons).toEqual([])
  })

  test('round-trips a receipt that could not be taken', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        shadedFraction: { error: 'probe has no setShadow' }
      })
    )
    expect(parsed.shadedFraction).toEqual({ error: 'probe has no setShadow' })
  })

  test('rejects a receipt whose ratio is not a number', () => {
    const json = formatMetricsJson(FIXTURE_METRICS).replace(
      '"shadedFraction": null',
      '"shadedFraction": { "reasons": [] }'
    )
    expect(() => validateMetricsJson(json)).toThrow(/shadedFraction\.ratio/)
  })

  // the policy travels with the evidence, so verify-results re-grades
  // case 35 the way it was captured
  test("carries the compare policy, and reads as 'ratio' when it is absent", () => {
    const side = {
      fraction: 0.0963,
      meanOn: 0.2468,
      meanOff: 0.2494,
      rise: 0.0104,
      classified: 921600
    }
    const base = {
      A: side,
      B: { ...side, fraction: 0.0428 },
      ratio: 0.445,
      flagsOff: { A: [false], B: [false] },
      flagsRestored: { A: [true], B: [true] },
      reasons: []
    }
    const declared = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        shadedFraction: { ...base, compare: 'b-only' as const }
      })
    ).shadedFraction
    if (declared == null || 'error' in declared || 'skipped' in declared) {
      throw new Error('receipt missing')
    }
    expect(declared.compare).toBe('b-only')
    const absent = validateMetricsJson(
      formatMetricsJson({ ...FIXTURE_METRICS, shadedFraction: base })
    ).shadedFraction
    if (absent == null || 'error' in absent || 'skipped' in absent) {
      throw new Error('receipt missing')
    }
    expect(absent.compare).toBeUndefined()
  })
})

// This is the THIRD re-key boundary: the first capture
// computed the receipt, logged it, and metrics.json came out without it,
// because this writer is where the file is actually formed
describe('formatMetricsJson — atlasChannels receipt', () => {
  const receipt = {
    A: { r: 0.4508, g: 0.0012179, b: 0.00451 },
    B: { r: 6.8774, g: 0.0012234, b: 0.0044389 },
    ratio: { r: 15.2561, g: 1.0046, b: 0.9842 },
    deviation: { r: 14.2561, g: 0.0046, b: 0.0158 },
    gated: ['g', 'b'] as ('r' | 'g' | 'b')[],
    tolerance: 0.05,
    reasons: []
  }

  test('is null when the case declares no atlas gate', () => {
    expect(
      validateMetricsJson(formatMetricsJson(FIXTURE_METRICS)).atlasChannels
    ).toBeNull()
  })

  test('round-trips every channel, and says which are gated', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({ ...FIXTURE_METRICS, atlasChannels: receipt })
    )
    expect(parsed.atlasChannels).toEqual(receipt)
  })

  test('round-trips a REFUSAL, whose gated list is empty', () => {
    const refusal = {
      ...receipt,
      gated: [] as ('r' | 'g' | 'b')[],
      reasons: ['atlas-channel receipt REFUSED: the case gated no channel']
    }
    expect(
      validateMetricsJson(
        formatMetricsJson({ ...FIXTURE_METRICS, atlasChannels: refusal })
      ).atlasChannels
    ).toEqual(refusal)
  })

  test('round-trips a receipt that could not be taken', () => {
    expect(
      validateMetricsJson(
        formatMetricsJson({
          ...FIXTURE_METRICS,
          atlasChannels: { error: 'plate truncated' }
        })
      ).atlasChannels
    ).toEqual({ error: 'plate truncated' })
  })

  test('rejects a ratio missing a channel', () => {
    const json = formatMetricsJson({
      ...FIXTURE_METRICS,
      atlasChannels: receipt
    }).replace('"b": 0.9842', '"b": null')
    expect(() => validateMetricsJson(json)).toThrow(/atlasChannels\.ratio\.b/)
  })
})

// (mail #673): a declared skip round-trips with its reason
describe('formatMetricsJson — shadedFraction declared skip', () => {
  test('round-trips { skipped: reason }', () => {
    const parsed = validateMetricsJson(
      formatMetricsJson({
        ...FIXTURE_METRICS,
        shadedFraction: { skipped: 'the subject is the shadow atlas' }
      })
    )
    expect(parsed.shadedFraction).toEqual({
      skipped: 'the subject is the shadow atlas'
    })
  })
})
