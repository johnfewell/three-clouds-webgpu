// The round-robin plan is what keeps a reused cascade honest: it must hand
// back the matrices the cascade was rendered with, and it must give up and
// render everything once the reused maps no longer cover the view

import { Matrix4, Vector3 } from 'three'
import { beforeEach, describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  ROUND_ROBIN_MAX_DRIFT,
  ShadowRoundRobin,
  type RoundRobinCascade
} from './shadowRoundRobin'

// World x in -100..100 maps to clip -1..1, so a shift of d metres is 0.01 d
const WORLD_TO_CLIP = new Matrix4().makeScale(0.01, 0.01, 0.01)

function cascadeAt(shift: number): RoundRobinCascade {
  const matrix = WORLD_TO_CLIP.clone().multiply(
    new Matrix4().makeTranslation(-shift, 0, 0)
  )
  return { matrix, inverseMatrix: matrix.clone().invert() }
}

const SUN = new Vector3(0, 0, 1)

function primed(count = 3): {
  rr: ShadowRoundRobin
  cascades: RoundRobinCascade[]
} {
  const rr = new ShadowRoundRobin()
  const cascades = Array.from({ length: count }, () => cascadeAt(0))
  rr.record(cascades, count, SUN, null)
  return { rr, cascades }
}

describe('ShadowRoundRobin', () => {
  beforeEach(() => {
    setCurrentSpec('shadowRoundRobin')
  })

  test('renders everything until each cascade has been rendered once', () => {
    const rr = new ShadowRoundRobin()
    const cascades = [cascadeAt(0), cascadeAt(0), cascadeAt(0)]
    expect(rr.plan(cascades, 3, SUN, false)).toBeNull()
  })

  test('cycles one cascade per update and restores the others', () => {
    const { rr, cascades } = primed()
    const stored = cascades.map(c => c.matrix.clone())
    const picks: (number | null)[] = []
    for (let update = 0; update < 4; update++) {
      // Every refit moves each cascade a little, inside the drift limit
      const fresh = cascadeAt(5 + update)
      for (const c of cascades) {
        c.matrix.copy(fresh.matrix)
        c.inverseMatrix.copy(fresh.inverseMatrix)
      }
      const only = rr.plan(cascades, 3, SUN, false)
      picks.push(only)
      const kept = cascades.map((c, i) =>
        c.matrix.equals(i === only ? fresh.matrix : stored[i]!)
      )
      log('round-robin-update', [{ update, only, kept: kept.join(',') }])
      // The picked cascade keeps its refit, the rest get their stored maps
      expect(kept).toEqual([true, true, true])
      rr.record(cascades, 3, SUN, only)
      if (only != null) stored[only]!.copy(cascades[only]!.matrix)
    }
    expect(picks).toEqual([0, 1, 2, 0])
  })

  test('a camera move past the drift limit renders every cascade', () => {
    const limitMetres = ROUND_ROBIN_MAX_DRIFT * 100
    const rows = [0.8, 1.2].map(f => {
      const { rr, cascades } = primed()
      const fresh = cascadeAt(limitMetres * f)
      cascades[1]!.matrix.copy(fresh.matrix)
      cascades[1]!.inverseMatrix.copy(fresh.inverseMatrix)
      return { shift: limitMetres * f, plan: rr.plan(cascades, 3, SUN, false) }
    })
    log('round-robin-drift', rows)
    expect(rows[0]!.plan).toBe(0)
    expect(rows[1]!.plan).toBeNull()
  })

  test('a sun turn past a quarter degree renders every cascade', () => {
    const turned = (deg: number) =>
      new Vector3(
        Math.sin((deg * Math.PI) / 180),
        0,
        Math.cos((deg * Math.PI) / 180)
      )
    const rows = [0.1, 0.5].map(deg => {
      const { rr, cascades } = primed()
      return { deg, plan: rr.plan(cascades, 3, turned(deg), false) }
    })
    log('round-robin-sun', rows)
    expect(rows[0]!.plan).toBe(0)
    expect(rows[1]!.plan).toBeNull()
  })

  test('a reset, a cascade-count change or one cascade renders everything', () => {
    const { rr, cascades } = primed()
    expect(rr.plan(cascades, 3, SUN, true)).toBeNull()
    expect(rr.plan([...cascades, cascadeAt(0)], 4, SUN, false)).toBeNull()
    const single = primed(1)
    expect(single.rr.plan(single.cascades, 1, SUN, false)).toBeNull()
    rr.invalidate()
    expect(rr.plan(cascades, 3, SUN, false)).toBeNull()
  })
})
