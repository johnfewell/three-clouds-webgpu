import { insist } from './proof.mjs'
import { RECURRENCE_LIMITS } from './sampler.mjs'

const PERIOD = 64

export function createPhaseCadence() {
  let overhead = 0
  let captureSpan = 1
  let lastGuided
  return {
    plan({ currentFrame, iteration, hint, lastMatch }) {
      insist(
        Number.isSafeInteger(currentFrame) && currentFrame >= 0,
        'invalid cadence frame'
      )
      const exploreUntil = currentFrame + 12 + (iteration % 2)
      if (hint == null)
        return {
          mode: 'explore',
          waitUntil: exploreUntil,
          targetBefore: null,
          overhead,
          captureSpan
        }
      insist(
        Number.isSafeInteger(hint.before) && hint.before >= 0,
        'invalid phase hint'
      )
      const minimumAfter = Math.max(
        lastGuided?.after ?? -64,
        lastMatch?.after ?? -64
      )
      const earliest = Math.max(
        currentFrame + overhead + 1,
        minimumAfter + RECURRENCE_LIMITS.minimumFrameGap
      )
      const phase = hint.before % PERIOD
      const targetBefore =
        phase + Math.ceil((earliest - phase) / PERIOD) * PERIOD
      const explore = exploreUntil + overhead + captureSpan + 1 < targetBefore
      return {
        mode: explore ? 'explore' : 'phase',
        waitUntil: explore ? exploreUntil : targetBefore - overhead,
        targetBefore,
        overhead,
        captureSpan
      }
    },
    observe(plan, capture) {
      insist(
        Number.isSafeInteger(capture.before) &&
          Number.isSafeInteger(capture.after) &&
          capture.after >= capture.before &&
          capture.before >= plan.waitUntil,
        'invalid observed cadence bracket'
      )
      captureSpan = capture.after - capture.before
      if (plan.mode === 'phase') {
        lastGuided = { before: capture.before, after: capture.after }
        overhead = Math.min(PERIOD - 1, capture.before - plan.waitUntil)
      }
      return {
        requested: plan,
        observedBefore: capture.before,
        observedAfter: capture.after,
        nextOverhead: overhead
      }
    }
  }
}
