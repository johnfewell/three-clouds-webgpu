import { DataUtils } from 'three'

export interface PixelReadback {
  width: number
  height: number
  data: ArrayLike<number>
}

export interface ScalarReadback {
  width: number
  height: number
  data: ArrayLike<number>
}

export interface ShadowRayExtents {
  extent: readonly ScalarReadback[]
  ulpAllowance: readonly ScalarReadback[]
}

export interface AtlasContractResult {
  finite: boolean
  sampledTexels: number
  noSampleTexels: number
  fourChannelTexels: number
  rayExtentFieldValid: boolean
  noSampleRayExtentRoundedDifferences: number
  noSampleRayExtentOutOfTolerance: number
  maxNoSampleRayExtentUlpDistance: number
  maxNoSampleRayExtentUlpAllowance: number
  maxNoSampleRayExtentError: number
  noSampleRayExtentWithinF32Resolution: boolean
  noSampleZeroChannelsExact: boolean
  frontDepthWithinRange: boolean
  layerCountMatches: boolean
}

export interface ReceiverShadowResult {
  pixels: number
  shadedFraction: number
  shadowedMean: number
  unshadowedMean: number
  darkening: number
  ratio: number
}

export interface MotionVector {
  dx: number
  dy: number
  score: number
}

export type NeutralisationFloorVerdict =
  'neutralised' | 'real-difference' | 'inconclusive' | 'invalid'

export interface TemporalContractResult {
  earlyDelta: number
  lateDelta: number
}

export interface PassCounts {
  atlas: number
  march: number
  shadowLength: number
}

export type ShadowKnobValue = boolean | number | string | [number, number]
export type ShadowKnobSnapshot = Record<string, ShadowKnobValue>

const LUMA = [0.2126, 0.7152, 0.0722] as const

// Both inputs are fp16-representable readbacks, so comparing codes makes the
// allowance scale with the value's exponent. Negatives need no special case, as
// fp16 is sign-magnitude and opposite signs are thousands of codes apart
function float16CodeDistance(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return Number.POSITIVE_INFINITY
  }
  return Math.abs(DataUtils.toHalfFloat(a) - DataUtils.toHalfFloat(b))
}

export function pixelLuminance(data: ArrayLike<number>, pixel: number): number {
  const offset = pixel * 4
  return (
    LUMA[0] * data[offset]! +
    LUMA[1] * data[offset + 1]! +
    LUMA[2] * data[offset + 2]!
  )
}

export function meanLuminance(data: ArrayLike<number>): number {
  if (data.length === 0 || data.length % 4 !== 0) return Number.NaN
  let sum = 0
  for (let pixel = 0; pixel < data.length / 4; pixel++) {
    sum += pixelLuminance(data, pixel)
  }
  return sum / (data.length / 4)
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i]! - b[i]!)
    if (delta > max) max = delta
  }
  return max
}

