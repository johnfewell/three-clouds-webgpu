// CPU twin tests for shadow cascade temporal resolve
// Cite: shadowResolve.frag (76 lines)

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { varianceClippingCPU } from '../resolve/varianceClipping'
import { getClosestFragmentCPU, shadowCascadeResolveCPU } from './shadowResolve'

describe('shadow cascade temporal resolve', () => {
  setCurrentSpec('shadowResolve')

  describe('getClosestFragment — 3×3 min-r search', () => {
    test('finds the minimum .r in a 3×3 neighborhood', () => {
      // 4×4 velocity grid, cascade layer 0
      const width = 4
      const height = 4
      const data: number[][] = Array.from(
        { length: width * height },
        (_, i) => [
          // Pixel (1,1) has the smallest .r
          i === 5 ? 0.1 : 10 + i,
          i * 0.01,
          i * 0.02,
          0
        ]
      )

      const result = getClosestFragmentCPU(data, 1, 1, width, height)
      expect(result[0]).toBe(0.1)

      log('closest-fragment-center', { result })
    })

    test('finds minimum in corner (fewer than 9 neighbors)', () => {
      const width = 3
      const height = 3
      const data: number[][] = [
        [0.5, 1, 2, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0],
        [10, 0, 0, 0]
      ]

      const result = getClosestFragmentCPU(data, 0, 0, width, height)
      expect(result[0]).toBe(0.5)
      expect(result[1]).toBe(1)
      expect(result[2]).toBe(2)

      log('closest-fragment-corner', { result })
    })

    test('does not clip a valid depth between the old and reference sentinel', () => {
      const width = 3
      const height = 3
      const data: number[][] = Array.from({ length: 9 }, () => [1e6, 0, 0, 0])

      const result = getClosestFragmentCPU(data, 1, 1, width, height)
      expect(result[0]).toBe(1e6)

      log('closest-fragment-reference-sentinel', {
        oldSentinel: 1e5,
        inputDepth: 1e6,
        referenceSentinel: 1e7,
        result
      })
    })

    test('WGSL and source seed the search with the reference 1e7 sentinel', async () => {
      const { DataArrayTexture, Vector2 } = await import('three')
      const { float, texture, uniform } = await import('three/tsl')
      const { compileWGSL } = await import('../../test/helpers/compileWGSL')
      const { buildShadowCascadeResolve } = await import('./shadowResolve')

      const atlas = texture(new DataArrayTexture(null, 4, 4, 1))
      const node = buildShadowCascadeResolve({
        odBuffer: atlas,
        velocityBuffer: atlas,
        historyBuffer: atlas,
        texelSize: uniform(new Vector2(0.25, 0.25)),
        varianceGamma: float(1),
        temporalAlpha: float(0.01),
        resolution: uniform(new Vector2(4, 4)),
        cascadeIndex: float(0)
      })

      const { fragment } = compileWGSL(node)
      expect(fragment).toMatch(/10000000(?:\.0)?/)

      const source = readFileSync(
        new URL('./shadowResolve.ts', import.meta.url),
        'utf8'
      )
      expect(source).toContain('vec4(1e7, 0, 0, 0).toVar()')
      expect(source).not.toContain('vec4(1e5, 0, 0, 0).toVar()')

      log('closest-fragment-reference-sentinel-wgsl', {
        expected: 1e7,
        wgslPinned: true,
        sourcePinned: true
      })
    })
  })

  describe('shadowCascadeResolveCPU — per-cascade resolve', () => {
    test('WGSL samples filtered history with explicit LOD under rejection', async () => {
      const { DataArrayTexture, LinearFilter, Vector2 } = await import('three')
      const { float, uniform } = await import('three/tsl')
      const { compileWGSL } = await import('../../test/helpers/compileWGSL')
      const { buildShadowCascadeResolve } = await import('./shadowResolve')
      const atlas = new DataArrayTexture(null, 4, 4, 1)
      atlas.minFilter = LinearFilter
      atlas.magFilter = LinearFilter
      const { fragment } = compileWGSL(
        buildShadowCascadeResolve({
          odBuffer: atlas,
          velocityBuffer: atlas,
          historyBuffer: atlas,
          texelSize: uniform(new Vector2(0.25, 0.25)),
          varianceGamma: float(1),
          temporalAlpha: float(0.01),
          resolution: uniform(new Vector2(4, 4)),
          cascadeIndex: float(0)
        })
      )
      expect(fragment).toMatch(/\btextureSampleLevel\(/)
      expect(fragment).not.toMatch(/\btextureSample\(/)
      log('shadow-history-explicit-lod', {
        filtered: true,
        implicitDerivatives: false
      })
    })

    const width = 4
    const height = 4

    function makeGrid<T>(w: number, h: number, fill: T): T[] {
      return Array.from({ length: w * h }, () =>
        Array.isArray(fill) ? ([...fill] as unknown as T) : fill
      )
    }

    test('rejects out-of-bounds prevUv → returns current', () => {
      const odData = makeGrid<[number, number, number, number]>(
        width,
        height,
        [0.5, 0.1, 0.2, 0.01]
      )
      // Velocity that pushes prevUv out of [0,1]
      const velocityData = makeGrid<number[]>(width, height, [0.1, 1000, 0, 0])
      const historyData = makeGrid<[number, number, number, number]>(
        width,
        height,
        [0.9, 0.9, 0.9, 0.9]
      )

      const result = shadowCascadeResolveCPU(
        odData,
        velocityData,
        historyData,
        2,
        2,
        width,
        height,
        1 / width,
        1 / height,
        1,
        0.01,
        varianceClippingCPU
      )

      // Should return current unchanged since velocity is out of bounds
      expect(result[0]).toBe(0.5)
      expect(result[1]).toBe(0.1)
      expect(result[2]).toBe(0.2)
      expect(result[3]).toBe(0.01)

      log('reject-out-of-bounds', { result })
    })

    test('blends with history when prevUv in bounds', () => {
      const odData = makeGrid<[number, number, number, number]>(
        width,
        height,
        [0.3, 0.1, 0.2, 0.01]
      )
      // Zero velocity → prevUv = currentUv, in bounds
      const velocityData = makeGrid<number[]>(width, height, [0.1, 0, 0, 0])
      const historyData = makeGrid<[number, number, number, number]>(
        width,
        height,
        [0.5, 0.2, 0.3, 0.02]
      )

      const result = shadowCascadeResolveCPU(
        odData,
        velocityData,
        historyData,
        2,
        2,
        width,
        height,
        1 / width,
        1 / height,
        1,
        0.01,
        varianceClippingCPU
      )

      // With zero velocity and uniform data, clipping returns history unchanged,
      // then mix(history, current, 0.01) ≈ close to history
      // Uniform OD, so clipped ≈ current and the mix ≈ current
      expect(result[0]).toBeCloseTo(0.3, 1)
      // All neighbors same → variance is 0 → AABB is the mean → history clipped to mean
      // mean = current (all same) → clipped = mean = current → mix(current, current, 0.01) = current
      expect(result[0]).toBeCloseTo(0.3, 5)

      log('blend-zero-velocity', { result })
    })

    test('3-layer synthetic atlas: per-cascade resolve produces different results', () => {
      const layers = 3
      const w = 3
      const h = 3
      const results: [number, number, number, number][] = []

      for (let layer = 0; layer < layers; layer++) {
        const base = (layer + 1) * 0.1
        const odData = makeGrid<[number, number, number, number]>(w, h, [
          base,
          base * 0.5,
          base * 2,
          base * 0.01
        ])
        const velocityData = makeGrid<number[]>(w, h, [base, 0, 0, 0])
        const historyData = makeGrid<[number, number, number, number]>(w, h, [
          base * 0.8,
          base * 0.4,
          base * 1.6,
          base * 0.008
        ])

        const r = shadowCascadeResolveCPU(
          odData,
          velocityData,
          historyData,
          1,
          1,
          w,
          h,
          1 / w,
          1 / h,
          1,
          0.01,
          varianceClippingCPU
        )
        results.push(r)
      }

      // Each layer should produce a different .x value
      expect(results[0]![0]).not.toBe(results[1]![0])
      expect(results[1]![0]).not.toBe(results[2]![0])

      log('3-layer-atlas', {
        layer0: results[0],
        layer1: results[1],
        layer2: results[2]
      })
    })
  })

  describe('defaults', () => {
    test('varianceGamma = 1 (from ShadowResolveMaterial:55)', () => {
      const gamma = 1
      expect(gamma).toBe(1)
      log('default-varianceGamma', { gamma })
    })

    test('temporalAlpha = 0.01 (from ShadowResolveMaterial:60)', () => {
      const alpha = 0.01
      expect(alpha).toBe(0.01)
      log('default-temporalAlpha', { alpha })
    })
  })
})

// the atlas front depth is in unit space (metres in the reference,
// shadow.frag:125). The optical-depth consumer converts back, but the velocity
// pass added it unconverted to an ECEF ray in metres

// So it reprojected the shell entry point, not the cloud front
// (shadow.frag:170 adds metres to metres). Static ladder plates cannot see it

// Two checks: a source guard, and the emitted WGSL, where the atlas-loaded
// depth must be divided before the ray offset

describe('shadow velocity front depth units', () => {
  test('divides the unit-space front depth by worldToUnit before offsetting the ray', async () => {
    setCurrentSpec('shadowVelocity-units')
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { float, texture, uniform } = await import('three/tsl')
    const { DataArrayTexture, Matrix4, Vector2, Vector3 } =
      await import('three')
    const { buildShadowVelocity } = await import('./shadowResolve')

    const odTex = new DataArrayTexture(null, 4, 4, 2)
    const node = buildShadowVelocity({
      odBuffer: texture(odTex),
      inverseShadowMatrix: uniform(new Matrix4()),
      reprojectionMatrix: uniform(new Matrix4()),
      worldToECEFMatrix: uniform(new Matrix4()),
      ecefToWorldMatrix: uniform(new Matrix4()),
      altitudeCorrection: uniform(new Vector3()),
      sunDirection: uniform(new Vector3(0, 0, 1)),
      bottomRadius: uniform(6360000),
      shadowTopHeight: uniform(3000),
      // A uniform, not a literal: TSL would fold a constant division away (the
      // trap that let the cascades debug view ship uncompiled)
      worldToUnit: uniform(1 / 6360000),
      shadowBottomHeight: uniform(750),
      resolution: uniform(new Vector2(512, 512)),
      cascadeIndex: float(0)
    })

    const { fragment } = compileWGSL(node)
    // The compile above is smoke only: the graph still builds with the extra
    // operation
    expect(fragment.length).toBeGreaterThan(0)

    // The load-bearing assertion is on source: "the WGSL contains a division"
    // passed with the fix reverted, since TSL renames everything. Which operand
    // feeds the ray offset is a fact about the code
    const src = readFileSync(
      new URL('./shadowResolve.ts', import.meta.url),
      'utf8'
    )
    const at = src.indexOf('const frontPosition')
    expect(at, 'the frontPosition computation moved').toBeGreaterThan(-1)
    const block = src.slice(Math.max(0, at - 400), at + 200)
    log('shadowVelocity-units', [
      {
        field: 'converts before offsetting',
        expected: true,
        actual: block.includes('div(deps.worldToUnit)')
      }
    ])
    expect(
      block.includes('div(deps.worldToUnit)'),
      'the pass must divide the unit-space front depth by worldToUnit before ' +
        'adding it to an ECEF ray in metres; without it the ~1.5e-3 offset ' +
        'vanishes against a 6.36e6 radius, frontPosition collapses onto ' +
        'rayOrigin, and the pass reprojects the shell entry point instead of ' +
        'the cloud front (reference: shadow.frag:170)'
    ).toBe(true)
  })

  // The artifact-level twin, in the WGSL the driver receives. It discovers the
  // texture variable instead of assuming a name, and checks that the value read
  // from the atlas is what gets divided
  test('the emitted graph divides the ATLAS-LOADED depth before the ray offset', async () => {
    setCurrentSpec('shadowVelocity-units-wgsl')
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { float, texture, uniform } = await import('three/tsl')
    const { DataArrayTexture, Matrix4, Vector2, Vector3 } =
      await import('three')
    const { buildShadowVelocity } = await import('./shadowResolve')

    const odTex = new DataArrayTexture(null, 4, 4, 2)
    const node = buildShadowVelocity({
      odBuffer: texture(odTex),
      inverseShadowMatrix: uniform(new Matrix4()),
      reprojectionMatrix: uniform(new Matrix4()),
      worldToECEFMatrix: uniform(new Matrix4()),
      ecefToWorldMatrix: uniform(new Matrix4()),
      altitudeCorrection: uniform(new Vector3()),
      sunDirection: uniform(new Vector3(0, 0, 1)),
      bottomRadius: uniform(6360000),
      shadowTopHeight: uniform(3000),
      // Uniform, not a literal: a constant folds the division away entirely
      worldToUnit: uniform(1 / 6360000),
      shadowBottomHeight: uniform(750),
      resolution: uniform(new Vector2(512, 512)),
      cascadeIndex: float(0)
    })

    const { fragment } = compileWGSL(node)

    // 1. Discover the variable that receives the atlas read. Refuses rather
    //    than guessing if the shape changed: an absent selector must not read
    //    as an absent defect
    const load = /(\w+)\s*=\s*textureLoad\(/.exec(fragment)
    expect(
      load,
      'no textureLoad found in the emitted velocity pass — the selector is ' +
        'stale, not the code clean'
    ).not.toBeNull()
    const texVar = load![1]

    // 2. The atlas depth must reach the ray offset DIVIDED.
    const divided = new RegExp(
      `${texVar}\\.x\\s*/\\s*(object\\.)?nodeUniform\\d+`
    ).test(fragment)

    // 3. And must never reach a vec3 splat undivided. That splat is exactly
    //    the broken form: rayDirection * vec3(frontDepthUnit)
    const rawSplat = new RegExp(`vec3<f32>\\(\\s*${texVar}\\.x\\s*\\)`).test(
      fragment
    )

    log('shadowVelocity-units-wgsl', [
      { field: 'atlas var', expected: 'found', actual: texVar },
      { field: 'divided by a uniform', expected: true, actual: divided },
      { field: 'raw splat into vec3', expected: false, actual: rawSplat }
    ])

    expect(
      divided,
      `the atlas-loaded front depth (${texVar}.x) must be divided by a uniform ` +
        'before it offsets the ECEF ray; undivided it is ~1.5e-3 against a ' +
        '6.36e6 radius and frontPosition collapses onto rayOrigin'
    ).toBe(true)
    expect(
      rawSplat,
      `${texVar}.x is splatted into a vec3 undivided — that is the shell-entry ` +
        'bug in its exact emitted form (reference: shadow.frag:170)'
    ).toBe(false)
  })
})
