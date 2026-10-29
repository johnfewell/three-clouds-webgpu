import { decodePng } from '../flipFamily.mjs'
import { insist } from './proof.mjs'

export const LIMITS = Object.freeze({
  stableMean: 0.001,
  contributionMean: 0.002,
  contributionFraction: 0.01,
  restoreMean: 0.002,
  noiseMultiplier: 5,
  minimumPixels: 10000,
  minimumMean: 0.005,
  minimumRange: 0.01
})

export function decodeScreenshot(bytes, mask) {
  const image = decodePng(bytes)
  insist(image.width > 0 && image.height > 0, 'empty screenshot')
  insist(
    image.data.length === image.width * image.height * image.channels,
    'invalid decoded screenshot length'
  )
  return { ...image, mask }
}

function masked(image, horizontal, vertical) {
  const mask = image.mask
  return (
    mask != null &&
    horizontal >= mask.x - 2 &&
    horizontal <= mask.x + mask.width + 2 &&
    vertical >= mask.y - 2 &&
    vertical <= mask.y + mask.height + 2
  )
}

export function comparePixels(first, second = first) {
  insist(
    first.width === second.width && first.height === second.height,
    'unequal screenshot dimensions'
  )
  let samples = 0
  let sum = 0
  let difference = 0
  let changed = 0
  let minimum = Infinity
  let maximum = -Infinity
  for (let vertical = 0; vertical < first.height; vertical++) {
    for (let horizontal = 0; horizontal < first.width; horizontal++) {
      if (
        masked(first, horizontal, vertical) ||
        masked(second, horizontal, vertical)
      )
        continue
      const index = vertical * first.width + horizontal
      let pixelDifference = 0
      for (let channel = 0; channel < 3; channel++) {
        const value = first.data[index * first.channels + channel] / 255
        const other = second.data[index * second.channels + channel] / 255
        insist(
          Number.isFinite(value) && Number.isFinite(other),
          'non-finite pixel'
        )
        sum += value
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
        pixelDifference += Math.abs(value - other) / 3
      }
      difference += pixelDifference
      if (pixelDifference > 2 / 255) changed++
      samples++
    }
  }
  insist(samples >= LIMITS.minimumPixels, 'too few unmasked pixels')
  return {
    samples,
    mean: sum / (samples * 3),
    range: maximum - minimum,
    meanDifference: difference / samples,
    changedFraction: changed / samples
  }
}

export function assertVisible(image) {
  const metrics = comparePixels(image)
  insist(metrics.mean > LIMITS.minimumMean, 'blank screenshot')
  insist(metrics.range > LIMITS.minimumRange, 'flat screenshot')
  return metrics
}

// A caller may pass its own limits for a scene whose paused frame carries
// more residue than the recipes. The noise multiplier still guards the
// contribution against that residue
export function assertContribution(on, repeat, off, restored, limits = LIMITS) {
  for (const image of [on, repeat, off, restored]) assertVisible(image)
  const noise = comparePixels(on, repeat)
  const contribution = comparePixels(on, off)
  const restoration = comparePixels(on, restored)
  insist(
    noise.meanDifference <= limits.stableMean,
    'unstable on-state baseline'
  )
  insist(
    contribution.meanDifference >
      Math.max(
        limits.contributionMean,
        noise.meanDifference * limits.noiseMultiplier
      ) && contribution.changedFraction > limits.contributionFraction,
    'no cloud contribution beyond same-state noise'
  )
  insist(
    restoration.meanDifference <= limits.restoreMean,
    'cloud restoration differs'
  )
  return { noise, contribution, restoration }
}
