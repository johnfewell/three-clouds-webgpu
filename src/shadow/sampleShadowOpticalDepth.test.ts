import { beforeEach, describe, expect, it } from 'vitest'

import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  cpuGetFadedCascadeIndex,
  cpuInterleavedGradientNoise,
  cpuReadShadowOpticalDepth,
  cpuVogelDisk
} from './sampleShadowOpticalDepth'

const WORLD_TO_UNIT = 1 / 6360000

describe('cpuVogelDisk', () => {
  beforeEach(() => {
    setCurrentSpec('sampleShadowOD')
  })

  it('generates points inside the unit disk', () => {
    const count = 8
    for (let i = 0; i < count; i++) {
      const [x, y] = cpuVogelDisk(i, count, 0)
      const r = Math.sqrt(x * x + y * y)
      expect(r).toBeLessThanOrEqual(1.001)
    }
  })

  it('golden angle spacing distributes points evenly', () => {
    const count = 8
    const points = Array.from({ length: count }, (_, i) =>
      cpuVogelDisk(i, count, 0)
    )

    const angles = points.map(([x, y]) => Math.atan2(y, x))

    table(
      'vogel-disk',
      points.map(([x, y], i) => ({
        index: i,
        x: x.toFixed(4),
        y: y.toFixed(4),
        r: Math.sqrt(x * x + y * y).toFixed(4),
        angle: angles[i]!.toFixed(3)
      }))
    )

    const radii = points.map(([x, y]) => Math.sqrt(x * x + y * y))
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1]!)
    }
  })

  it('phi rotates the entire pattern', () => {
    const [x0, y0] = cpuVogelDisk(0, 8, 0)
    const [x1, y1] = cpuVogelDisk(0, 8, Math.PI / 2)
    const angle0 = Math.atan2(y0, x0)
    const angle1 = Math.atan2(y1, x1)
    const delta = Math.abs(angle1 - angle0)
    expectClose(delta, Math.PI / 2, { label: 'phi-rotation', abs: 0.01 })
  })
})

describe('cpuReadShadowOpticalDepth', () => {
  beforeEach(() => {
    setCurrentSpec('sampleShadowOD')
  })

  it('clear texel returns 0 (no extinction)', () => {
    const result = cpuReadShadowOpticalDepth(
      { r: 0, g: 0, b: 0, a: 0 },
      5000,
      0,
      WORLD_TO_UNIT
    )
    expect(result).toBe(0)
  })

  it('constant extinction: OD = meanExtinction × distanceToFront', () => {
    const frontDepthWorld = 1000
    const meanExtinction = 0.001
    const maxOD = 2.5
    const tail = 0.1

    const shadow = {
      r: frontDepthWorld * WORLD_TO_UNIT,
      g: meanExtinction,
      b: maxOD,
      a: tail
    }

    const distanceToTop = 5000
    const distanceOffset = 0

    const result = cpuReadShadowOpticalDepth(
      shadow,
      distanceToTop,
      distanceOffset,
      WORLD_TO_UNIT
    )

    const expectedDistanceToFront =
      distanceToTop - distanceOffset - frontDepthWorld
    const fromExtinction = meanExtinction * expectedDistanceToFront
    const fromOD = maxOD + tail
    const expected = Math.min(fromOD, fromExtinction)

    table('readShadowOD', [
      { metric: 'distanceToFront', value: expectedDistanceToFront },
      { metric: 'fromExtinction', value: fromExtinction },
      { metric: 'fromOD', value: fromOD },
      { metric: 'result', expected, actual: result }
    ])

    expectClose(result, expected, { label: 'constant-extinction', abs: 1e-4 })
  })

  it('distanceToFront clamps to 0 when behind the cloud', () => {
    const shadow = {
      r: 8000 * WORLD_TO_UNIT,
      g: 0.005,
      b: 3.0,
      a: 0.2
    }

    const result = cpuReadShadowOpticalDepth(shadow, 1000, 0, WORLD_TO_UNIT)
    expect(result).toBe(0)
  })

  it('tail contributes when maxOD + tail < extinction path', () => {
    const shadow = {
      r: 500 * WORLD_TO_UNIT,
      g: 0.01,
      b: 0.5,
      a: 0.3
    }

    const result = cpuReadShadowOpticalDepth(shadow, 10000, 0, WORLD_TO_UNIT)

    const distanceToFront = 10000 - 500
    const fromExtinction = 0.01 * distanceToFront
    const fromOD = 0.5 + 0.3

    expect(result).toBe(Math.min(fromOD, fromExtinction))
    expect(result).toBe(fromOD)

    log('tail-contributes', { fromOD, fromExtinction, result })
  })
})

describe('cpuGetFadedCascadeIndex', () => {
  beforeEach(() => {
    setCurrentSpec('sampleShadowOD')
  })

  const intervals: Array<[number, number]> = [
    [0, 0.2],
    [0.2, 0.5],
    [0.5, 1.0]
  ]

  it('returns cascade 0 for near depths', () => {
    const idx = cpuGetFadedCascadeIndex(0.1, intervals, 0)
    expect(idx).toBe(0)
  })

  it('returns cascade 1 for mid depths', () => {
    const idx = cpuGetFadedCascadeIndex(0.35, intervals, 0)
    expect(idx).toBe(1)
  })

  it('returns last cascade for far depths', () => {
    const idx = cpuGetFadedCascadeIndex(0.75, intervals, 0)
    expect(idx).toBe(2)
  })

  it('jitter dithers at cascade boundaries', () => {
    const boundary = 0.2
    const lowJitter = cpuGetFadedCascadeIndex(boundary, intervals, 0)
    const highJitter = cpuGetFadedCascadeIndex(boundary, intervals, 0.99)

    log('boundary-jitter', { lowJitter, highJitter })

    expect(lowJitter).not.toBe(highJitter)
  })

  it('returns -1 when depth is before all cascades', () => {
    const idx = cpuGetFadedCascadeIndex(-0.5, intervals, 0)
    expect(idx).toBe(-1)
  })
})

describe('cpuInterleavedGradientNoise', () => {
  beforeEach(() => {
    setCurrentSpec('sampleShadowOD')
  })

  it('produces values in [0, 1)', () => {
    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const val = cpuInterleavedGradientNoise(x, y)
        expect(val).toBeGreaterThanOrEqual(0)
        expect(val).toBeLessThan(1)
      }
    }
  })

  it('varies with position', () => {
    const a = cpuInterleavedGradientNoise(0, 0)
    const b = cpuInterleavedGradientNoise(1, 0)
    const c = cpuInterleavedGradientNoise(0, 1)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('source verification', () => {
  it('imports raySphereIntersection from @takram/three-geospatial/webgpu', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('raySphereIntersection')
    expect(source).toContain('@takram/three-geospatial/webgpu')
  })

  it('imports interleavedGradientNoise from @takram/three-geospatial/webgpu', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('interleavedGradientNoise')
  })

  it('implements vogelDisk with golden angle', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('2.3999632297286535')
    expect(source).toContain('vogelDisk')
  })

  it('references cascadedShadowMaps.glsl for cascade selection', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('cascadedShadowMaps.glsl')
    expect(source).toContain('getFadedCascadeIndex')
  })

  it('readShadowOpticalDepth divides shadow.r by worldToUnit (AUDIT-4)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('shadow.r.div(worldToUnit)')
    expect(source).toContain('AUDIT-4')
  })

  it('cites the OD atlas tweet', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain(
      'https://x.com/shotamatsuda/status/1885322308908442106'
    )
  })
})
