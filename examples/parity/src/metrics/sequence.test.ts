import { describe, expect, it } from 'vitest'

import { deltaE2000, linearRgbToLab } from './color'
import {
  compareMotionDirections,
  computeFlicker,
  computeGhosting,
  computeMotionVector
} from './sequence'

function logTable(label: string, rows: Record<string, number | string>[]) {
  console.log(`\n[sequence] ${label}`)
  if (rows.length === 0) return
  const keys = Object.keys(rows[0]!)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k]).length))
  )
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join(' | ')
  console.log(header)
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  for (const row of rows) {
    console.log(
      keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' | ')
    )
  }
}

function makeSolidRgba(
  r: number,
  g: number,
  b: number,
  w: number,
  h: number
): Float32Array {
  const buf = new Float32Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = 1
  }
  return buf
}

function makeRampFrames(
  frameCount: number,
  w: number,
  h: number,
  startR: number,
  stepR: number
): Float32Array[] {
  return Array.from({ length: frameCount }, (_, i) =>
    makeSolidRgba(Math.min(1, startR + i * stepR), 0.3, 0.3, w, h)
  )
}

function makeMotionPattern(width: number, height: number): Float32Array {
  const frame = new Float32Array(width * height * 4)
  const blobs = [
    { x: 0.19, y: 0.28, radius: 0.08, value: 0.9 },
    { x: 0.52, y: 0.67, radius: 0.13, value: 0.6 },
    { x: 0.78, y: 0.39, radius: 0.06, value: 1.1 }
  ]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let value = 0
      for (const blob of blobs) {
        const dx = x / width - blob.x
        const dy = y / height - blob.y
        value +=
          blob.value *
          Math.exp(-(dx * dx + dy * dy) / (2 * blob.radius * blob.radius))
      }
      frame[i] = value
      frame[i + 1] = value * 0.7
      frame[i + 2] = value * 0.4
      frame[i + 3] = 1
    }
  }
  return frame
}

function shiftFrame(
  source: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number
): Float32Array {
  const shifted = new Float32Array(source.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const targetX = (x + dx + width) % width
      const targetY = (y + dy + height) % height
      const sourceIndex = (y * width + x) * 4
      const targetIndex = (targetY * width + targetX) * 4
      shifted.set(source.subarray(sourceIndex, sourceIndex + 4), targetIndex)
    }
  }
  return shifted
}

describe('motion direction', () => {
  const width = 48
  const height = 32
  const first = makeMotionPattern(width, height)

  it('recovers the displacement of an asymmetric field', () => {
    const result = computeMotionVector(
      first,
      shiftFrame(first, width, height, 4, -3),
      width,
      height
    )

    logTable('motion displacement', [
      {
        dx: result.dx,
        dy: result.dy,
        score: result.score.toFixed(4)
      }
    ])

    expect(result.dx).toBe(4)
    expect(result.dy).toBe(-3)
    expect(result.score).toBeGreaterThan(0.5)
  })

  it('accepts aligned motion and rejects opposite motion', () => {
    const right = computeMotionVector(
      first,
      shiftFrame(first, width, height, 4, 0),
      width,
      height
    )
    const alsoRight = computeMotionVector(
      first,
      shiftFrame(first, width, height, 3, 1),
      width,
      height
    )
    const left = computeMotionVector(
      first,
      shiftFrame(first, width, height, -4, 0),
      width,
      height
    )

    expect(compareMotionDirections(right, alsoRight)).toMatchObject({
      aligned: true,
      comparable: true
    })
    expect(compareMotionDirections(right, left)).toMatchObject({
      aligned: false,
      comparable: true
    })
  })

  it('does not infer direction from a static frame', () => {
    const still = computeMotionVector(first, first, width, height)
    expect(compareMotionDirections(still, still)).toEqual({
      aligned: true,
      comparable: false,
      cosine: null
    })
  })
})

