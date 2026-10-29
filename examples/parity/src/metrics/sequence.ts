// Sequence metrics for multi-frame captures: flicker and ghosting
// Pure functions: work in Node (vitest) and browser (capture script)

import { deltaE2000, linearRgbToLab } from './color'

export interface FlickerResult {
  mean: number
  max: number
  perFrame: number[]
}

export interface GhostingResult {
  deMean: number
  deP95: number
}

export interface MotionVectorResult {
  dx: number
  dy: number
  score: number
}

export interface MotionDirectionResult {
  aligned: boolean
  comparable: boolean
  cosine: number | null
}

const MOTION_GRID_WIDTH = 160
const MOTION_MAX_SHIFT = 16
const MOTION_MIN_SCORE = 0.1
const MOTION_MIN_DISTANCE = 2

function meanRegionLuminance(
  buffer: Float32Array,
  width: number,
  channels: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number
): number {
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels
      sum +=
        0.2126 * buffer[i]! + 0.7152 * buffer[i + 1]! + 0.0722 * buffer[i + 2]!
      count++
    }
  }
  return sum / count
}

function buildMotionField(
  buffer: Float32Array,
  width: number,
  height: number,
  channels: number
): { data: Float32Array; width: number; height: number } {
  const fieldWidth = Math.min(width, MOTION_GRID_WIDTH)
  const fieldHeight = Math.max(
    2,
    Math.min(height, Math.round((height * fieldWidth) / width))
  )
  const luma = new Float32Array(fieldWidth * fieldHeight)

  for (let y = 0; y < fieldHeight; y++) {
    const sourceY0 = Math.floor((y * height) / fieldHeight)
    const sourceY1 = Math.max(
      sourceY0 + 1,
      Math.floor(((y + 1) * height) / fieldHeight)
    )
    for (let x = 0; x < fieldWidth; x++) {
      const sourceX0 = Math.floor((x * width) / fieldWidth)
      const sourceX1 = Math.max(
        sourceX0 + 1,
        Math.floor(((x + 1) * width) / fieldWidth)
      )
      luma[y * fieldWidth + x] = meanRegionLuminance(
        buffer,
        width,
        channels,
        sourceX0,
        sourceX1,
        sourceY0,
        sourceY1
      )
    }
  }

  const edges = new Float32Array(luma.length)
  for (let y = 1; y < fieldHeight - 1; y++) {
    for (let x = 1; x < fieldWidth - 1; x++) {
      const i = y * fieldWidth + x
      edges[i] =
        Math.abs(luma[i + 1]! - luma[i - 1]!) +
        Math.abs(luma[i + fieldWidth]! - luma[i - fieldWidth]!)
    }
  }
  return { data: edges, width: fieldWidth, height: fieldHeight }
}

function correlationAtShift(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number
): number {
  const x0 = Math.max(0, -dx)
  const x1 = Math.min(width, width - dx)
  const y0 = Math.max(0, -dy)
  const y1 = Math.min(height, height - dy)
  let sumA = 0
  let sumB = 0
  let sumAA = 0
  let sumBB = 0
  let sumAB = 0
  let count = 0

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const valueA = a[y * width + x]!
      const valueB = b[(y + dy) * width + x + dx]!
      sumA += valueA
      sumB += valueB
      sumAA += valueA * valueA
      sumBB += valueB * valueB
      sumAB += valueA * valueB
      count++
    }
  }

  const numerator = sumAB - (sumA * sumB) / count
  const denominator = Math.sqrt(
    (sumAA - (sumA * sumA) / count) * (sumBB - (sumB * sumB) / count)
  )
  return denominator > 0 ? numerator / denominator : 0
}

