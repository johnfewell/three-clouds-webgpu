// CPU twin tests for the clouds resolve pass
// Cite: cloudsResolve.frag

import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { bayerIndex2D } from './bayer'
import {
  buildTemporalAntialiasing,
  buildTemporalUpscale,
  getClosestFragmentCPU,
  isCurrentFrameCPU,
  type CloudsResolveDeps
} from './cloudsResolve'

async function compileResolve(upscale: boolean): Promise<string> {
  const { DataTexture, HalfFloatType, LinearFilter, RGBAFormat } =
    await import('three')
  const { float, texture } = await import('three/tsl')
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')

  const createTexture = () => {
    const result = new DataTexture(
      new Uint16Array(4 * 4 * 4),
      4,
      4,
      RGBAFormat,
      // Match the filterable fp16 render targets. The compiler stub lacks
      // float32-filterable, so FloatType silently tests textureLoad instead
      HalfFloatType
    )
    result.minFilter = LinearFilter
    result.magFilter = LinearFilter
    result.needsUpdate = true
    return result
  }

  const deps: CloudsResolveDeps = {
    colorBuffer: createTexture(),
    depthVelocityBuffer: createTexture(),
    colorHistoryNode: texture(createTexture()),
    resolveWidth: float(16),
    resolveHeight: float(16),
    frame: float(0),
    varianceGamma: float(1),
    temporalAlpha: float(0.1)
  }
  const result = upscale
    ? buildTemporalUpscale(deps)
    : buildTemporalAntialiasing(deps)
  return compileWGSL(result, { width: 16, height: 16 }).fragment
}

