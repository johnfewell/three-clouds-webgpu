// SSIM structural attribution: a low score is either a large σd²
// (the port differs) or a small σA² + σB² + C2 (a near-empty frame). Reports
// both halves, bands pixels by signal variance vs C2, and recomputes at a
// reference L. Cite: ssim.ts, ADR-011 A2. v4: gated at reference L, bands and
// l/cs still at measured L, the regime they explain
// ```
//   SSIM = l · cs      l  = (2μAμB + C1) / (μA² + μB² + C1)
//                      cs = (2σAB + C2) / (σA² + σB² + C2)
//   1 − cs = σd² / (σA² + σB² + C2)      for d = A − B
// ```

import { gaussianBlur } from './blur'
import { luminance } from './color'
import { dynamicRange, REFERENCE_L } from './ssim'

const SIGMA = 1.5
const K1 = 0.01
const K2 = 0.03

// Band edges as multiples of C2: a window whose σA² sits below C2 is
// stabiliser-dominated. Cut on σA² alone (A sets the scale): banding on the sum
// would let B's own difference noise pick the band
const BAND_EDGES = [0.25, 1, 4] as const

export interface SsimBand {
  /** Upper band edge as a multiple of C2 on σA², null for the top band */
  readonly maxSignalVarianceOverC2: number | null
  readonly fraction: number
  readonly meanSsim: number
  readonly meanSigmaA: number
  readonly meanSigmaB: number
  readonly meanSigmaD: number
}

export interface SsimAttribution {
  /** The gated number: SSIM at referenceL. Identical to computeSSIM (v4). */
  readonly ssim: number
  /** SSIM at side A's percentile span: the v3 number, diagnostic since v4 */
  readonly ssimAtMeasuredL: number
  /** Side A's percentile luminance span, the L the diagnostic and bands use */
  readonly measuredL: number
  readonly meanLuminanceTerm: number
  readonly meanContrastStructureTerm: number
  /** Mean local std of the difference field: the numerator of 1 − cs */
  readonly sigmaD: number
  readonly sigmaA: number
  readonly sigmaB: number
  /** Equal to ssim since v4, kept so v3-era readers of this block still work */
  readonly ssimAtReferenceL: number
  readonly referenceL: number
  /**
   * Share of the measured-L deficit removed by raising L to referenceL:
   * (ssim − ssimAtMeasuredL) / (1 − ssimAtMeasuredL). Near 1 ⇒ the low
   * measured-L score describes the frame, not the port.
   */
  readonly stabiliserShareOfDeficit: number
  readonly bands: readonly SsimBand[]
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

interface LocalMoments {
  readonly muA: Float32Array
  readonly muB: Float32Array
  readonly varA: Float32Array
  readonly varB: Float32Array
  readonly covAB: Float32Array
  readonly varD: Float32Array
}

function localMoments(
  lumA: Float32Array,
  lumB: Float32Array,
  width: number,
  height: number
): LocalMoments {
  const n = width * height
  const a2 = new Float32Array(n)
  const b2 = new Float32Array(n)
  const ab = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    a2[i] = lumA[i]! * lumA[i]!
    b2[i] = lumB[i]! * lumB[i]!
    ab[i] = lumA[i]! * lumB[i]!
  }
  const muA = gaussianBlur(lumA, width, height, SIGMA)
  const muB = gaussianBlur(lumB, width, height, SIGMA)
  const mA2 = gaussianBlur(a2, width, height, SIGMA)
  const mB2 = gaussianBlur(b2, width, height, SIGMA)
  const mAB = gaussianBlur(ab, width, height, SIGMA)

  const varA = new Float32Array(n)
  const varB = new Float32Array(n)
  const covAB = new Float32Array(n)
  const varD = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // Clamped: the blur is separable and finite-precision, so a window over a
    // constant region can land a few ulp below zero
    varA[i] = Math.max(mA2[i]! - muA[i]! * muA[i]!, 0)
    varB[i] = Math.max(mB2[i]! - muB[i]! * muB[i]!, 0)
    covAB[i] = mAB[i]! - muA[i]! * muB[i]!
    varD[i] = Math.max(varA[i]! + varB[i]! - 2 * covAB[i]!, 0)
  }
  return { muA, muB, varA, varB, covAB, varD }
}

