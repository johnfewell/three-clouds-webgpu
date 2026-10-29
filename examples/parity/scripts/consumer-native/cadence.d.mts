import type { PhaseIdentity } from './sampler.mjs'

export interface CadencePlan {
  mode: 'explore' | 'phase'
  waitUntil: number
  targetBefore: number | null
  overhead: number
  captureSpan: number
}
export function createPhaseCadence(): {
  plan(input: {
    currentFrame: number
    iteration: number
    hint?: Pick<PhaseIdentity, 'before'> | null
    lastMatch?: Pick<PhaseIdentity, 'after'> | null
  }): CadencePlan
  observe(
    plan: CadencePlan,
    capture: Pick<PhaseIdentity, 'before' | 'after'>
  ): {
    requested: CadencePlan
    observedBefore: number
    observedAfter: number
    nextOverhead: number
  }
}
