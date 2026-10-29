// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import type { Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { log } from '../../test/helpers/log'
import {
  applyAerialPerspectiveCPU,
  shadowLengthToAttachmentCPU,
  shadowLengthToPointCPU
} from './aerialPerspective'

describe('applyAerialPerspectiveCPU', () => {
  it('identity transmittance + zero inscatter → unchanged color', () => {
    const result = applyAerialPerspectiveCPU(
      [0.5, 0.3, 0.1],
      0.8,
      [1, 1, 1],
      [0, 0, 0]
    )
    expect(result[0]).toBeCloseTo(0.5)
    expect(result[1]).toBeCloseTo(0.3)
    expect(result[2]).toBeCloseTo(0.1)
    expect(result[3]).toBe(0.8)
  })

  it('zero transmittance → only inscatter scaled by opacity', () => {
    const result = applyAerialPerspectiveCPU(
      [0.5, 0.3, 0.1],
      0.6,
      [0, 0, 0],
      [1, 0.5, 0.25]
    )
    expect(result[0]).toBeCloseTo(0.6)
    expect(result[1]).toBeCloseTo(0.3)
    expect(result[2]).toBeCloseTo(0.15)
    expect(result[3]).toBe(0.6)
  })

  it('inscatter is multiplied by opacity (ADR-002 associated color)', () => {
    const opacity = 0.5
    const result = applyAerialPerspectiveCPU(
      [0, 0, 0],
      opacity,
      [0, 0, 0],
      [1, 1, 1]
    )
    expect(result[0]).toBeCloseTo(opacity)
    expect(result[1]).toBeCloseTo(opacity)
    expect(result[2]).toBeCloseTo(opacity)
  })

  it('preserves opacity unchanged', () => {
    const result = applyAerialPerspectiveCPU(
      [0.9, 0.8, 0.7],
      0.42,
      [0.5, 0.5, 0.5],
      [0.1, 0.2, 0.3]
    )
    expect(result[3]).toBe(0.42)
  })

  it('per-channel transmittance works independently', () => {
    const result = applyAerialPerspectiveCPU(
      [1, 1, 1],
      1,
      [0.9, 0.5, 0.1],
      [0, 0, 0]
    )
    expect(result[0]).toBeCloseTo(0.9)
    expect(result[1]).toBeCloseTo(0.5)
    expect(result[2]).toBeCloseTo(0.1)
  })

  it('zero opacity → only transmittance applied, no inscatter', () => {
    const result = applyAerialPerspectiveCPU(
      [1, 1, 1],
      0,
      [0.5, 0.5, 0.5],
      [10, 10, 10]
    )
    expect(result[0]).toBeCloseTo(0.5)
    expect(result[1]).toBeCloseTo(0.5)
    expect(result[2]).toBeCloseTo(0.5)
  })
})