export function meanAbsDiff(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

export function evaluateAtlasContract(
  layers: readonly PixelReadback[],
  rayExtents: ShadowRayExtents,
  expectedLayers: number,
  maxShadowRayExtentUnit: number,
  epsilon = 1e-3
): AtlasContractResult {
  const { extent: rayExtentLayers, ulpAllowance: ulpAllowanceLayers } =
    rayExtents
  let finite = layers.length > 0
  let sampledTexels = 0
  let noSampleTexels = 0
  let fourChannelTexels = 0
  let rayExtentFieldValid =
    layers.length > 0 &&
    rayExtentLayers.length === layers.length &&
    ulpAllowanceLayers.length === layers.length
  let noSampleRayExtentRoundedDifferences = 0
  let noSampleRayExtentOutOfTolerance = 0
  let maxNoSampleRayExtentUlpDistance = 0
  let maxNoSampleRayExtentUlpAllowance = 0
  let maxNoSampleRayExtentError = 0
  let noSampleRayExtentWithinF32Resolution = true
  let noSampleZeroChannelsExact = true
  let frontDepthWithinRange = true

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex]!
    const rayExtent = rayExtentLayers[layerIndex]
    const allowance = ulpAllowanceLayers[layerIndex]
    finite &&=
      layer.data.length === layer.width * layer.height * 4 &&
      Array.from(layer.data).every(Number.isFinite)
    const extentValid =
      rayExtent != null &&
      rayExtent.width === layer.width &&
      rayExtent.height === layer.height &&
      rayExtent.data.length === layer.width * layer.height &&
      Array.from(rayExtent.data).every(Number.isFinite)
    // A malformed allowance must not narrow the bar, so it invalidates the
    // field rather than reading as a zero-width one
    const allowanceValid =
      extentValid &&
      allowance != null &&
      allowance.width === layer.width &&
      allowance.height === layer.height &&
      allowance.data.length === layer.width * layer.height &&
      Array.from(allowance.data).every(Number.isFinite)
    rayExtentFieldValid &&= allowanceValid
    for (let i = 0; i < layer.data.length; i += 4) {
      const r = layer.data[i]!
      const g = layer.data[i + 1]!
      const b = layer.data[i + 2]!
      const a = layer.data[i + 3]!
      const expectedRayExtent = rayExtent?.data[i / 4]
      const sampled =
        Math.abs(g) > epsilon || Math.abs(b) > epsilon || Math.abs(a) > epsilon
      if (sampled) {
        sampledTexels++
        if (r > epsilon && g > epsilon && b > epsilon && a > epsilon) {
          fourChannelTexels++
        }
      } else {
        noSampleTexels++
        const ulpDistance =
          allowanceValid && expectedRayExtent != null
            ? float16CodeDistance(r, expectedRayExtent)
            : Number.POSITIVE_INFINITY
        // The twin's own f32 resolution at THIS texel: one code wherever the
        // arithmetic is well conditioned, wider only where the extent is a
        // difference of nearly equal operands
        const permitted = allowanceValid ? allowance.data[i / 4]! : 0
        const rayExtentMatches = ulpDistance <= permitted
        const error =
          expectedRayExtent != null && Number.isFinite(expectedRayExtent)
            ? Math.abs(r - expectedRayExtent)
            : Number.POSITIVE_INFINITY
        maxNoSampleRayExtentError = Math.max(maxNoSampleRayExtentError, error)
        maxNoSampleRayExtentUlpDistance = Math.max(
          maxNoSampleRayExtentUlpDistance,
          ulpDistance
        )
        maxNoSampleRayExtentUlpAllowance = Math.max(
          maxNoSampleRayExtentUlpAllowance,
          permitted
        )
        if (ulpDistance !== 0) noSampleRayExtentRoundedDifferences++
        if (!rayExtentMatches) noSampleRayExtentOutOfTolerance++
        noSampleRayExtentWithinF32Resolution &&= rayExtentMatches
        noSampleZeroChannelsExact &&= g === 0 && b === 0 && a === 0
      }
      // shadow.frag:121–123 caps frontDepth at the texel's own rayFar - rayNear,
      // so it lies between zero and that extent, which is NEGATIVE where rayNear
      // exceeds the 1e6 fallback. clouds.maxRayDistance never bounds this
      frontDepthWithinRange &&=
        r >= Math.min(0, expectedRayExtent ?? 0) - epsilon &&
        r <= Math.max(0, expectedRayExtent ?? 0) + epsilon &&
        r <= maxShadowRayExtentUnit + epsilon
    }
  }

  return {
    finite,
    sampledTexels,
    noSampleTexels,
    fourChannelTexels,
    rayExtentFieldValid,
    noSampleRayExtentRoundedDifferences,
    noSampleRayExtentOutOfTolerance,
    maxNoSampleRayExtentUlpDistance,
    maxNoSampleRayExtentUlpAllowance,
    maxNoSampleRayExtentError,
    noSampleRayExtentWithinF32Resolution,
    noSampleZeroChannelsExact,
    frontDepthWithinRange,
    layerCountMatches: layers.length === expectedLayers
  }
}

export function atlasContractPasses(result: AtlasContractResult): boolean {
  return (
    result.finite &&
    result.sampledTexels > 0 &&
    result.noSampleTexels > 0 &&
    result.fourChannelTexels > 0 &&
    result.rayExtentFieldValid &&
    result.noSampleRayExtentWithinF32Resolution &&
    result.noSampleZeroChannelsExact &&
    result.frontDepthWithinRange &&
    result.layerCountMatches
  )
}

export function samplerTailContractPasses(result: {
  inCloud: number
  ground: number
}): boolean {
  return result.inCloud === 3 && result.ground === 2
}

export function receiverMask(
  visible: ArrayLike<number>,
  hidden: ArrayLike<number>,
  threshold = 1e-4
): number[] {
  if (visible.length !== hidden.length || visible.length === 0) return []
  const mask: number[] = []
  for (let pixel = 0; pixel < visible.length / 4; pixel++) {
    const offset = pixel * 4
    const difference = Math.max(
      Math.abs(visible[offset]! - hidden[offset]!),
      Math.abs(visible[offset + 1]! - hidden[offset + 1]!),
      Math.abs(visible[offset + 2]! - hidden[offset + 2]!)
    )
    if (difference > threshold) mask.push(pixel)
  }
  return mask
}

