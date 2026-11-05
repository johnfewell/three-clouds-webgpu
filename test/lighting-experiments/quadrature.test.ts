import { describe, expect, test } from 'vitest'

import {
  candidateDirections,
  integrateCellSky,
  sphereDirections,
  uniformSkyAudit
} from '../../scripts/lighting-experiments/quadrature.mjs'
import { phaseFunction } from '../../src/lighting/phaseFunction'
import { log, setCurrentSpec } from '../helpers/log'

const rules = candidateDirections()
const views = [...rules.axes6, ...rules.corners8, ...sphereDirections(64)]
const phase = (cosine: number) => phaseFunction(cosine, 1, 0.7, -0.2, 0.5)

describe('sky quadrature qualification', () => {
  test.each(Object.entries(rules))(
    '%s preserves an isotropic uniform sky',
    (name, directions) => {
      setCurrentSpec('lighting-quadrature')
      const result = uniformSkyAudit(
        directions,
        views,
        () => 1 / (4 * Math.PI),
        1e-12
      )
      expect(result.passed).toBe(true)
      log(name, result)
    }
  )

  test.each(Object.entries(rules))(
    '%s cannot qualify the default anisotropic phase',
    (name, directions) => {
      const result = uniformSkyAudit(directions, views, phase, 0.02)
      expect(result.passed).toBe(false)
      expect(result.maximumError).toBeGreaterThan(0.2)
      log(`${name}-anisotropic`, result)
    }
  )

  test('a dense rule converges to normalized uniform-sky illumination', () => {
    const coarse = uniformSkyAudit(sphereDirections(2048), views, phase, 0.002)
    const fine = uniformSkyAudit(sphereDirections(8192), views, phase, 0.002)
    expect(fine.passed).toBe(true)
    expect(fine.maximumError).toBeLessThan(coarse.maximumError)
    log('dense-rule-control', fine)
  })

  test('refuses empty measurements, invalid counts and invalid phases', () => {
    expect(() => sphereDirections(0)).toThrow('Direction count')
    expect(() => uniformSkyAudit([], views, phase, 0.02)).toThrow(
      'zero directions'
    )
    expect(() => uniformSkyAudit(rules.axes6, [], phase, 0.02)).toThrow(
      'zero views'
    )
    expect(() => uniformSkyAudit(rules.axes6, views, () => NaN, 0.02)).toThrow(
      'Invalid phase'
    )
  })
})

test.each(Object.entries(rules))(
  '%s cell-integrated phase preserves uniform sky without a fitted gain',
  (name, directions) => {
    const dense = sphereDirections(8192)
    let maxError = 0
    for (const view of views) {
      const actual = integrateCellSky(directions, dense, view, phase, () => 1)
      maxError = Math.max(maxError, Math.abs(actual - 1))
      expect(integrateCellSky(directions, dense, view, phase, () => 0)).toBe(0)
    }
    expect(maxError).toBeLessThan(0.002)
    log(`${name}-cell-phase`, { maxError, expected: 0 })
  }
)

test('dense sky integration matches the analytic phase first moment', () => {
  const directions = sphereDirections(8192)
  // A single cell is enough for each point when both quadratures use that point
  for (const view of rules.axes6) {
    let actual = 0
    for (const direction of directions) {
      const cosine = direction.reduce(
        (sum, value, axis) => sum + value * view[axis]!,
        0
      )
      actual +=
        (phase(cosine) * (2 + direction[2]!) * 4 * Math.PI) / directions.length
    }
    const expected = 2 + 0.25 * view[2]!
    expect(Math.abs(actual - expected)).toBeLessThan(0.0001)
    log('linear-sky', { actual, expected })
  }
})