function meanSsimAt(m: LocalMoments, n: number, L: number): number {
  const C1 = (K1 * L) ** 2
  const C2 = (K2 * L) ** 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const muA2 = m.muA[i]! * m.muA[i]!
    const muB2 = m.muB[i]! * m.muB[i]!
    const num = (2 * m.muA[i]! * m.muB[i]! + C1) * (2 * m.covAB[i]! + C2)
    const den = (muA2 + muB2 + C1) * (m.varA[i]! + m.varB[i]! + C2)
    sum += num / den
  }
  return sum / n
}

export function computeSsimAttribution(
  bufA: Float32Array,
  bufB: Float32Array,
  width: number,
  height: number,
  channels = 4,
  referenceL: number = REFERENCE_L
): SsimAttribution {
  const n = width * height
  const lumA = extractLuminance(bufA, width, height, channels)
  const lumB = extractLuminance(bufB, width, height, channels)

  const measuredL = dynamicRange(lumA)
  const C1 = (K1 * measuredL) ** 2
  const C2 = (K2 * measuredL) ** 2
  const m = localMoments(lumA, lumB, width, height)

  let ssimSum = 0
  let lumSum = 0
  let csSum = 0
  let sigmaASum = 0
  let sigmaBSum = 0
  let sigmaDSum = 0

  const edges = [...BAND_EDGES.map(e => e * C2), Number.POSITIVE_INFINITY]
  const bandCount = new Float64Array(edges.length)
  const bandSsim = new Float64Array(edges.length)
  const bandSigA = new Float64Array(edges.length)
  const bandSigB = new Float64Array(edges.length)
  const bandSigD = new Float64Array(edges.length)

  for (let i = 0; i < n; i++) {
    const muA2 = m.muA[i]! * m.muA[i]!
    const muB2 = m.muB[i]! * m.muB[i]!
    const l = (2 * m.muA[i]! * m.muB[i]! + C1) / (muA2 + muB2 + C1)
    const cs = (2 * m.covAB[i]! + C2) / (m.varA[i]! + m.varB[i]! + C2)
    const s = l * cs

    ssimSum += s
    lumSum += l
    csSum += cs
    const sigA = Math.sqrt(m.varA[i]!)
    const sigB = Math.sqrt(m.varB[i]!)
    const sigD = Math.sqrt(m.varD[i]!)
    sigmaASum += sigA
    sigmaBSum += sigB
    sigmaDSum += sigD

    let band = 0
    while (m.varA[i]! >= edges[band]!) band++
    bandCount[band]! += 1
    bandSsim[band]! += s
    bandSigA[band]! += sigA
    bandSigB[band]! += sigB
    bandSigD[band]! += sigD
  }

  const ssimAtMeasuredL = ssimSum / n
  const ssimAtReferenceL = meanSsimAt(m, n, referenceL)
  const ssim = ssimAtReferenceL
  const deficit = 1 - ssimAtMeasuredL

  const bands: SsimBand[] = edges.map((edge, b) => {
    const c = bandCount[b]!
    return {
      maxSignalVarianceOverC2: Number.isFinite(edge) ? BAND_EDGES[b]! : null,
      fraction: c / n,
      meanSsim: c > 0 ? bandSsim[b]! / c : 0,
      meanSigmaA: c > 0 ? bandSigA[b]! / c : 0,
      meanSigmaB: c > 0 ? bandSigB[b]! / c : 0,
      meanSigmaD: c > 0 ? bandSigD[b]! / c : 0
    }
  })

  return {
    ssim,
    ssimAtMeasuredL,
    measuredL,
    meanLuminanceTerm: lumSum / n,
    meanContrastStructureTerm: csSum / n,
    sigmaD: sigmaDSum / n,
    sigmaA: sigmaASum / n,
    sigmaB: sigmaBSum / n,
    ssimAtReferenceL,
    referenceL,
    stabiliserShareOfDeficit:
      deficit > 0 ? (ssimAtReferenceL - ssimAtMeasuredL) / deficit : 0,
    bands
  }
}
