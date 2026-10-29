// The cirrus deck: where a ray meets it, how blurred it is read, how it stacks
// with the marched clouds, and that the shader reads it derivative-free. The
// geometry and composite twins are what the WGSL structure checks stand on

import { PerspectiveCamera, Texture } from 'three'
import { Fn, uniform, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import { splitIlluminance } from '../lighting/sunSkyLight'
import {
  CIRRUS_DECK_MIN_COSINE,
  cirrusDeckDefaults,
  cirrusDeckDistanceCPU,
  cirrusDeckLodCPU,
  createCirrusDeckComposite,
  createCirrusDeckUniforms,
  overCPU,
  pixelAngle,
  updateCirrusDeckUniforms
} from './cirrusDeck'
import { experimentalDefaults } from './options'

const R = 6360000
const ALT = cirrusDeckDefaults.altitude
const DECK = R + ALT
const UP = [0, 0, 1] as const
const DOWN = [0, 0, -1] as const
const HORIZONTAL = [1, 0, 0] as const

const at = (height: number) => [0, 0, R + height] as const

describe('cirrus deck geometry', () => {
  it('sits overhead at its altitude above a camera on the ground', () => {
    const t = cirrusDeckDistanceCPU(at(100), UP, DECK, R, 0)
    expectClose(t, ALT - 100, { abs: 1e-6, label: 'overhead' })
  })

  it('reaches the horizon at the tangent distance, not infinity', () => {
    // From the ground a level ray leaves the deck sphere at sqrt(D^2 - R^2)
    const t = cirrusDeckDistanceCPU(at(0), HORIZONTAL, DECK, R, 0)
    const expected = Math.sqrt(DECK * DECK - R * R)
    table('cirrus-horizon', [
      { field: 'level ray, km', expected: expected / 1000, actual: t / 1000 }
    ])
    expectClose(t, expected, { rel: 1e-9 })
  })

  it('is hidden by the ground and by scene geometry in front of it', () => {
    expect(cirrusDeckDistanceCPU(at(100), DOWN, DECK, R, 0)).toBe(-1)
    // A building 300 m away hides the deck, one beyond the deck does not
    expect(cirrusDeckDistanceCPU(at(100), UP, DECK, R, 300)).toBe(-1)
    expect(cirrusDeckDistanceCPU(at(100), UP, DECK, R, 50000)).toBe(ALT - 100)
  })

  it('shares the march horizon for a camera just under the ground sphere', () => {
    // The altitude correction can leave the camera a little under bottomRadius
    // A ground test that needs a root in front of the camera then misses, and
    // the deck shows through the ground from the far side of the planet
    const below = [0, 0, R - 50] as const
    const dip = [Math.cos(0.05), 0, -Math.sin(0.05)] as const
    expect(cirrusDeckDistanceCPU(below, dip, DECK, R, 0)).toBe(-1)
    expect(cirrusDeckDistanceCPU(below, UP, DECK, R, 0)).toBeGreaterThan(0)
  })

  it('is seen from above as its top face, and not looking away from it', () => {
    const above = 15000
    expectClose(
      cirrusDeckDistanceCPU(at(above), DOWN, DECK, R, 0),
      above - ALT,
      { abs: 1e-6, label: 'from above' }
    )
    expect(cirrusDeckDistanceCPU(at(above), UP, DECK, R, 0)).toBe(-1)
  })
})

describe('cirrus deck texture LOD', () => {
  it('reads the base level up close and blurs with distance and slant', () => {
    // 1080 rows at 60 degrees, the default 512 texels over 40 km
    const camera = new PerspectiveCamera(60, 16 / 9, 1, 1e7)
    const lodScale = (pixelAngle(camera, 1080) * 512) / 40000
    const overhead = cirrusDeckLodCPU(ALT, 1, lodScale)
    const far = cirrusDeckLodCPU(200000, 0.1, lodScale)
    const grazing = cirrusDeckLodCPU(350000, 0, lodScale)
    table('cirrus-lod', [
      { field: 'overhead 10 km', expected: 0, actual: overhead },
      { field: '200 km at cos 0.1', expected: '>0', actual: far },
      { field: 'grazing is finite', expected: '<12', actual: grazing }
    ])
    expect(overhead).toBe(0)
    expect(far).toBeGreaterThan(0)
    expect(Number.isFinite(grazing)).toBe(true)
    // The slant floor is what keeps the grazing read finite
    expect(grazing).toBe(
      cirrusDeckLodCPU(350000, CIRRUS_DECK_MIN_COSINE, lodScale)
    )
  })

  it('takes the pixel angle from the projection, 0 for no perspective', () => {
    const camera = new PerspectiveCamera(60, 1, 1, 10)
    expectClose(pixelAngle(camera, 1000), (2 * Math.tan(Math.PI / 6)) / 1000, {
      rel: 1e-6
    })
    expect(pixelAngle(camera, 0)).toBe(0)
  })
})

describe('cirrus deck composite', () => {
  it('stacks behind a cloud: an opaque cloud hides it, a gap shows it', () => {
    const deck = [0.3, 0.3, 0.3, 0.5] as const
    expect(overCPU([1, 1, 1, 1], deck)).toEqual([1, 1, 1, 1])
    expect(overCPU([0, 0, 0, 0], deck)).toEqual([...deck])
    // Half a cloud lets half the deck through, alpha included
    const half = overCPU([0.2, 0.2, 0.2, 0.5], deck)
    expectClose(half, [0.35, 0.35, 0.35, 0.75], { abs: 1e-12 })
  })
})

describe('cirrus deck uniforms', () => {
  it('derives tiling, a wrapped drift and the texture from the knobs', () => {
    const fallback = new Texture()
    fallback.image = { width: 512, height: 512 }
    const uniforms = createCirrusDeckUniforms(fallback)
    const camera = new PerspectiveCamera(60, 1, 1, 10)
    const params = { ...cirrusDeckDefaults, velocityU: 10, velocityV: -10 }
    const frame = { bottomRadius: R, time: 6000, height: 1080, camera }
    updateCirrusDeckUniforms(uniforms, params, frame, fallback)
    const repeat = ((Math.PI / 2) * DECK) / params.scale
    table('cirrus-uniforms', [
      { field: 'repeat', expected: repeat, actual: uniforms.repeat.value },
      { field: 'offset u', expected: 0.5, actual: uniforms.offset.value.x },
      { field: 'offset v', expected: 0.5, actual: uniforms.offset.value.y }
    ])
    expectClose(uniforms.repeat.value, repeat, { rel: 1e-12 })
    // 60 km of drift is 1.5 tiles, wrapped to the half tile it shows
    expectClose(uniforms.offset.value.x, 0.5, { abs: 1e-9 })
    expectClose(uniforms.offset.value.y, 0.5, { abs: 1e-9 })
    expect(uniforms.map.value).toBe(fallback)
    const custom = new Texture()
    updateCirrusDeckUniforms(
      uniforms,
      { ...params, texture: custom, strength: 0 },
      frame,
      fallback
    )
    expect(uniforms.map.value).toBe(custom)
    expect(uniforms.strength.value).toBe(0)
  })

  it('ships off', () => {
    expect(experimentalDefaults.cirrusDeck).toBe(false)
  })
})

// The composite on stubs: constant light, an aerial perspective that passes the
// colour through. What it pins is the WGSL shape, not the atmosphere
function compileComposite(): string {
  const fallback = new Texture()
  fallback.image = { width: 512, height: 512 }
  const composite = createCirrusDeckComposite({
    uniforms: createCirrusDeckUniforms(fallback),
    bottomRadius: uniform(R),
    sunDirection: vec3(0, 0, 1),
    getSunSkyIrradiance: () => splitIlluminance(vec3(1), vec3(0.1)),
    applyAerialPerspective: (_c, _f, _s, color: Node<'vec4'>) => color,
    scatterAnisotropy1: 0.7,
    scatterAnisotropy2: -0.2,
    scatterAnisotropyMix: 0.5
  })
  const out = Fn(() =>
    composite(
      vec3(0, 0, R + 100),
      vec3(0, 0, 1),
      uniform(0),
      uniform(0),
      vec4(0),
      uniform(0),
      uniform(0)
    )
  )()
  return compileWGSL(out).fragment
}

describe('cirrus deck WGSL', () => {
  it('reads its texture once, at an explicit LOD, with no derivatives', () => {
    const wgsl = compileComposite()
    const levels = (wgsl.match(/textureSampleLevel\(/g) ?? []).length
    const implicit = (wgsl.match(/textureSample\(/g) ?? []).length
    const derivatives = (wgsl.match(/dpdx|dpdy|fwidth/g) ?? []).length
    table('cirrus-wgsl', [
      { field: 'textureSampleLevel', expected: 1, actual: levels },
      { field: 'implicit textureSample', expected: 0, actual: implicit },
      { field: 'derivatives', expected: 0, actual: derivatives }
    ])
    // An implicit sample inside non-uniform flow returns zeros on Dawn, which
    // reads as "the deck is off"
    expect(levels).toBe(1)
    expect(implicit).toBe(0)
    expect(derivatives).toBe(0)
  })
})
