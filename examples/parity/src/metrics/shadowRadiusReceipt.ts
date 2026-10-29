// Step 1, the site-2 PCF radius receipt: the distribution of the
// per-pixel radius the port hands sampleCloudShadowOpticalDepth, where r1sp
// only forced radius 3. `armedFraction` is the share at or above the port's
// `radius < 0.1` early-out (:131). R is the radius, G validity: sky pixels
// read radius 0 too, so without G they would count as "not armed"

/**
 * src/shadow/sampleCloudShadowOpticalDepth.ts:131: below this the port point
 * samples. The REFERENCE has no such early-out (three-atmosphere shared.js:284
 * runs the Vogel loop unconditionally). That divergence is its own task, and
 * is why this receipt reads the port's threshold rather than a shared one.
 */
export const SITE2_PCF_ARM_THRESHOLD = 0.1

/**
 * src/shadow/shadowRadius.ts DEFAULT_SHADOW_RADIUS: the remap's upper bound,
 * i.e. the largest radius the law can return. Quoted so `atCeilingFraction`
 * means something without the reader going and looking it up.
 */
export const SHADOW_RADIUS_MAX = 3

export interface ShadowRadiusSummary {
  /** Pixels in the lane, valid or not */
  readonly sampled: number
  /** Pixels where the site-2 consumer runs (G != 0). The stats' denominator. */
  readonly classified: number
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  /** Fraction of `classified` at or above the port's early-out threshold */
  readonly armedFraction: number
  /** Fraction of `classified` pinned at the remap's ceiling */
  readonly atCeilingFraction: number
}

/**
 * Summarise a radius lane. Returns null for a lane with NO consuming pixels,
 * since an empty set does not get a confident zero.
 * `evaluateShadowRadiusReceipt` turns that null into a stated reason.
 */
export function summariseShadowRadius(
  lane: ArrayLike<number>,
  stride = 4
): ShadowRadiusSummary | null {
  const sampled = Math.floor(lane.length / stride)
  if (stride < 2) {
    // The validity channel is not optional: without G this function cannot tell
    // a far-plane pixel from a sub-band receiver, and would silently answer the
    // wrong question. Refusing beats guessing.
    throw new Error(`shadow radius lane needs stride >= 2, got ${stride}`)
  }
  const valid = new Float64Array(sampled)
  let n = 0
  for (let i = 0; i < sampled; i++) {
    // G is the validity flag written by the lane node, not a threshold on R:
    // radius 0 is a legitimate reading on a receiver with a sub-band footprint
    const g = lane[i * stride + 1]
    const r = lane[i * stride]
    if (g === undefined || r === undefined) {
      throw new Error(`shadow radius lane truncated at pixel ${i}`)
    }
    if (g !== 0) valid[n++] = r
  }
  if (n === 0) return null

  // Float64Array.sort is numeric by default (unlike Array.sort, which would
  // order 10 before 2 as strings)
  const s = valid.slice(0, n).sort()
  const idx = (i: number): number => {
    const v = s[i]
    // n >= 1 and every caller clamps, so this cannot fire. But `?? 0` here
    // would turn an indexing bug into a silent radius of zero, the one reading
    // this whole receipt exists to prevent
    if (v === undefined) throw new Error(`radius index ${i} out of ${n}`)
    return v
  }
  const at = (q: number): number =>
    idx(Math.min(n - 1, Math.floor(q * (n - 1))))
  let armed = 0
  let ceiling = 0
  for (let i = 0; i < n; i++) {
    const v = idx(i)
    if (v >= SITE2_PCF_ARM_THRESHOLD) armed++
    if (v >= SHADOW_RADIUS_MAX) ceiling++
  }
  return {
    sampled,
    classified: n,
    min: idx(0),
    median: at(0.5),
    p95: at(0.95),
    max: idx(n - 1),
    armedFraction: armed / n,
    atCeilingFraction: ceiling / n
  }
}

