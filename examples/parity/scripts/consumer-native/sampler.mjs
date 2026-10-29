import { comparePixels, LIMITS } from './pixels.mjs'
import { insist } from './proof.mjs'

export const RECURRENCE_LIMITS = Object.freeze({
  history: 64,
  minimumFrameGap: 64,
  matches: 3
})

function summary(sample) {
  return {
    index: sample.index,
    name: sample.name,
    before: sample.before,
    after: sample.after
  }
}

function spaced(first, second) {
  return second.before - first.after >= RECURRENCE_LIMITS.minimumFrameGap
}

function meaningful(metrics) {
  return (
    metrics.mean > LIMITS.minimumMean && metrics.range > LIMITS.minimumRange
  )
}

function findAnchor(history, sample) {
  return history.find(
    candidate =>
      candidate.eligible &&
      spaced(candidate, sample) &&
      comparePixels(candidate.image, sample.image).meanDifference <=
        LIMITS.stableMean
  )
}

function matchAnchor(anchor, previous, sample) {
  if (!sample.eligible || anchor == null || !spaced(previous, sample))
    return null
  const difference = comparePixels(anchor.image, sample.image)
  return difference.meanDifference <= LIMITS.stableMean
    ? { sample, difference, gap: sample.before - previous.after }
    : null
}

function recurrenceSummary(match) {
  return {
    ...summary(match.sample),
    difference: match.difference,
    gap: match.gap
  }
}

export function createPhaseSampler({
  reference,
  referenceLimit = LIMITS.stableMean
} = {}) {
  insist(
    [LIMITS.stableMean, LIMITS.restoreMean].includes(referenceLimit),
    'unsupported phase reference tolerance'
  )
  const history = []
  let anchor
  let matched = []
  let nextIndex = 0
  let complete = false
  return {
    push(input) {
      insist(!complete, 'phase sampler already completed')
      insist(
        Number.isSafeInteger(input.before) &&
          Number.isSafeInteger(input.after) &&
          input.before >= 0 &&
          input.after >= input.before,
        'invalid public frame bracket'
      )
      const previous = history.at(-1)
      insist(
        previous == null || input.before >= previous.after,
        'public frame counter moved backwards'
      )
      const sample = { ...input, index: nextIndex++ }
      const visible = comparePixels(sample.image)
      const adjacent =
        previous == null ? null : comparePixels(previous.image, sample.image)
      const referenceDifference =
        reference == null ? null : comparePixels(reference, sample.image)
      sample.eligible =
        meaningful(visible) &&
        (referenceDifference == null ||
          referenceDifference.meanDifference <= referenceLimit)
      const expired =
        anchor != null &&
        sample.index - matched.at(-1).sample.index > RECURRENCE_LIMITS.history
      if (expired) {
        anchor = undefined
        matched = []
      }
      if (sample.eligible && anchor == null) {
        anchor = findAnchor(history, sample)
        if (anchor != null)
          matched = [{ sample: anchor, difference: null, gap: null }]
      }
      const match = matchAnchor(anchor, matched.at(-1)?.sample, sample)
      if (match != null) matched.push(match)
      history.push(sample)
      if (history.length > RECURRENCE_LIMITS.history) history.shift()
      complete = matched.length >= RECURRENCE_LIMITS.matches + 1
      return {
        ...summary(sample),
        visible,
        adjacent,
        referenceDifference,
        referenceLimit: reference == null ? null : referenceLimit,
        anchor: anchor == null ? null : summary(anchor),
        recurrences: matched.slice(1).map(recurrenceSummary),
        historySize: history.length,
        expired,
        ready: complete
      }
    }
  }
}
