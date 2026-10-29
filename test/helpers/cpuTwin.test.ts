import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { expectClose, quadrature, seededRandom } from './cpuTwin'
import { setCurrentSpec } from './log'

describe('cpuTwin', () => {
  setCurrentSpec('cpuTwin')

  describe('expectClose', () => {
    it('passes for equal scalars', () => {
      expectClose(1.0, 1.0, { label: 'scalar-equal' })
    })

    it('passes for close scalars within tolerance', () => {
      expectClose(1.0, 1.0 + 1e-7, { abs: 1e-6, label: 'scalar-close' })
    })

    it('passes for Vector3', () => {
      expectClose(
        new Vector3(1, 2, 3),
        new Vector3(1 + 1e-7, 2 + 1e-7, 3 + 1e-7),
        { label: 'vec3-close' }
      )
    })

    it('passes for arrays', () => {
      expectClose([1, 2, 3, 4], [1, 2, 3, 4], { label: 'array-equal' })
    })

    it('fails for distant values', () => {
      expect(() => expectClose(1.0, 2.0, { label: 'should-fail' })).toThrow(
        'values not close enough'
      )
    })

    it('prints a table on failure', () => {
      let errorMsg = ''
      try {
        expectClose([1.0, 2.0, 3.0], [1.0, 5.0, 3.0], { label: 'table-fail' })
      } catch (e) {
        errorMsg = (e as Error).message
      }
      expect(errorMsg).toContain('expected=')
      expect(errorMsg).toContain('actual=')
      expect(errorMsg).toContain('Δ=')
    })
  })

  describe('quadrature', () => {
    it('integrates x^2 from 0 to 1', () => {
      const result = quadrature(x => x * x, 0, 1, 10000)
      expectClose(result, 1 / 3, { abs: 1e-4, label: 'x^2 integral' })
    })

    it('integrates sin(x) from 0 to pi', () => {
      const result = quadrature(Math.sin, 0, Math.PI, 10000)
      expectClose(result, 2.0, { abs: 1e-4, label: 'sin integral' })
    })
  })

  describe('seededRandom', () => {
    it('is deterministic', () => {
      const a = seededRandom(42)
      const b = seededRandom(42)
      const valuesA = Array.from({ length: 10 }, () => a())
      const valuesB = Array.from({ length: 10 }, () => b())
      expect(valuesA).toEqual(valuesB)
    })

    it('produces values in [0, 1)', () => {
      const rng = seededRandom(123)
      for (let i = 0; i < 1000; i++) {
        const v = rng()
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    })

    it('different seeds produce different sequences', () => {
      const a = seededRandom(1)
      const b = seededRandom(2)
      const va = Array.from({ length: 5 }, () => a())
      const vb = Array.from({ length: 5 }, () => b())
      expect(va).not.toEqual(vb)
    })
  })
})