describe('applyAerialPerspective — WGSL compilation', () => {
  it('compiles to WGSL with mock dependency', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const {
      Fn: tslFn,
      context: tslContext,
      float,
      struct,
      vec3,
      vec4
    } = await import('three/tsl')
    const { AtmosphereContext } =
      await import('@takram/three-atmosphere/webgpu')
    // The unit conversion reads the atmosphere from the builder context
    const atmosphereContext = () => {
      const atmosphere = new AtmosphereContext()
      return tslContext({
        getAtmosphere: () => atmosphere,
        getClouds: () => ({})
      })
    }
    const { createApplyAerialPerspective } = await import('./aerialPerspective')

    const luminanceTransfer = struct(
      { luminance: 'vec3', transmittance: 'vec3' },
      'MockLuminanceTransfer'
    )

    // The mock folds the shadow segment into the transmittance so the
    // compiled shader has to carry it: a constant vec2(0) would fold away
    const mockGetIndirect = tslFn(
      ([_camera, _point, shadowLength]: [
        Node<'vec3'>,
        Node<'vec3'>,
        Node<'vec2'>
      ]) => {
        return luminanceTransfer(
          vec3(0.1, 0.1, 0.1),
          vec3(0.9, 0.9, 0.9).mul(shadowLength.x.add(shadowLength.y))
        )
      }
    )

    const applyAerial = createApplyAerialPerspective(mockGetIndirect)

    const node = tslFn(() => {
      return applyAerial(
        vec3(0, 0, 6371000),
        vec3(0, 0, 6381000),
        float(2500),
        vec4(0.5, 0.3, 0.1, 0.8)
      )
    })()

    const { fragment } = compileWGSL(node, { contextNode: atmosphereContext() })
    expect(fragment.length).toBeGreaterThan(0)
    expect(fragment).toContain('vec4')
    // The segment: min(shadowLength, ray) and ray − x, both survive into
    // the module rather than folding to zeros
    expect(fragment).toMatch(/min\(/)
    expect(fragment).toMatch(/distance\(/)
  })
})

// the scalar the march produces
// becomes the runtime's segment: the last shadowLength metres of the ray
// (Bruneton Eq. 17), capped at the ray, never negative
describe('shadowLengthToPointCPU', () => {
  it('puts the shadowed segment at the end of the ray', () => {
    expect(shadowLengthToPointCPU(10000, 2500)).toEqual([2500, 7500])
  })
  it('caps the segment at the ray', () => {
    expect(shadowLengthToPointCPU(10000, 12000)).toEqual([10000, 0])
  })
  it('zero shadow is the no-shadow branch of the runtime (x = 0)', () => {
    expect(shadowLengthToPointCPU(10000, 0)).toEqual([0, 10000])
  })
  it('never goes negative', () => {
    expect(shadowLengthToPointCPU(10000, -5)).toEqual([0, 10000])
  })
})

// on a geometry ray the shadowed interval is the last L of the ray
// (runtime.glsl:318-322, Eq. 17), so x + y = D. On a sky ray it starts at the
// camera (y = 0), Eq. 18. The old attachment wrote cameraNear into y on both
describe('shadowLengthToAttachmentCPU', () => {
  it('geometry ray: the segment ends at the surface (x + y = D)', () => {
    const [x, y] = shadowLengthToAttachmentCPU(2500, 10000)
    log('attachment-geometry', { x, y, sum: x + y, expectedSum: 10000 })
    expect([x, y]).toEqual([2500, 7500])
    expect(x + y).toBe(10000)
  })
  it('geometry ray matches the in-march accessor exactly', () => {
    for (const [l, d] of [
      [0, 800],
      [300, 800],
      [800, 800],
      [5000, 800]
    ] as const) {
      expect(shadowLengthToAttachmentCPU(l, d)).toEqual(
        shadowLengthToPointCPU(d, l)
      )
    }
  })
  it('geometry ray fully shadowed: capped at the ray, starting at the camera', () => {
    expect(shadowLengthToAttachmentCPU(12000, 10000)).toEqual([10000, 0])
  })
  it('sky ray: the shadow starts at the camera (y = 0)', () => {
    const [x, y] = shadowLengthToAttachmentCPU(2500, 0)
    log('attachment-sky', { x, y, expectedY: 0 })
    expect([x, y]).toEqual([2500, 0])
  })
  it('no shadow is the runtime no-shadow branch on both kinds of ray (x = 0)', () => {
    expect(shadowLengthToAttachmentCPU(0, 10000)).toEqual([0, 10000])
    expect(shadowLengthToAttachmentCPU(0, 0)).toEqual([0, 0])
  })
  it('never goes negative', () => {
    expect(shadowLengthToAttachmentCPU(-5, 0)).toEqual([0, 0])
    expect(shadowLengthToAttachmentCPU(-5, 10000)).toEqual([0, 10000])
  })
})

describe('shadowLengthToAttachment — WGSL (stage=emission)', () => {
  it('emits the geometry and sky segments the twin computes', async () => {
    const { uniform, vec4 } = await import('three/tsl')
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { shadowLengthToAttachment } = await import('./aerialPerspective')
    const l = uniform(2500).setName('shadowLength')
    const d = uniform(10000).setName('sceneRayDistance')
    const { fragment } = compileWGSL(vec4(shadowLengthToAttachment(l, d), 0, 1))
    const wgsl = fragment.replace(/\s+/g, ' ')
    const geometryTest = wgsl.includes(
      'if ( ( object.sceneRayDistance > 0.0 ) )'
    )
    const capped =
      /(\w+) = max\( min\( object\.shadowLength, object\.sceneRayDistance \), 0\.0 \);/.exec(
        wgsl
      )?.[1]
    const surfaceEnd =
      capped != null &&
      wgsl.includes(
        `vec2<f32>( ${capped}, ( object.sceneRayDistance - ${capped} ) )`
      )
    const skyStart = wgsl.includes(
      'vec2<f32>( max( object.shadowLength, 0.0 ), 0.0 )'
    )
    log('attachment-wgsl', { geometryTest, surfaceEnd, skyStart })
    expect(geometryTest, 'branches on the scene ray distance').toBe(true)
    expect(surfaceEnd, 'geometry: vec2(x, D - x)').toBe(true)
    expect(skyStart, 'sky: vec2(max(L, 0), 0)').toBe(true)
  })
})
