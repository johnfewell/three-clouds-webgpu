// Shaded-fraction receipt: SSIM sees shadow edges, not existence (a
// tenfold shadow loss moved it 0.9631 → 0.9625). Both sides render with the
// shadow OFF and count the pixels it darkens, valid only with flags read back
// off and the plate brightening on both sides (mail #635)
// Cite: ADR-011 Amendment 4 (A 85.12 % / B 85.32 %)

import { luminance } from './color'

/** on/off luminance ratio below which a pixel counts as shadowed */
export const SHADED_RATIO = 0.98
/** Pixels darker than this with the shadow OFF are not classifiable */
export const LUMINANCE_FLOOR = 1e-4
/** B's shaded fraction must be at least this share of A's */
export const SHADED_RATIO_FLOOR = 0.85
/**
 * Minimum shaded fraction on side A for the ratio to mean anything. The floor
 * is a MINIMUM, so two near-zero fractions divide to a large ratio that passes
 * it from above (ground-bounce-on: A 0.00 %, B 0.02 %, ratio 10.7, mail #673).
 * Below this the receipt reads "no shadow in frame" and fails. A case whose
 * pose does not see its shadow declares `shadedFractionReceipt.skip` instead.
 */
export const MIN_SIGNAL_FRACTION = 0.01

export interface ShadedFractionSide {
  /** Share of classifiable pixels the shadow darkens (on < 0.98 · off) */
  readonly fraction: number
  readonly meanOn: number
  readonly meanOff: number
  /** (meanOff − meanOn) / meanOff, which must be > 0 for the plate check */
  readonly rise: number
  /** Pixels bright enough with the shadow off to be classified */
  readonly classified: number
}

export interface ShadedFractionFlags {
  readonly A: readonly boolean[]
  readonly B: readonly boolean[] | null
}

/**
 * How the two sides' fractions are compared.
 *
 * - `ratio` (default): B.fraction / A.fraction must hold the floor. Correct
 *   wherever BOTH sides shade the same pixels from the same consumer.
 * - `b-only`: side A has no consumer for this case's shadow, so its fraction
 *   answers a different question and the ratio is not a comparison. Gate side
 *   B's own response instead.
 */
export type ShadedFractionCompare = 'ratio' | 'b-only'

export interface ShadedFractionReceipt {
  readonly A: ShadedFractionSide
  readonly B: ShadedFractionSide
  /**
   * B.fraction / A.fraction (0 when A has no shadow). Not a comparison
   * under `b-only`, where the two sides measure different quantities
   */
  readonly ratio: number
  /** What the probe's setter returned after writing the flags OFF */
  readonly flagsOff: ShadedFractionFlags
  /** What it returned after restoring them */
  readonly flagsRestored: ShadedFractionFlags
  readonly compare: ShadedFractionCompare
}

function extractLuminance(
  buf: Float32Array,
  width: number,
  height: number,
  channels: number
): Float32Array {
  const lum = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    lum[i] = luminance(
      buf[i * channels]!,
      buf[i * channels + 1]!,
      buf[i * channels + 2]!
    )
  }
  return lum
}

export function computeShadedFraction(
  bufOn: Float32Array,
  bufOff: Float32Array,
  width: number,
  height: number,
  channels = 4
): ShadedFractionSide {
  const on = extractLuminance(bufOn, width, height, channels)
  const off = extractLuminance(bufOff, width, height, channels)
  const n = width * height
  let classified = 0
  let shaded = 0
  let sumOn = 0
  let sumOff = 0
  for (let i = 0; i < n; i++) {
    sumOn += on[i]!
    sumOff += off[i]!
    if (off[i]! > LUMINANCE_FLOOR) {
      classified++
      if (on[i]! < SHADED_RATIO * off[i]!) shaded++
    }
  }
  const meanOn = n > 0 ? sumOn / n : 0
  const meanOff = n > 0 ? sumOff / n : 0
  return {
    fraction: classified > 0 ? shaded / classified : 0,
    meanOn,
    meanOff,
    rise: meanOff > LUMINANCE_FLOOR ? (meanOff - meanOn) / meanOff : 0,
    classified
  }
}

function allOff(flags: readonly boolean[] | null): boolean {
  return flags != null && flags.length > 0 && flags.every(f => f === false)
}

/**
 * The receipt's verdict. Empty means the receipt is valid AND passes, and each
 * string is a hard reason. The preconditions come first because a fraction
 * measured on a plate that still had shadows is not a fraction of anything.
 *
 * Under `b-only` the two preconditions move with the subject: side A is not
 * required to brighten, because it has no consumer to brighten from, and the
 * minimum-signal floor reads side B. Requiring A there would fail a correct
 * port on a case the reference cannot express.
 */
export function evaluateShadedFraction(
  receipt: ShadedFractionReceipt,
  floor = SHADED_RATIO_FLOOR
): string[] {
  const bOnly = receipt.compare === 'b-only'
  const reasons: string[] = []
  if (!allOff(receipt.flagsOff.A)) {
    reasons.push(
      'shaded-fraction receipt: side A flags did not read back all-off'
    )
  }
  if (!allOff(receipt.flagsOff.B)) {
    reasons.push(
      'shaded-fraction receipt: side B flags did not read back all-off'
    )
  }
  if (!bOnly && !(receipt.A.rise > 0)) {
    reasons.push(
      `shaded-fraction receipt: side A plate did not brighten with casters off (rise ${receipt.A.rise.toFixed(4)})`
    )
  }
  if (!(receipt.B.rise > 0)) {
    reasons.push(
      `shaded-fraction receipt: side B plate did not brighten with casters off (rise ${receipt.B.rise.toFixed(4)})`
    )
  }
  if (reasons.length > 0) return reasons
  const subject = bOnly ? receipt.B : receipt.A
  const subjectName = bOnly ? 'B' : 'A'
  if (!(subject.fraction >= MIN_SIGNAL_FRACTION)) {
    reasons.push(
      `shaded-fraction receipt: no shadow in frame — side ${subjectName} shades ${(subject.fraction * 100).toFixed(2)} % of the plate (< ${(MIN_SIGNAL_FRACTION * 100).toFixed(0)} %); the pose does not see its shadow (declare shadedFractionReceipt.skip if that is by design)`
    )
    return reasons
  }
  // A b-only receipt stops here: its `ratio` field is two different quantities
  // divided, and a ratio of them is a number without a meaning
  if (bOnly) return reasons
  if (receipt.ratio < floor) {
    reasons.push(
      `shadedFraction ratio ${receipt.ratio.toFixed(3)} < ${floor.toFixed(2)} (A ${(receipt.A.fraction * 100).toFixed(2)} %, B ${(receipt.B.fraction * 100).toFixed(2)} %)`
    )
  }
  return reasons
}

export function buildShadedFractionReceipt(
  A: ShadedFractionSide,
  B: ShadedFractionSide,
  flagsOff: ShadedFractionFlags,
  flagsRestored: ShadedFractionFlags,
  compare: ShadedFractionCompare = 'ratio'
): ShadedFractionReceipt {
  return {
    A,
    B,
    ratio: A.fraction > 0 ? B.fraction / A.fraction : 0,
    flagsOff,
    flagsRestored,
    compare
  }
}
