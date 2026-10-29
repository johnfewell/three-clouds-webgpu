// which shadow cases DECLARE a sun inside the PCF band. A
// REGISTRY property only: exactly one does, by anchor-normal arithmetic. The
// plate shows the PCF branch runs on ZERO pixels of shadow-grazing (sampled
// dot > 0.0998 vs declared 4 deg, cause unmeasured), which a CPU test cannot
// assert. A plate-anchored pin needs a PCF receipt first

import { describe, expect, it } from 'vitest'

import { Ellipsoid } from '@takram/three-geospatial'

import {
  createSyntheticScene,
  sunDirectionFromElevationAzimuth
} from '../src/scenes/synthetic'
import { caseByName, cases } from './index'

const DEG = Math.PI / 180

/** src/qualityPresets.ts: the preset value the harness marches with */
const MAX_SHADOW_FILTER_RADIUS = 6

/** The shader's early-out: below this radius the no-PCF path is taken */
const PCF_MIN_RADIUS = 0.1

/** The shader's remapClamped(x, 0.1, 0): 0 at dot >= 0.1, 1 at dot <= 0 */
const pcfFactor = (dot: number): number =>
  Math.min(1, Math.max(0, (0.1 - dot) / 0.1))

const scene = createSyntheticScene({ nodeMaterials: false })
const surfaceNormal = Ellipsoid.WGS84.getSurfaceNormal(scene.anchorECEF)

/** dot(sunDirection, surfaceNormal) for a case's sun, computed not assumed */
const sunDotNormal = (sun: { elevation: number; azimuth: number }): number =>
  sunDirectionFromElevationAzimuth(
    sun.elevation * DEG,
    sun.azimuth * DEG,
    scene.enuAtAnchor
  ).dot(surfaceNormal)

describe('the PCF shadow-filter band, as DECLARED', () => {
  it('pins the band edge itself: the dot below which the radius clears the early-out', () => {
    // The whole file turns on this edge, and it was previously only implicit
    // radius = 6 * clamp((0.1 - dot)/0.1) >= 0.1  <=>  dot <= 0.0983333...
    const edge = 0.1 * (1 - PCF_MIN_RADIUS / MAX_SHADOW_FILTER_RADIUS)
    expect(edge).toBeCloseTo(0.0983333, 6)
    expect(MAX_SHADOW_FILTER_RADIUS * pcfFactor(edge)).toBeCloseTo(
      PCF_MIN_RADIUS,
      10
    )
    // Just above the edge the early-out takes over
    expect(MAX_SHADOW_FILTER_RADIUS * pcfFactor(edge + 1e-6)).toBeLessThan(
      PCF_MIN_RADIUS
    )
  })

  it('shadow-grazing DECLARES a sun inside the band', () => {
    const c = caseByName('shadow-grazing')
    expect(
      c,
      'shadow-grazing is gone — no case declares a sun in the PCF band, and ' +
        'the ladder no longer covers this sun elevation at all'
    ).not.toBeUndefined()
    expect(c!.state.shadow).toBe(true)

    const dot = sunDotNormal(c!.sun)
    expect(dot).toBeLessThan(0.1)
    expect(pcfFactor(dot)).toBeGreaterThan(0)

    // The shader's own early-out, with the preset radius stated as the
    // assumption it is: a non-zero factor is not enough on its own
    expect(MAX_SHADOW_FILTER_RADIUS * pcfFactor(dot)).toBeGreaterThan(
      PCF_MIN_RADIUS
    )

    // this is the DECLARED geometry only. The plate says the branch
    // runs on zero pixels (sampled dot above the band edge), a different
    // quantity. Deliberately not asserted: this file cannot see the render
  })

  it('is the ONLY shadow case whose DECLARED sun is in the band', () => {
    const armed = cases
      .filter(c => c.state?.shadow === true)
      .filter(c => pcfFactor(sunDotNormal(c.sun)) > 0)
      .map(c => c.name)
    expect(
      armed,
      'a shadow case moved into or out of the DECLARED PCF band. This is a ' +
        'registry property, not a statement about execution: if shadow-grazing ' +
        'left the band no case declares this sun elevation any more; if another ' +
        'case entered it, the band is no longer the one-case property this pin ' +
        'records. Whether the branch actually RUNS is a question only a plate ' +
        'can answer, and on shadow-grazing the answer is no.'
    ).toEqual(['shadow-grazing'])
  })

  it('keeps the neutral twin on the same pose AND sun', () => {
    // vacuousCases pairs on pose and sun and SILENTLY SKIPS what it cannot
    // pair, so a twin that drifts exempts shadow-grazing from the guard it
    // exists to satisfy, the way case 35 went unchecked
    const shadow = caseByName('shadow-grazing')!
    const neutral = caseByName('sun-grazing')!
    expect(neutral.sun).toEqual(shadow.sun)
    expect(neutral.pose).toEqual(shadow.pose)
    expect(neutral.state.shadow).not.toBe(true)
  })
})
