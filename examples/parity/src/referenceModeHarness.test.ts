// Reference mode reaches the parity harness: the ladder runs the original's
// behaviour whatever the public defaults are, and the Storybook's Baseline is
// the reference rather than "the experiments off"
//
// Design and evidence: docs/design/standalone-defaults.md §7

import {
  CloudsContext,
  defaults,
  experimentalDefaults,
  qualityPresets,
  REFERENCE_MODE,
  type ExperimentalCloudOptions
} from 'three-clouds-webgpu'
import { describe, expect, it } from 'vitest'

import { table } from '../../../test/helpers/cpuTwin'
import { cases, effectiveState } from '../cases/index'
import { applyToB, buildCaseParityState, PARITY_KEYS } from './parityState'
import {
  promotedExperiments,
  referenceModeImpacts,
  referenceModeRecaptureList
} from './referenceModeCases'
import type { SideBHandle } from './sideB'

function stubSideB(ctx: CloudsContext): SideBHandle {
  return { cloudsContext: ctx, atmosphereContext: {} } as unknown as SideBHandle
}

describe('the harness carries reference mode on every case', () => {
  it('loads side B on the reference pins, whatever the port defaults are', () => {
    // The premise: the two pins are NOT the port's defaults, so pinning them
    // is a real move and not a no-op that would pass while doing nothing
    expect(defaults.shadow.updateInterval).not.toBe(
      REFERENCE_MODE.shadowUpdateInterval
    )
    expect(cases.length).toBeGreaterThan(0)

    const rows: Array<Record<string, unknown>> = []
    for (const cd of cases) {
      const ctx = new CloudsContext()
      const before = {
        interval: ctx.shadow.updateInterval,
        halfResolution: ctx.lightShaftsHalfResolution,
        experiments: Object.values(ctx.experimental).filter(Boolean).length
      }
      applyToB(buildCaseParityState(cd), stubSideB(ctx))
      rows.push({
        case: cd.name,
        interval: `${before.interval} -> ${ctx.shadow.updateInterval}`,
        halfResolution: `${before.halfResolution} -> ${ctx.lightShaftsHalfResolution}`,
        experiments: `${before.experiments} -> ${Object.values(ctx.experimental).filter(Boolean).length}`
      })
      expect(ctx.shadow.updateInterval, cd.name).toBe(
        REFERENCE_MODE.shadowUpdateInterval
      )
      expect(ctx.lightShaftsHalfResolution, cd.name).toBe(
        REFERENCE_MODE.lightShaftsHalfResolution
      )
      expect(ctx.experimental, cd.name).toEqual(REFERENCE_MODE.experimental)
    }
    table('reference-mode-case-load', rows)
  })

  it('a set() partial without a reference pin leaves a deliberate value alone', () => {
    const ctx = new CloudsContext()
    ctx.shadow.updateInterval = 3
    ctx.lightShaftsHalfResolution = true
    ctx.experimental = { computeResolve: true }
    applyToB({ shadow: { temporalPass: false } } as never, stubSideB(ctx))
    expect(ctx.shadow.updateInterval).toBe(3)
    expect(ctx.lightShaftsHalfResolution).toBe(true)
    // The setter merges, so a deliberate option survives as its set value
    expect(ctx.experimental.computeResolve).toBe(true)
  })

  // The property this task exists for. Before reference mode the state
  // inherited whatever the library shipped, so a default change moved the
  // ladder. Now the pins come from REFERENCE_MODE, written in no default's terms
  it('a library default change does not move the harness state', () => {
    const cd = cases[0]!
    const before = buildCaseParityState(cd)
    const intervals = qualityPresets.medium.shadow.updateInterval
    const halfResolution = new CloudsContext().lightShaftsHalfResolution
    try {
      defaults.shadow.updateInterval = 7
      // And the presets, which is what the harness actually spreads
      qualityPresets.medium.shadow.updateInterval = 7
      qualityPresets.low.shadow.updateInterval = 7
      const after = buildCaseParityState(cd)

      expect(before.shadow?.updateInterval).toBe(
        REFERENCE_MODE.shadowUpdateInterval
      )
      expect(after.shadow?.updateInterval).toBe(
        REFERENCE_MODE.shadowUpdateInterval
      )
      expect(before.lightShaftsHalfResolution).toBe(
        REFERENCE_MODE.lightShaftsHalfResolution
      )
      expect(after.lightShaftsHalfResolution).toBe(
        REFERENCE_MODE.lightShaftsHalfResolution
      )
      expect(after.experimental).toEqual(REFERENCE_MODE.experimental)
      expect(halfResolution).toBe(true)
      // The promoted option is the live proof that the pins are not defaults:
      // the library ships the fade on and every case still loads with it off
      expect(experimentalDefaults.distantShapeDetailFade).toBe(true)
      expect(before.experimental?.distantShapeDetailFade).toBe(false)
      expect(after.experimental?.distantShapeDetailFade).toBe(false)
    } finally {
      defaults.shadow.updateInterval = intervals
      qualityPresets.medium.shadow.updateInterval = intervals
      qualityPresets.low.shadow.updateInterval = intervals
    }
  })

  it('every pin the harness sends equals the library REFERENCE_MODE', () => {
    const state = buildCaseParityState(cases[0]!)
    expect(state.lightShaftsHalfResolution).toBe(
      REFERENCE_MODE.lightShaftsHalfResolution
    )
    expect(state.shadow?.updateInterval).toBe(
      REFERENCE_MODE.shadowUpdateInterval
    )
    // Every experiment is pinned, and said so explicitly here rather than
    // inherited by leaving the key out
    expect(state.experimental).toEqual({ ...REFERENCE_MODE.experimental })
    // The pin is NOT the library's own default set, or a promotion would carry
    // itself into the ladder
    expect(REFERENCE_MODE.experimental).not.toEqual({
      ...experimentalDefaults
    })
  })

  // Reference mode is a case-load pin, not an e2e knob. PARITY_KEYS is the
  // set of properties `probe.set()` accepts, and every one of them must exist
  // on BOTH sides (parityState.test.ts), which none of these three do
  it('keeps every port-only path out of the e2e set() surface', () => {
    for (const key of [
      'lightShaftsHalfResolution',
      'updateInterval',
      'experimental'
    ]) {
      expect(
        PARITY_KEYS.some(k => k.key === key),
        `${key} must not be a PARITY_KEY`
      ).toBe(false)
    }
  })

  // The proof needs no GPU: each case is compared against an
  // INDEPENDENT copy of the reference values, which a pin derived from the
  // library defaults cannot satisfy
  it('every case carries the reference pins, not the library defaults', () => {
    const reference: ExperimentalCloudOptions = {
      cloudFrontRefinement: false,
      computeResolve: false,
      windReprojection: false,
      distantCloudShadows: false,
      directionalSkylight: false,
      distantShapeDetailFade: false,
      cloudTypeMap: false,
      evolvingWeather: false,
      proceduralWeather: false,
      convectiveProfile: false,
      rainShafts: false,
      moonlight: false,
      lightning: false,
      cloudEnvironment: false,
      staticMode: false,
      cirrusDeck: false,
      shadowRoundRobin: false
    }
    const fresh = new CloudsContext()
    // the premise, so the assertions below are not passing over nothing: the
    // library really does ship the fade on
    expect(fresh.experimental.distantShapeDetailFade).toBe(true)
    expect(fresh.experimental).not.toEqual(reference)

    const rows: Array<Record<string, unknown>> = []
    for (const cd of cases) {
      const state = buildCaseParityState(cd)
      expect(state.experimental, cd.name).toEqual(reference)
      expect(state.experimental?.distantShapeDetailFade, cd.name).toBe(false)
      expect(state.lightShaftsHalfResolution, cd.name).toBe(false)
      expect(state.shadow?.updateInterval, cd.name).toBe(1)
      rows.push({
        case: cd.name,
        number: cd.number,
        fade: String(state.experimental?.distantShapeDetailFade),
        experimentsOn: Object.values(state.experimental ?? {}).filter(Boolean)
          .length
      })
    }
    // Not a sample: the whole registry, which is what "the ladder does not
    // move" has to mean
    expect(rows.length).toBe(cases.length)
    table('reference-mode-fade-pin', rows)
  })
})