export function computeMotionVector(
  first: Float32Array,
  last: Float32Array,
  width: number,
  height: number,
  channels = 4
): MotionVectorResult {
  const fieldA = buildMotionField(first, width, height, channels)
  const fieldB = buildMotionField(last, width, height, channels)
  const maxShift = Math.min(
    MOTION_MAX_SHIFT,
    Math.floor(Math.min(fieldA.width, fieldA.height) / 4)
  )
  let bestDx = 0
  let bestDy = 0
  let bestScore = Number.NEGATIVE_INFINITY

  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const score = correlationAtShift(
        fieldA.data,
        fieldB.data,
        fieldA.width,
        fieldA.height,
        dx,
        dy
      )
      if (score > bestScore) {
        bestDx = dx
        bestDy = dy
        bestScore = score
      }
    }
  }

  return {
    dx: bestDx * (width / fieldA.width),
    dy: bestDy * (height / fieldA.height),
    score: bestScore
  }
}

export function compareMotionDirections(
  a: MotionVectorResult,
  b: MotionVectorResult
): MotionDirectionResult {
  const magnitudeA = Math.hypot(a.dx, a.dy)
  const magnitudeB = Math.hypot(b.dx, b.dy)
  const comparable =
    a.score >= MOTION_MIN_SCORE &&
    b.score >= MOTION_MIN_SCORE &&
    magnitudeA >= MOTION_MIN_DISTANCE &&
    magnitudeB >= MOTION_MIN_DISTANCE
  if (!comparable) return { aligned: true, comparable: false, cosine: null }

  const cosine = (a.dx * b.dx + a.dy * b.dy) / (magnitudeA * magnitudeB)
  return { aligned: cosine >= 0.5, comparable: true, cosine }
}

function frameMeanDeltaE(
  bufA: Float32Array,
  bufB: Float32Array,
  width: number,
  height: number,
  channels: number
): number {
  const n = width * height
  let sum = 0
  for (let i = 0; i < n; i++) {
    const [L1, a1, b1] = linearRgbToLab(
      bufA[i * channels]!,
      bufA[i * channels + 1]!,
      bufA[i * channels + 2]!
    )
    const [L2, a2, b2] = linearRgbToLab(
      bufB[i * channels]!,
      bufB[i * channels + 1]!,
      bufB[i * channels + 2]!
    )
    sum += deltaE2000(L1, a1, b1, L2, a2, b2)
  }
  return sum / n
}

export function computeFlicker(
  frames: Float32Array[],
  width: number,
  height: number,
  channels = 4
): FlickerResult {
  if (frames.length < 2) {
    return { mean: 0, max: 0, perFrame: [] }
  }

  const perFrame: number[] = []
  for (let i = 0; i < frames.length - 1; i++) {
    perFrame.push(
      frameMeanDeltaE(frames[i]!, frames[i + 1]!, width, height, channels)
    )
  }

  let sum = 0
  let max = 0
  for (const de of perFrame) {
    sum += de
    if (de > max) max = de
  }

  return {
    mean: sum / perFrame.length,
    max,
    perFrame
  }
}

export function computeGhosting(
  temporalOnFrame: Float32Array,
  temporalOffFrame: Float32Array,
  width: number,
  height: number,
  channels = 4
): GhostingResult {
  const n = width * height
  const perPixel = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const [L1, a1, b1] = linearRgbToLab(
      temporalOnFrame[i * channels]!,
      temporalOnFrame[i * channels + 1]!,
      temporalOnFrame[i * channels + 2]!
    )
    const [L2, a2, b2] = linearRgbToLab(
      temporalOffFrame[i * channels]!,
      temporalOffFrame[i * channels + 1]!,
      temporalOffFrame[i * channels + 2]!
    )
    perPixel[i] = deltaE2000(L1, a1, b1, L2, a2, b2)
  }

  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += perPixel[i]!
  }

  const sorted = Float32Array.from(perPixel).sort()
  const p95Index = Math.min(Math.floor(n * 0.95), n - 1)

  return {
    deMean: sum / n,
    deP95: sorted[p95Index]!
  }
}

export interface SequenceMetrics {
  flickerA: FlickerResult
  flickerB: FlickerResult
  ghostingA?: GhostingResult
  ghostingB?: GhostingResult
  motionA?: MotionVectorResult
  motionB?: MotionVectorResult
  motionDirection?: MotionDirectionResult
  frameCount: number
}