export interface ShadowRadiusReceiptInput {
  /** The summary, or null when the lane produced no consuming pixels */
  readonly summary: ShadowRadiusSummary | null
  /** True when the probe exposed no radius lane at all */
  readonly laneAbsent: boolean
  /** The case's effective `shadow` flag: no shadow, no site-2 consumer */
  readonly shadow: boolean
  /**
   * The case's lighting mode. 'lights' routes the ground shadow through
   * ParityShadowedLightNode instead of the aerial node, so the lane this
   * receipt reads is not the path that case takes (only case 35 does this).
   */
  readonly lighting: 'post' | 'lights'
  /** A case may declare the receipt inapplicable, with the reason */
  readonly skip?: string | null
  /**
   * pixels the lane actually carried, and pixels the frame has.
   *
   * The first run reported `armed=0.00% classified=1/1`: a 1x1 lane, a
   * confident zero over ONE pixel that passed the empty-set check. A lane that
   * is not frame-sized is a broken instrument and must refuse, not average.
   * Null on either is refused too: an unverifiable size is not a verified one.
   */
  readonly lanePixels?: number | null
  readonly framePixels?: number | null
}

/**
 * Reasons the receipt could not be believed. EMPTY means a usable receipt.
 *
 * This REFUSES, loudly and with a reason, when the lane is absent on a case
 * that should have one. The cloud-mask block beside it swallows its absence
 * (`catch { cloudMaskB64 = null }`), which let "site 2's radius is unmeasured"
 * survive two rulings. A missing instrument must never read as a zero.
 */
export function evaluateShadowRadiusReceipt(
  input: ShadowRadiusReceiptInput
): string[] {
  const reasons: string[] = []
  if (input.skip != null && input.skip !== '') {
    return [`shadow-radius receipt declared not applicable — ${input.skip}`]
  }
  if (!input.shadow) {
    // Not a refusal: with shadow off there is no site-2 consumer to measure
    return []
  }
  if (input.lighting === 'lights') {
    return [
      "shadow-radius receipt not applicable — lighting:'lights' routes the " +
        'ground shadow through the light node, not the aerial lane this reads'
    ]
  }
  if (input.laneAbsent) {
    reasons.push(
      'shadow-radius receipt REFUSED: the side-B radius lane is absent on a ' +
        'shadow case. The site-2 PCF radius is therefore UNMEASURED on this ' +
        'case — do not read a missing lane as radius 0, and do not quote ' +
        'a FORCED radius of 3 as evidence of what the computed radius is ' +
        'here.'
    )
    return reasons
  }
  // BEFORE the vacuity check, because a 1x1 lane can report classified = 1 and
  // sail past it. Order matters: a wrong-sized lane's emptiness is meaningless.
  const lane = input.lanePixels
  const frame = input.framePixels
  if (lane == null || frame == null) {
    reasons.push(
      'shadow-radius receipt REFUSED: the lane size could not be checked ' +
        'against the frame size. An unverifiable lane is not a verified one.'
    )
    return reasons
  }
  if (lane !== frame) {
    reasons.push(
      `shadow-radius receipt REFUSED: the lane carried ${lane} pixels and the ` +
        `frame has ${frame}. A lane that is not frame-sized is a BROKEN ` +
        'INSTRUMENT, not a small sample — do not read its armedFraction as a ' +
        'property of the case. (The first run of this receipt reported ' +
        'armed=0.00% over classified=1/1, from an RT left at its 1x1 ' +
        'construction size.)'
    )
    return reasons
  }
  if (input.summary == null) {
    reasons.push(
      'shadow-radius receipt VACUOUS: the lane is present but no pixel runs ' +
        'the site-2 consumer (classified = 0), so min/median/max would ' +
        'summarise an empty set. Nothing is claimed about this case.'
    )
    return reasons
  }
  return reasons
}

/** The one-line receipt for the capture log */
export function formatShadowRadiusReceipt(
  summary: ShadowRadiusSummary
): string {
  return (
    `min=${summary.min.toFixed(4)} median=${summary.median.toFixed(4)} ` +
    `p95=${summary.p95.toFixed(4)} max=${summary.max.toFixed(4)} ` +
    `armed=${(summary.armedFraction * 100).toFixed(2)}% ` +
    `ceiling=${(summary.atCeilingFraction * 100).toFixed(2)}% ` +
    `classified=${summary.classified}/${summary.sampled}`
  )
}
