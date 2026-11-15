// Complete-verdict composition must agree across the three consumers when a
// hard receipt fails: capture composes in memory, verify re-derives from the
// artifact, and the conformance test asks both. A failing atlas or shaded
// receipt is a fail whatever the metric arithmetic says, and the arithmetic
// reasons stay in the list ahead of it
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  captureShadedFractionReasons,
  checkAtlasChannels,
  checkShadedFraction,
  evaluateCommittedMetrics
} from '../../../../scripts/verify-results.mjs'
import { table } from '../../../../test/helpers/cpuTwin'
import { composeVerdict, type ReceiptBlocks } from './composeVerdict.mjs'
import { evaluate as evaluateCapture } from './evaluator.mjs'

const ROOT = resolve(import.meta.dirname, '../../../..')
const THRESHOLDS = JSON.parse(
  readFileSync(
    join(ROOT, 'examples', 'parity', 'cases', 'thresholds.json'),
    'utf8'
  )
)
// The 4/debug-shadow-map receipt from the re-captured ladder (PR 480) that
// carries a real failure of the 5 % atlas gate on channel b
const ATLAS_FAIL_RECEIPT = JSON.parse(
  readFileSync(
    join(
      ROOT,
      'examples',
      'parity',
      'test',
      'fixtures',
      'metrics-atlas-receipt-fail.json'
    ),
    'utf8'
  )
)

type Stored = Record<string, unknown> & {
  case: string
  phase: number
  ssim: number
  deMean: number
  deP95: number
  histDist: number
  plate: unknown
}

function phaseThresholds(phase: number) {
  return THRESHOLDS.phases[phase] ?? {}
}

function plateCheck(metrics: Stored) {
  return {
    minStd: THRESHOLDS.plate?.minStd ?? 0.002,
    minCloudFraction: THRESHOLDS.plate?.minCloudFraction ?? 0.0005,
    plate: metrics.plate as never
  }
}

// The capture runner's path: metric verdict first, then the receipts it holds
// in memory, whose reasons it built itself
function capturePath(metrics: Stored) {
  const metric = evaluateCapture(
    {
      ssim: metrics.ssim,
      deMean: metrics.deMean,
      deP95: metrics.deP95,
      histDist: metrics.histDist
    },
    phaseThresholds(metrics.phase),
    metrics.case,
    THRESHOLDS.accepted,
    plateCheck(metrics)
  )
  return composeVerdict(metric, metrics as ReceiptBlocks, {
    shadedFraction: captureShadedFractionReasons,
    atlasChannel: checkAtlasChannels
  })
}

// The committed-results verifier's path: it re-derives both receipts from the
// stored numbers rather than trusting the recorded reasons
const verifyPath = (metrics: Stored) =>
  evaluateCommittedMetrics(
    metrics,
    phaseThresholds(metrics.phase),
    metrics.case,
    THRESHOLDS.accepted,
    plateCheck(metrics)
  )

function assertAgree(metrics: Stored, label: string) {
  const capture = capturePath(metrics)
  const verify = verifyPath(metrics)
  table(`complete-verdict ${label}`, [
    {
      consumer: 'capture',
      result: capture.result,
      reasons: capture.reasons.length
    },
    {
      consumer: 'verify',
      result: verify.result,
      reasons: verify.reasons.length
    }
  ])
  expect(capture.result, label).toBe('fail')
  expect(verify.result, label).toBe('fail')
  expect(verify.reasons, label).toEqual(capture.reasons)
  return { capture, verify }
}

