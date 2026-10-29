// the arithmetic the p4 log-depth e2e predicts from, held against the
// library's own CPU decoders (the twin in src/march/logDepthPrecision.test.ts)

import { describe, expect, it } from 'vitest'

import {
  classifyContest,
  decodedDistance,
  DEPTH_STEP,
  depthOf,
  depthTestWinner,
  logDepthOf,
  logRelativeErrorBound,
  perspectiveDepthOf,
  quantizeDepth
} from '../examples/parity/src/metrics/depthPrecision'
import {
  logarithmicToPerspectiveDepthCPU,
  perspectiveDepthToViewZCPU
} from '../src/march/sceneDepth'
import { table } from './helpers/cpuTwin'

// The e2e extreme: near 0.1 mm, far 1e8 m, surfaces 45 km away, 45 m apart
const NEAR = 1e-4
const FAR = 1e8
const D1 = 45_000
const D2 = D1 * 1.001

// The CPU twin decodes log depth THROUGH a perspective depth (clouds.frag:815),
// which sits within n/D of 1 and so carries relative error ~eps * D / n even in
// float64. The comparisons below stay where that is under 1e-6
const viaLibrary = (d: number): number =>
  -perspectiveDepthToViewZCPU(
    logarithmicToPerspectiveDepthCPU(d, NEAR, FAR),
    NEAR,
    FAR
  )

describe('depth precision arithmetic for the p4 log-depth e2e', () => {
  it('the encoders invert the library decoders exactly (no quantisation)', () => {
    const rows = [100, D1].map(distance => ({
      distance,
      viaLog: viaLibrary(logDepthOf(distance, NEAR, FAR)),
      viaPerspective: -perspectiveDepthToViewZCPU(
        perspectiveDepthOf(distance, NEAR, FAR),
        NEAR,
        FAR
      )
    }))
    table('encoders-vs-library-decoders', rows)
    for (const r of rows) {
      expect(r.viaLog / r.distance).toBeCloseTo(1, 6)
      expect(r.viaPerspective / r.distance).toBeCloseTo(1, 6)
    }
  })

  it('decodedDistance agrees with the library decode of the same quantised depth', () => {
    const d = quantizeDepth(logDepthOf(D1, NEAR, FAR))
    const library = viaLibrary(d)
    const ours = decodedDistance('log', D1, NEAR, FAR)
    table('log-decode-vs-library', [{ expected: library, actual: ours }])
    expect(Math.abs(ours / library - 1)).toBeLessThan(1e-6)
  })

  it('at the e2e extreme, linear depth rounds to the clear value and log keeps centimetres', () => {
    const linear = decodedDistance('linear', D1, NEAR, FAR)
    const log = decodedDistance('log', D1, NEAR, FAR)
    const bound = D1 * logRelativeErrorBound(NEAR, FAR)
    table('e2e-extreme', [
      {
        encoding: 'linear',
        oneMinusDepth: 1 - perspectiveDepthOf(D1, NEAR, FAR),
        halfStep: DEPTH_STEP / 2,
        decoded: linear
      },
      {
        encoding: 'log',
        decoded: log,
        errorMetres: Math.abs(log - D1),
        bound
      }
    ])
    // n/D = 2.2e-9 is below half a step, so the depth rounds to 1
    expect(1 - perspectiveDepthOf(D1, NEAR, FAR)).toBeLessThan(DEPTH_STEP / 2)
    expect(linear).toBe(Infinity)
    expect(Math.abs(log - D1)).toBeLessThanOrEqual(bound)
    expect(bound).toBeLessThan(0.1)
  })

  it('predicts the depth-test contest: linear ties (later/far wins), both log encodings keep the near surface', () => {
    const rows = (['linear', 'log', 'webglLog'] as const).map(encoding => {
      const a = quantizeDepth(depthOf(encoding, D1, NEAR, FAR))
      const b = quantizeDepth(depthOf(encoding, D2, NEAR, FAR))
      return {
        encoding,
        stepsApart: Math.round((b - a) / DEPTH_STEP),
        winner: depthTestWinner(encoding, D1, D2, NEAR, FAR)
      }
    })
    table('depth-test-contest', rows)
    expect(rows.map(r => r.winner)).toEqual(['far', 'near', 'near'])
    expect(rows[0]!.stepsApart).toBe(0)
    expect(rows[1]!.stepsApart).toBeGreaterThan(100)
    expect(rows[2]!.stepsApart).toBeGreaterThan(100)
  })

  it('the extreme is what does the work: at the harness near plane linear resolves both', () => {
    const decoded = decodedDistance('linear', D1, 100, FAR)
    const winner = depthTestWinner('linear', D1, D2, 100, FAR)
    table('harness-near-plane', [{ near: 100, decoded, winner }])
    expect(Math.abs(decoded - D1) / D1).toBeLessThan(1e-3)
    expect(winner).toBe('near')
  })

  it('classifyContest reads the centre and ring of the contest target', () => {
    const size = 8
    const image = (center: [number, number], ring: [number, number]) => {
      const out: number[] = []
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const nx = Math.abs(((x + 0.5) / size) * 2 - 1)
          const ny = Math.abs(((y + 0.5) / size) * 2 - 1)
          const [r, g] = nx < 0.25 && ny < 0.25 ? center : ring
          out.push(r, g, 0, 255)
        }
      }
      return out
    }
    const nearWins = classifyContest(image([255, 0], [0, 255]), size)
    const farWins = classifyContest(image([0, 255], [0, 255]), size)
    const blank = classifyContest(image([0, 0], [0, 0]), size)
    table('classifyContest', [
      { image: 'near wins', ...nearWins },
      { image: 'far wins', ...farWins },
      { image: 'blank', ...blank }
    ])
    expect(nearWins).toMatchObject({ centerNear: 1, ringFar: 1 })
    expect(farWins).toMatchObject({ centerNear: 0, ringFar: 1 })
    // A blank target (nothing rendered) must not read as the far quad
    expect(blank).toMatchObject({ centerNear: 0, ringFar: 0 })
  })
})