export function receiverMaskWithControls(
  visibleFirst: ArrayLike<number>,
  visibleSecond: ArrayLike<number>,
  hiddenFirst: ArrayLike<number>,
  hiddenSecond: ArrayLike<number>,
  margin = 1e-4
): number[] {
  const reads = [visibleFirst, visibleSecond, hiddenFirst, hiddenSecond]
  if (
    visibleFirst.length === 0 ||
    visibleFirst.length % 4 !== 0 ||
    reads.some(read => read.length !== visibleFirst.length)
  ) {
    return []
  }

  const mask: number[] = []
  const rgbDifference = (
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    offset: number
  ): number =>
    Math.max(
      Math.abs(a[offset]! - b[offset]!),
      Math.abs(a[offset + 1]! - b[offset + 1]!),
      Math.abs(a[offset + 2]! - b[offset + 2]!)
    )

  for (let pixel = 0; pixel < visibleFirst.length / 4; pixel++) {
    const offset = pixel * 4
    const withinVariation = Math.max(
      rgbDifference(visibleFirst, visibleSecond, offset),
      rgbDifference(hiddenFirst, hiddenSecond, offset)
    )
    const visibilitySignal = Math.min(
      rgbDifference(visibleFirst, hiddenFirst, offset),
      rgbDifference(visibleFirst, hiddenSecond, offset),
      rgbDifference(visibleSecond, hiddenFirst, offset),
      rgbDifference(visibleSecond, hiddenSecond, offset)
    )
    if (visibilitySignal > withinVariation + margin) mask.push(pixel)
  }
  return mask
}

export function receiverMaskDomainPasses(
  pixels: number,
  referencePixels: number,
  subjectPixels: number,
  maximumCoverage = 0.1,
  minimumPixels = 64
): boolean {
  if (
    !Number.isInteger(pixels) ||
    !Number.isInteger(referencePixels) ||
    !Number.isInteger(subjectPixels) ||
    pixels < minimumPixels ||
    referencePixels <= 0 ||
    subjectPixels !== referencePixels
  ) {
    return false
  }
  return pixels / referencePixels <= maximumCoverage
}

export function measureReceiverShadow(
  shadowed: ArrayLike<number>,
  unshadowed: ArrayLike<number>,
  mask: readonly number[],
  pixelThreshold = 1e-4
): ReceiverShadowResult {
  if (mask.length === 0) {
    return {
      pixels: 0,
      shadedFraction: 0,
      shadowedMean: Number.NaN,
      unshadowedMean: Number.NaN,
      darkening: Number.NaN,
      ratio: Number.NaN
    }
  }
  let shaded = 0
  let shadowedMean = 0
  let unshadowedMean = 0
  for (const pixel of mask) {
    const on = pixelLuminance(shadowed, pixel)
    const off = pixelLuminance(unshadowed, pixel)
    shadowedMean += on
    unshadowedMean += off
    if (off - on > pixelThreshold) shaded++
  }
  shadowedMean /= mask.length
  unshadowedMean /= mask.length
  return {
    pixels: mask.length,
    shadedFraction: shaded / mask.length,
    shadowedMean,
    unshadowedMean,
    darkening: unshadowedMean - shadowedMean,
    ratio: shadowedMean / unshadowedMean
  }
}

export function receiverShadowPasses(
  result: ReceiverShadowResult,
  minimumPixels = 64
): boolean {
  return (
    result.pixels >= minimumPixels &&
    result.shadedFraction >= 0.01 &&
    result.darkening > 1e-4 &&
    Number.isFinite(result.ratio) &&
    result.ratio > 0 &&
    result.ratio < 1
  )
}

export function receiverRatiosAgree(
  a: ReceiverShadowResult,
  b: ReceiverShadowResult,
  relativeTolerance = 0.1
): boolean {
  const scale = Math.max(Math.abs(a.ratio), Math.abs(b.ratio))
  return (
    scale > 0 &&
    Number.isFinite(scale) &&
    Math.abs(a.ratio - b.ratio) / scale <= relativeTolerance
  )
}

export function plainReceiverContractPasses(
  plain: ReceiverShadowResult,
  cloudShadowed: ReceiverShadowResult,
  minimumPixels = 64
): boolean {
  return (
    receiverShadowPasses(cloudShadowed) &&
    plain.pixels >= minimumPixels &&
    Number.isFinite(plain.shadowedMean) &&
    Number.isFinite(plain.unshadowedMean) &&
    Number.isFinite(plain.darkening) &&
    Math.abs(plain.darkening) <= Math.max(1e-4, cloudShadowed.darkening * 0.1)
  )
}