describe('complete verdict composition across consumers', () => {
  it('(a) the real PR 480 debug-shadow-map receipt fails on its atlas channel through every consumer', () => {
    const { capture, verify } = assertAgree(
      ATLAS_FAIL_RECEIPT as Stored,
      'atlas-real'
    )
    // the full ordered list, not a subset: the three arithmetic reasons (ssim
    // then deP95 then histDist, as the evaluator emits them), the
    // accepted-footprint sentence with its floor, then the atlas line
    expect(capture.reasons).toHaveLength(5)
    expect(capture.reasons[0]).toMatch(/^ssim 0\.3811 < 0\.9800$/)
    expect(capture.reasons[1]).toMatch(/^deP95 58\.86 > 5\.00$/)
    expect(capture.reasons[2]).toMatch(/^histDist 14\.0788 > 0\.1000$/)
    expect(capture.reasons[3]).toMatch(/^accepted: ADR-011 Amendment 13: /)
    expect(capture.reasons[3]).toMatch(
      /\[floor ssim 0\.3810, deP95 58\.8700, histDist 14\.0789\]$/
    )
    expect(capture.reasons[4]).toMatch(/^atlas channel b: B\/A 0\.9451/)
    // and the consumer test's own equality went through this same list
    expect(verify.reasons).toEqual(capture.reasons)
  })

  it('(b) a synthetic atlas-only failure forces FAIL with no metric reason', () => {
    // rewrite the fixture so the metric arithmetic passes and only the atlas
    // channel is wrong: the receipt's recorded reasons must be what fails it
    const synthetic = {
      ...(ATLAS_FAIL_RECEIPT as Stored),
      ssim: 0.99,
      deP95: 0,
      histDist: 0
    }
    const { capture, verify } = assertAgree(synthetic, 'atlas-only')
    // the numbers are recomputed from the stored means, and the sentence
    // after the dash is carried from the receipt's own stored line
    expect(capture.reasons).toEqual([
      'atlas channel b: B/A 0.9451 (deviation 5.49 % > 5.00 %) — ' +
        'the channels that decide optical depth; red is the march fallback, ' +
        'clamped by both consumers above the whole plausible distanceToTop'
    ])
    expect(verify.reasons).toEqual(capture.reasons)
  })

  it('(c) a simultaneous shaded-fraction and atlas failure keeps capture order', () => {
    // a receipt whose casters-off arm never brightened: both sides fail the
    // precondition, so the shaded reasons come out in A-then-B order
    const flat = { fraction: 0.5, meanOn: 0.25, meanOff: 0.25, rise: 0 }
    const shaded = {
      ...ATLAS_FAIL_RECEIPT.shadedFraction,
      skipped: undefined,
      A: flat,
      B: flat,
      ratio: 1,
      flagsOff: { A: [false, false], B: [false] },
      flagsRestored: { A: [true, true], B: [true] },
      compare: 'ratio',
      reasons: undefined
    }
    const synthetic = {
      ...(ATLAS_FAIL_RECEIPT as Stored),
      ssim: 0.99,
      deP95: 0,
      histDist: 0,
      shadedFraction: shaded
    }
    const { capture, verify } = assertAgree(synthetic, 'shaded+atlas')
    // shaded-fraction is appended first, the atlas failure second
    expect(capture.reasons[0]).toMatch(/^shaded-fraction receipt: side A/)
    expect(capture.reasons[1]).toMatch(/^shaded-fraction receipt: side B/)
    expect(capture.reasons[2]).toMatch(/^atlas channel b: B\/A 0\.9451/)
    expect(verify.reasons).toEqual(capture.reasons)
  })
})

describe('the composition helper is the single definition', () => {
  it('verify and the consumer test derive receipts through the same checks', () => {
    const ac = (ATLAS_FAIL_RECEIPT as Stored).atlasChannels
    const derived = composeVerdict(
      { result: 'pass', reasons: [] },
      { atlasChannels: ac },
      { atlasChannel: checkAtlasChannels }
    )
    expect(derived.result).toBe('fail')
    expect(derived.reasons).toEqual(checkAtlasChannels(ac))
  })

  it('a declared skip is not evidence and does not force a fail', () => {
    const verdict = composeVerdict(
      { result: 'pass', reasons: [] },
      { shadedFraction: { skipped: 'the subject is the atlas' } },
      { shadedFraction: checkShadedFraction }
    )
    expect(verdict).toEqual({ result: 'pass', reasons: [] })
  })

  it('an absent receipt block changes nothing', () => {
    const metric = {
      result: 'expected-difference' as const,
      reasons: ['accepted: x']
    }
    expect(composeVerdict(metric, null)).toEqual(metric)
    expect(composeVerdict(metric, { shadedFraction: null })).toEqual(metric)
  })

  it('a receipt error is reported as a failure even past a passing metric', () => {
    const verdict = composeVerdict(
      { result: 'pass', reasons: [] },
      { atlasChannels: { error: 'probe has no atlas' } }
    )
    expect(verdict).toEqual({
      result: 'fail',
      reasons: ['atlas-channel receipt could not be taken: probe has no atlas']
    })
  })
})