describe('computeFlicker', () => {
  it('identical frames → zero flicker', () => {
    const frame = makeSolidRgba(0.5, 0.3, 0.2, 4, 4)
    const result = computeFlicker([frame, frame, frame], 4, 4)
    expect(result.mean).toBe(0)
    expect(result.max).toBe(0)
    expect(result.perFrame).toHaveLength(2)

    logTable('identical frames', [
      { frames: 3, mean: result.mean, max: result.max }
    ])
  })

  it('single frame → empty result', () => {
    const frame = makeSolidRgba(0.5, 0.3, 0.2, 4, 4)
    const result = computeFlicker([frame], 4, 4)
    expect(result.mean).toBe(0)
    expect(result.perFrame).toHaveLength(0)
  })

  it('ramping frames → non-zero flicker, perFrame all equal', () => {
    const w = 4
    const h = 4
    const frames = makeRampFrames(5, w, h, 0.1, 0.1)
    const result = computeFlicker(frames, w, h)

    expect(result.mean).toBeGreaterThan(0)
    expect(result.perFrame).toHaveLength(4)

    // All perFrame values should be positive (not equal: ΔE2000 is nonlinear)
    for (const de of result.perFrame) {
      expect(de).toBeGreaterThan(0)
    }

    logTable(
      'ramp flicker',
      result.perFrame.map((de, i) => ({
        transition: `f${i}→f${i + 1}`,
        deltaE: de.toFixed(4)
      }))
    )
  })

  it('large step → higher flicker than small step', () => {
    const w = 4
    const h = 4
    const smallStep = makeRampFrames(4, w, h, 0.3, 0.01)
    const largeStep = makeRampFrames(4, w, h, 0.3, 0.1)

    const small = computeFlicker(smallStep, w, h)
    const large = computeFlicker(largeStep, w, h)

    expect(large.mean).toBeGreaterThan(small.mean)

    logTable('step comparison', [
      {
        step: 'small (0.01)',
        mean: small.mean.toFixed(4),
        max: small.max.toFixed(4)
      },
      {
        step: 'large (0.1)',
        mean: large.mean.toFixed(4),
        max: large.max.toFixed(4)
      }
    ])
  })

  it('flicker perFrame matches manual ΔE2000 computation', () => {
    const w = 2
    const h = 2
    const frameA = makeSolidRgba(0.2, 0.3, 0.4, w, h)
    const frameB = makeSolidRgba(0.4, 0.3, 0.4, w, h)

    const result = computeFlicker([frameA, frameB], w, h)

    const [L1, a1, b1] = linearRgbToLab(0.2, 0.3, 0.4)
    const [L2, a2, b2] = linearRgbToLab(0.4, 0.3, 0.4)
    const expectedDE = deltaE2000(L1, a1, b1, L2, a2, b2)

    expect(result.perFrame[0]).toBeCloseTo(expectedDE, 5)

    logTable('manual verification', [
      {
        computed: result.perFrame[0]!.toFixed(6),
        expected: expectedDE.toFixed(6)
      }
    ])
  })
})

describe('computeGhosting', () => {
  it('identical frames → zero ghosting', () => {
    const frame = makeSolidRgba(0.5, 0.3, 0.2, 4, 4)
    const result = computeGhosting(frame, frame, 4, 4)
    expect(result.deMean).toBe(0)
    expect(result.deP95).toBe(0)
  })

  it('different frames → non-zero ghosting', () => {
    const w = 4
    const h = 4
    const temporalOn = makeSolidRgba(0.5, 0.3, 0.2, w, h)
    const temporalOff = makeSolidRgba(0.6, 0.3, 0.2, w, h)

    const result = computeGhosting(temporalOn, temporalOff, w, h)
    expect(result.deMean).toBeGreaterThan(0)
    expect(result.deP95).toBeGreaterThan(0)
    // Solid colors → all pixels identical → P95 == mean
    expect(result.deP95).toBeCloseTo(result.deMean, 6)

    logTable('ghosting', [
      { deMean: result.deMean.toFixed(4), deP95: result.deP95.toFixed(4) }
    ])
  })

  it('large difference → higher ghosting', () => {
    const w = 4
    const h = 4
    const base = makeSolidRgba(0.3, 0.3, 0.3, w, h)
    const smallDiff = makeSolidRgba(0.31, 0.3, 0.3, w, h)
    const largeDiff = makeSolidRgba(0.6, 0.3, 0.3, w, h)

    const small = computeGhosting(base, smallDiff, w, h)
    const large = computeGhosting(base, largeDiff, w, h)

    expect(large.deMean).toBeGreaterThan(small.deMean)
  })

  it('P95 ≥ mean (basic statistical property)', () => {
    const w = 8
    const h = 8
    // Create frames with varying per-pixel differences
    const frameA = new Float32Array(w * h * 4)
    const frameB = new Float32Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const t = i / (w * h)
      frameA[i * 4] = 0.3
      frameA[i * 4 + 1] = 0.3
      frameA[i * 4 + 2] = 0.3
      frameA[i * 4 + 3] = 1
      frameB[i * 4] = 0.3 + t * 0.4
      frameB[i * 4 + 1] = 0.3
      frameB[i * 4 + 2] = 0.3
      frameB[i * 4 + 3] = 1
    }

    const result = computeGhosting(frameA, frameB, w, h)
    expect(result.deP95).toBeGreaterThanOrEqual(result.deMean)

    logTable('P95 vs mean', [
      { deMean: result.deMean.toFixed(4), deP95: result.deP95.toFixed(4) }
    ])
  })
})