export function motionContractPasses(
  reference: MotionVector | null,
  subject: MotionVector | null,
  minimumPixels = 2
): boolean {
  if (reference == null || subject == null) return false
  const magnitudeA = Math.hypot(reference.dx, reference.dy)
  const magnitudeB = Math.hypot(subject.dx, subject.dy)
  const denominator = magnitudeA * magnitudeB
  const cosine =
    denominator > 0
      ? (reference.dx * subject.dx + reference.dy * subject.dy) / denominator
      : Number.NEGATIVE_INFINITY
  return (
    reference.score >= 0.1 &&
    subject.score >= 0.1 &&
    magnitudeA >= minimumPixels &&
    magnitudeB >= minimumPixels &&
    cosine >= 0.5
  )
}

// the attachment carries the reference's shadowed interval, the LAST
// x of a geometry ray, so x + y = D (runtime.glsl:318-322, Eq. 17 and 18).
// Pixels where the old encoding would fail count as `discriminating`
export interface ShadowLengthSurfaceEndResult {
  finite: boolean
  geometryPixels: number
  skyPixels: number
  shadowedPixels: number
  // Geometry pixels outside max(absolute, relative * D) of x + y = D, the
  // worst relative miss (reporting only), and the worst sky y
  violations: number
  maxGeometryRelError: number
  maxSkyStart: number
  // Geometry pixels where the old encoding (y = oldNear) misses D
  discriminating: number
}

export function evaluateShadowLengthSurfaceEnd(
  pixels: PixelReadback,
  // Per sampled pixel: the expected surface distance in the attachment's unit,
  // or null for a sky pixel
  samples: ReadonlyArray<{ col: number; row: number; distance: number | null }>,
  oldNear: number,
  tolerance: { relative: number; absolute: number },
  epsilon = 1e-4
): ShadowLengthSurfaceEndResult {
  let finite = pixels.data.length === pixels.width * pixels.height * 4
  let geometryPixels = 0
  let skyPixels = 0
  let shadowedPixels = 0
  let violations = 0
  let maxGeometryRelError = 0
  let maxSkyStart = 0
  let discriminating = 0
  for (const { col, row, distance } of samples) {
    const i = (row * pixels.width + col) * 4
    const x = pixels.data[i]!
    const y = pixels.data[i + 1]!
    finite &&= Number.isFinite(x) && Number.isFinite(y)
    if (x > epsilon) shadowedPixels++
    if (distance == null) {
      skyPixels++
      maxSkyStart = Math.max(maxSkyStart, Math.abs(y))
      continue
    }
    geometryPixels++
    const allowed = Math.max(tolerance.absolute, tolerance.relative * distance)
    maxGeometryRelError = Math.max(
      maxGeometryRelError,
      Math.abs(x + y - distance) / Math.max(distance, 1e-9)
    )
    if (Math.abs(x + y - distance) > allowed) violations++
    if (Math.abs(x + oldNear - distance) > allowed) discriminating++
  }
  return {
    finite,
    geometryPixels,
    skyPixels,
    shadowedPixels,
    violations,
    maxGeometryRelError,
    maxSkyStart,
    discriminating
  }
}

export function shadowLengthSurfaceEndPasses(
  result: ShadowLengthSurfaceEndResult,
  skyTolerance = 1e-4
): boolean {
  return (
    result.finite &&
    result.geometryPixels > 0 &&
    result.shadowedPixels > 0 &&
    result.discriminating > 0 &&
    result.violations === 0 &&
    result.maxSkyStart <= skyTolerance
  )
}

export function shaftsEffectPasses(
  shaftsOn: ArrayLike<number>,
  shaftsOff: ArrayLike<number>,
  minimumDelta: number
): boolean {
  const delta = meanAbsDiff(shaftsOn, shaftsOff)
  return Number.isFinite(delta) && delta > minimumDelta
}

export function shaftsDarkeningPasses(
  shaftsOn: ArrayLike<number>,
  shaftsOff: ArrayLike<number>,
  minimumDarkening: number
): boolean {
  const on = meanLuminance(shaftsOn)
  const off = meanLuminance(shaftsOff)
  return (
    Number.isFinite(on) && Number.isFinite(off) && off - on > minimumDarkening
  )
}

function knobValuesEqual(a: ShadowKnobValue, b: ShadowKnobValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => value === b[index])
    )
  }
  return a === b
}