describe('which cases reference mode moves', () => {
  it('a case moves when a promoted pin reaches its graph', () => {
    const impacts = referenceModeImpacts(cases)
    const recapture = referenceModeRecaptureList(cases)
    const programOnly = impacts.filter(e => e.impact === 'program-only')

    // Enumerated by running the rule over the registry, not from a hand-typed
    // list, so a new case cannot quietly fall out of the sweep
    table(
      'reference-mode-impact',
      impacts.map(e => ({
        case: e.name,
        number: e.number,
        phase: e.phase,
        impact: e.impact,
        why: e.why
      }))
    )

    expect(recapture.length).toBeGreaterThan(0)
    expect(recapture.length + programOnly.length).toBe(cases.length)
    // Nothing lands in 'none': the cache key moves for every case, because
    // lightShaftsHalfResolution is a graphFlags() term
    expect(impacts.some(e => e.impact === 'none')).toBe(false)

    // The rule itself, not just its output counts: the bucket is a function of
    // lightShafts and of whether a promoted experiment reaches the case's graph
    for (const cd of cases) {
      const eff = effectiveState(cd)
      const bucket = impacts.find(e => e.name === cd.name)!
      const expected =
        eff.lightShafts ||
        (promotedExperiments().includes('distantShapeDetailFade') &&
          eff.shapeDetail)
      expect(bucket.impact === 'pixels', cd.name).toBe(expected)
    }

    logRecapture(recapture)
  })

  it('names every recapture case for the Mac mini fleet', () => {
    const recapture = referenceModeRecaptureList(cases)
    const names = recapture.map(e => e.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('shafts-low-sun')

    logRecapture(recapture)
  })

  // The fade gates the detail branch of every density sample, so
  // the recapture list grew from the three shafts cases to every case that
  // samples shape detail. The rest stay program-only (CloudsPassNode.test.ts)
  it('the fade promotion added every shapeDetail case to the recapture list', () => {
    const recapture = referenceModeRecaptureList(cases)
    const inList = new Set(recapture.map(e => e.name))
    const moved = cases.filter(cd => {
      const eff = effectiveState(cd)
      return eff.lightShafts || eff.shapeDetail
    })
    const stillProgramOnly = cases.filter(
      cd => !inList.has(cd.name) && !effectiveState(cd).lightShafts
    )
    // the premise: the fade really is a promoted pin, and it really did widen
    // the list beyond the shafts cases that were in it before
    expect(promotedExperiments()).toContain('distantShapeDetailFade')
    expect(moved.length).toBeGreaterThan(
      cases.filter(cd => effectiveState(cd).lightShafts).length
    )
    expect(recapture.length).toBe(moved.length)
    for (const cd of moved) {
      expect(inList.has(cd.name), cd.name).toBe(true)
    }
    // exactly the cases that sample neither: derived, so a new case cannot fall
    // out of the sweep
    expect(stillProgramOnly.map(cd => cd.name)).toEqual(
      cases
        .filter(
          cd =>
            !effectiveState(cd).lightShafts && !effectiveState(cd).shapeDetail
        )
        .map(cd => cd.name)
    )
    expect(stillProgramOnly.length).toBeGreaterThan(0)

    logRecapture(recapture)
  })
})

function logRecapture(entries: Array<{ name: string; number: number }>): void {
  table(
    'reference-mode-recapture',
    entries.map(e => ({ case: e.name, number: e.number }))
  )
}