describe('cloudsResolve CPU twins', () => {
  setCurrentSpec('cloudsResolve')

  describe('Bayer current-frame selection', () => {
    test('shader uses the shared top-down to reference-row conversion', async () => {
      const source = await import('fs').then(fs =>
        fs.readFileSync(
          new URL('./cloudsResolve.ts', import.meta.url).pathname,
          'utf8'
        )
      )
      expect(source).toContain('referenceBayerRow(coordY, deps.resolveHeight)')
    })

    test('exactly 1/16 of each 4×4 block is selected per frame', () => {
      for (let frame = 0; frame < 16; frame++) {
        let count = 0
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            if (isCurrentFrameCPU(x, y, frame)) {
              count++
            }
          }
        }
        expect(count, `frame ${frame} should select exactly 1 pixel`).toBe(1)
      }

      log('bayer-1-of-16', { check: 'passed', framesChecked: 16 })
    })

    test('all 16 cells are visited over 16 frames', () => {
      const visited = new Set<string>()
      for (let frame = 0; frame < 16; frame++) {
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            if (isCurrentFrameCPU(x, y, frame)) {
              visited.add(`${x},${y}`)
            }
          }
        }
      }
      expect(visited.size).toBe(16)

      log('bayer-all-16', { uniqueCells: visited.size })
    })

    test('selection repeats with period 16', () => {
      for (let frame = 0; frame < 16; frame++) {
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            expect(
              isCurrentFrameCPU(x, y, frame),
              `(${x},${y}) frame ${frame} vs ${frame + 16}`
            ).toBe(isCurrentFrameCPU(x, y, frame + 16))
          }
        }
      }

      log('bayer-period-16', { check: 'passed' })
    })

    test('works for pixels beyond the first 4×4 tile', () => {
      for (let frame = 0; frame < 16; frame++) {
        let count = 0
        for (let y = 100; y < 104; y++) {
          for (let x = 200; x < 204; x++) {
            if (isCurrentFrameCPU(x, y, frame)) {
              count++
            }
          }
        }
        expect(count, `frame ${frame} at (200,100)–(203,103)`).toBe(1)
      }

      log('bayer-large-coords', { check: 'passed' })
    })

    test('bayerIndex2D matches GLSL bayerIndices table', () => {
      // Cite: cloudsResolve.frag:42–47
      const glslTable = [
        // bayerIndices[x] = ivec4(...), one row per x
        [0, 12, 3, 15],
        [8, 4, 11, 7],
        [2, 14, 1, 13],
        [10, 6, 9, 5]
      ]
      for (let x = 0; x < 4; x++) {
        for (let y = 0; y < 4; y++) {
          expect(bayerIndex2D(x, y), `bayerIndex2D(${x},${y})`).toBe(
            glslTable[x]![y]!
          )
        }
      }

      log('bayer-glsl-match', { check: 'passed' })
    })
  })

  describe('getClosestFragment CPU twin', () => {
    test('finds minimum depth in 3×3 neighborhood', () => {
      const width = 5
      // 5×5 buffer, row-major
      const buffer = Array.from({ length: 25 }, (_, i) => ({
        // Depth increases with index
        r: 100 + i,
        g: 0,
        b: 0,
        a: 0
      }))
      // Plant the minimum at (3, 2) → index = 2*5+3 = 13
      buffer[13] = { r: 0.5, g: 0.01, b: -0.02, a: 0 }

      const result = getClosestFragmentCPU(buffer, width, 3, 2)
      expect(result.r).toBe(0.5)
      expect(result.g).toBe(0.01)
      expect(result.b).toBe(-0.02)

      log('closest-center', { resultR: result.r })
    })

    test('finds minimum in neighbor, not center', () => {
      const width = 5
      const buffer = Array.from({ length: 25 }, () => ({
        r: 50,
        g: 0,
        b: 0,
        a: 0
      }))
      // Plant minimum at (1, 1), a neighbor of (2, 2)
      buffer[1 * 5 + 1] = { r: 0.1, g: 0.05, b: 0.03, a: 0 }

      const result = getClosestFragmentCPU(buffer, width, 2, 2)
      expect(result.r).toBe(0.1)
      expect(result.g).toBe(0.05)
      expect(result.b).toBe(0.03)

      log('closest-neighbor', { resultR: result.r })
    })

    test('clamps at texture boundary (top-left corner)', () => {
      const width = 3
      const buffer = Array.from({ length: 9 }, () => ({
        r: 100,
        g: 0,
        b: 0,
        a: 0
      }))
      buffer[0] = { r: 1, g: 0, b: 0, a: 0 }

      // Query (0,0): only 4 neighbors are in bounds (center + right + down + diag)
      const result = getClosestFragmentCPU(buffer, width, 0, 0)
      expect(result.r).toBe(1)

      log('closest-boundary', { resultR: result.r })
    })

    test('all equal depths returns any (the first encountered)', () => {
      const width = 3
      const buffer = Array.from({ length: 9 }, () => ({
        r: 42,
        g: 0.1,
        b: 0.2,
        a: 0
      }))

      const result = getClosestFragmentCPU(buffer, width, 1, 1)
      expect(result.r).toBe(42)

      log('closest-equal', { resultR: result.r })
    })

    test('sentinel 1e5 is returned when buffer is empty', () => {
      const result = getClosestFragmentCPU([], 0, 0, 0)
      expect(result.r).toBe(1e5)

      log('closest-empty', { resultR: result.r })
    })
  })

  test('WGSL uses per-pixel bilinear clipping only for upscale', async () => {
    const [upscale, antialiasing] = await Promise.all([
      compileResolve(true),
      compileResolve(false)
    ])
    const upscaleSamples = (upscale.match(/textureSample/g) ?? []).length
    const antialiasingSamples = (antialiasing.match(/textureSample/g) ?? [])
      .length
    const upscaleDimensions = (upscale.match(/textureDimensions/g) ?? []).length
    const antialiasingDimensions = (
      antialiasing.match(/textureDimensions/g) ?? []
    ).length

    log('variance-clipping-variants', [
      {
        variant: 'upscale',
        textureDimensions: upscaleDimensions,
        textureSamples: upscaleSamples
      },
      {
        variant: 'antialiasing',
        textureDimensions: antialiasingDimensions,
        textureSamples: antialiasingSamples
      }
    ])
    expect(upscaleDimensions).toBeGreaterThan(antialiasingDimensions)
    expect(upscaleSamples).toBeGreaterThanOrEqual(antialiasingSamples)
  })

  test.each([true, false])(
    'history and clipping samples are derivative-free, upscale=%s',
    async upscale => {
      const fragment = await compileResolve(upscale)
      const implicit = (fragment.match(/textureSample\(/g) ?? []).length
      const explicit = (fragment.match(/textureSampleLevel\(/g) ?? []).length
      log('conditional resolve sampling', { upscale, implicit, explicit })
      expect(implicit).toBe(0)
      expect(explicit).toBeGreaterThan(0)
    }
  )
})