export function shadowKnobContractPasses(input: {
  expected: ShadowKnobSnapshot
  A: object
  B: object | null
  targetCounts: readonly number[]
  errorCount: number
}): boolean {
  if (input.B == null || input.targetCounts.length < 3) return false
  const a = input.A as ShadowKnobSnapshot
  const b = input.B as ShadowKnobSnapshot
  const entries = Object.entries(input.expected)
  const knobsMatch = entries.every(
    ([key, expected]) =>
      a[key] != null &&
      b[key] != null &&
      knobValuesEqual(a[key], expected) &&
      knobValuesEqual(b[key], expected)
  )
  return (
    knobsMatch &&
    input.errorCount === 0 &&
    input.targetCounts[0]! > 0 &&
    input.targetCounts.every(
      count => Number.isInteger(count) && count === input.targetCounts[0]
    )
  )
}

// The temporal resolve accumulates, so late/early change must fall below 0.5,
// which no history-free resolve can (reference 0.0995, port 0.19). It replaced
// an absolute bar the reference itself missed 8,334x
export function temporalContractPasses(
  result: TemporalContractResult,
  maximumDecay: number
): boolean {
  return (
    Number.isFinite(result.earlyDelta) &&
    Number.isFinite(result.lateDelta) &&
    result.earlyDelta > 0 &&
    result.lateDelta >= 0 &&
    result.lateDelta < result.earlyDelta &&
    result.lateDelta / result.earlyDelta <= maximumDecay
  )
}

export function layerMaskContractPasses(
  enabled: AtlasContractResult,
  disabled: AtlasContractResult
): boolean {
  return (
    enabled.finite &&
    enabled.sampledTexels > 0 &&
    enabled.noSampleTexels > 0 &&
    enabled.rayExtentFieldValid &&
    enabled.noSampleRayExtentWithinF32Resolution &&
    enabled.noSampleZeroChannelsExact &&
    enabled.frontDepthWithinRange &&
    enabled.layerCountMatches &&
    disabled.finite &&
    disabled.sampledTexels === 0 &&
    disabled.noSampleTexels > 0 &&
    disabled.rayExtentFieldValid &&
    disabled.noSampleRayExtentWithinF32Resolution &&
    disabled.noSampleZeroChannelsExact &&
    disabled.frontDepthWithinRange &&
    disabled.layerCountMatches
  )
}

export function neutralisationContractPasses(input: {
  disabledShadowDelta: number
  disabledShaftsDelta: number
  reenabledShadowDelta: number
  disabledFrameMs: number | null
  passes: PassCounts
  equalityTolerance: number
  effectFloor: number
}): boolean {
  return (
    Number.isFinite(input.disabledShadowDelta) &&
    Number.isFinite(input.disabledShaftsDelta) &&
    Number.isFinite(input.reenabledShadowDelta) &&
    input.disabledFrameMs != null &&
    Number.isFinite(input.disabledFrameMs) &&
    input.disabledFrameMs >= 0 &&
    input.disabledShadowDelta >= 0 &&
    input.disabledShaftsDelta >= 0 &&
    input.reenabledShadowDelta >= 0 &&
    input.disabledShadowDelta <= input.equalityTolerance &&
    input.disabledShaftsDelta <= input.equalityTolerance &&
    input.reenabledShadowDelta > input.effectFloor &&
    input.passes.atlas === 0 &&
    input.passes.march === 0 &&
    input.passes.shadowLength === 0
  )
}

export function neutralisationFloorVerdict(
  input: {
    withinShadowOff: readonly number[]
    withinShadowOn: readonly number[]
    crossState: readonly number[]
  },
  requiredSamples = 10
): NeutralisationFloorVerdict {
  const populations = [
    input.withinShadowOff,
    input.withinShadowOn,
    input.crossState
  ]
  if (
    populations.some(
      values =>
        values.length < requiredSamples ||
        values.some(value => !Number.isFinite(value) || value < 0)
    )
  ) {
    return 'invalid'
  }

  const withinFloor = Math.max(
    ...input.withinShadowOff,
    ...input.withinShadowOn
  )
  const crossMin = Math.min(...input.crossState)
  const crossMax = Math.max(...input.crossState)
  if (crossMax <= withinFloor) return 'neutralised'
  if (crossMin > withinFloor) return 'real-difference'
  return 'inconclusive'
}

export function deltasWithinMeasuredFloor(
  deltas: readonly number[],
  measuredFloor: number
): boolean {
  return (
    deltas.length > 0 &&
    Number.isFinite(measuredFloor) &&
    measuredFloor >= 0 &&
    deltas.every(
      delta => Number.isFinite(delta) && delta >= 0 && delta <= measuredFloor
    )
  )
}
