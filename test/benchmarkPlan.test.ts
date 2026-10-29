import { describe, expect, it } from 'vitest'

import { caseByName } from '../examples/parity/cases/index'
import {
  DEFAULT_VARIANTS,
  EXPERIMENT_KEYS,
  FULL_VARIANTS,
  makePlan,
  planFingerprint,
  scheduleFor,
  validatePlan
} from '../examples/parity/scripts/benchmarks/plan.mjs'

describe('portable benchmark plan', () => {
  it('contains baseline, singles, all-on, and all-minus-one variants', () => {
    const ids = DEFAULT_VARIANTS.map(variant => variant.id)
    expect(ids).toEqual([
      'baseline',
      ...EXPERIMENT_KEYS,
      'all-experiments',
      ...EXPERIMENT_KEYS.map(key => `all-minus-${key}`)
    ])
    for (const variant of DEFAULT_VARIANTS)
      expect(Object.keys(variant.experimental)).toEqual(EXPERIMENT_KEYS)
  })

  it('uses a short smoke profile and a 32-combination full profile', () => {
    const smoke = makePlan({ profile: 'smoke' })
    const full = makePlan({ profile: 'full' })
    expect(smoke).toMatchObject({
      warmupFrames: 8,
      sampleFrames: 8,
      repeats: 1
    })
    expect(smoke.variants).toHaveLength(1)
    expect(full.variants).toHaveLength(2 ** EXPERIMENT_KEYS.length)
    expect(full.variants).toEqual(FULL_VARIANTS)
    expect(full).toMatchObject({
      sampleFrames: 120,
      repeats: 3,
      warmupFrames: 64
    })
    expect(full.cases).toHaveLength(32)
    expect(new Set(full.cases.map(scene => scene.motion))).toEqual(
      new Set(['static', 'shape'])
    )
    for (const scene of full.cases) {
      expect(caseByName(scene.caseName)).toBeDefined()
      expect(scene.settings).not.toHaveProperty('motion')
    }
    expect(
      new Set(full.cases.map(scene => scene.settings.temporalUpscale))
    ).toEqual(new Set([false, true]))
    expect(full.resolutions).toEqual([
      [1920, 1080],
      [3840, 2160]
    ])
  })

  it('produces a stable seeded schedule', () => {
    const plan = makePlan({ repeats: 1 })
    const first = scheduleFor(plan).map(
      job => `${job.backend}:${job.variant.id}`
    )
    const second = scheduleFor(plan).map(
      job => `${job.backend}:${job.variant.id}`
    )
    expect(first).toEqual(second)
    expect(first).toHaveLength(
      plan.cases.length * plan.variants.length * plan.backends.length
    )
  })

  it('changes schedule when seed changes without changing work', () => {
    const a = scheduleFor(makePlan({ repeats: 1, seed: 1 }))
    const b = scheduleFor(makePlan({ repeats: 1, seed: 2 }))
    expect(a.map(job => job.orderIndex)).toEqual(b.map(job => job.orderIndex))
    expect(
      a.map(job => `${job.backend}:${job.variant.id}:${job.scene.caseName}`)
    ).not.toEqual(
      b.map(job => `${job.backend}:${job.variant.id}:${job.scene.caseName}`)
    )
  })

  it('rejects zero-work plans', () => {
    expect(() => validatePlan(makePlan({ cases: [] }))).toThrow(
      /at least one case/
    )
    expect(() => validatePlan(makePlan({ sampleFrames: 0 }))).toThrow(
      /sampleFrames/
    )
  })

  it('fingerprints all comparison-affecting inputs', () => {
    const a = planFingerprint(makePlan())
    const b = planFingerprint(makePlan({ sampleFrames: 25 }))
    expect(a).not.toBe(b)
  })

  it('rejects duplicated arms and nonphysical resolution scaling', () => {
    const plan = makePlan({ profile: 'smoke' })
    expect(() => makePlan({ backends: ['webgl', 'webgl'] })).toThrow(
      /Duplicate/
    )
    expect(() => makePlan({ cases: [...plan.cases, ...plan.cases] })).toThrow(
      /Duplicate/
    )
    expect(() =>
      makePlan({ variants: [...plan.variants, ...plan.variants] })
    ).toThrow(/Duplicate/)
    expect(() =>
      makePlan({ cases: plan.cases.map(scene => ({ ...scene, dpr: 2 })) })
    ).toThrow(/physical pixels/)
  })
})
