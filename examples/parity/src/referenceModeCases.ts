// Which ladder cases reference mode moves, and how
//
// Only the cases whose output changes need a fresh capture. The rest move a
// cache key and nothing else, which the WGSL comparison in
// src/CloudsPassNode.test.ts proves rather than assumes. Rule and evidence:
// docs/design/standalone-defaults.md §7

import {
  experimentalDefaults,
  REFERENCE_MODE,
  type ExperimentalCloudOptions
} from 'three-clouds-webgpu'

import { effectiveState, type CaseDefinition } from '../cases/index'

export type ReferenceModeImpact = 'pixels' | 'program-only' | 'none'

export interface ReferenceModeCaseImpact {
  readonly name: string
  readonly number: number
  readonly phase: number
  readonly impact: ReferenceModeImpact
  readonly why: string
}

/**
 * Experimental options whose library default differs from the reference pin, by
 * name. Derived rather than listed, so promoting a second option cannot leave
 * the sweep reading as if nothing moved.
 */
export function promotedExperiments(): Array<keyof ExperimentalCloudOptions> {
  return (
    Object.keys(experimentalDefaults) as Array<keyof ExperimentalCloudOptions>
  ).filter(
    key => experimentalDefaults[key] !== REFERENCE_MODE.experimental[key]
  )
}

// Two pins reach the graph, each gated by the case's own state:
// lightShaftsHalfResolution by lightShafts, distantShapeDetailFade by
// shapeDetail. updateInterval reaches no graph, it is a per-frame cadence
function impactOf(cd: CaseDefinition): {
  impact: ReferenceModeImpact
  why: string
} {
  const eff = effectiveState(cd)
  const promoted = promotedExperiments()
  const fade = promoted.includes('distantShapeDetailFade') && eff.shapeDetail
  if (eff.lightShafts) {
    return {
      impact: 'pixels',
      why: 'lightShafts on: the quad-shared shaft march is replaced by the per-fragment march'
    }
  }
  if (fade) {
    return {
      impact: 'pixels',
      why: 'shapeDetail on: the detail term fades with mip level instead of a binary choice'
    }
  }
  return {
    impact: 'program-only',
    why: 'neither promoted pin is built here: the cache key moves but the emitted graph is identical'
  }
}

export function referenceModeImpacts(
  registry: readonly CaseDefinition[]
): ReferenceModeCaseImpact[] {
  return registry.map(cd => {
    const { impact, why } = impactOf(cd)
    return {
      name: cd.name,
      number: cd.number,
      phase: cd.phase,
      impact,
      why
    }
  })
}

// The re-capture list. Kept as its own function so a capture gate can consume
// it without re-deriving the rule
export function referenceModeRecaptureList(
  registry: readonly CaseDefinition[]
): ReferenceModeCaseImpact[] {
  return referenceModeImpacts(registry).filter(e => e.impact === 'pixels')
}
