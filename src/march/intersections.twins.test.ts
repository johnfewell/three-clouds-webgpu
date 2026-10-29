// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: clouds.frag:730-741, core shaders/raySphereIntersection.glsl:108-124
// CPU twin of the core raySpheresIntersections for the four cloud shells. It
// masked only .x/.y before fork release 4, so four lanes is the claim

import { vec3, vec4 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { raySpheresIntersections } from '@takram/three-geospatial/webgpu'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'

type V3 = [number, number, number]
type V4 = [number, number, number, number]

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
// Transcribed from the core FnVar body (webgpu/math.ts): `b = dot(dir, rayOrigin -
// center)`, `Q = sqrt(max(b^2 - (dot(a,a) - r^2), 0))`, `near = mask*(-b - Q) -
// inverseMask`. That last term is what makes a miss read as -1, not 0
function cpuShellIntersections(
  rayOrigin: V3,
  rayDirection: V3,
  center: V3,
  radii: V4
): { near: V4; far: V4 } {
  const a: V3 = [
    rayOrigin[0] - center[0],
    rayOrigin[1] - center[1],
    rayOrigin[2] - center[2]
  ]
  const b = dot(rayDirection, a)
  const aa = dot(a, a)
  const near: V4 = [0, 0, 0, 0]
  const far: V4 = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const r = radii[i]!
    const discriminant = b * b - (aa - r * r)
    const hit = discriminant >= 0 ? 1 : 0
    const Q = Math.sqrt(Math.max(discriminant, 0))
    near[i] = hit * (-b - Q) - (1 - hit)
    far[i] = hit * (-b + Q) - (1 - hit)
  }
  return { near, far }
}

const SURFACE = 6371000
// The observer is ABOVE the surface looking down and each shell is a sphere
// centred on the planet with a cloud-deck radius, so a downward ray enters lane
// k at `observerRadius - deckRadius[k]`
const ALTITUDE = 10_000
const ABOVE: V3 = [0, SURFACE + ALTITUDE, 0]
const entry = (deckRadius: number): number => SURFACE + ALTITUDE - deckRadius
// 3 000 000 km to the side: a ray along y cannot come within a few thousand km
const MISS_CENTRE: V3 = [3_000_000, 0, 0]
const DOWN: V3 = [0, -1, 0]
const CENTRE: V3 = [0, 0, 0]

describe('raySpheresIntersections on four shell radii, CPU twin', () => {
  setCurrentSpec('shellIntersections-twin')

  it('a downward ray enters each shell at SURFACE - radius, in lane order', () => {
    const decks: V4 = [
      SURFACE - 3000,
      SURFACE - 1000,
      SURFACE - 200,
      SURFACE - 100
    ]
    const out = cpuShellIntersections(ABOVE, DOWN, CENTRE, decks)
    log('shellIntersections-down', {
      near: out.near.map(n => n.toFixed(1))
    })
    // the smallest deck's shell starts nearest the centre, so it is entered
    // LAST: the near roots descend across the lanes
    expect(out.near[3]).toBeCloseTo(entry(decks[3]), 0)
    expect(out.near[3]).toBeLessThan(out.near[2])
    expect(out.near[2]).toBeLessThan(out.near[1])
    expect(out.near[1]).toBeLessThan(out.near[0])
  })

  it('computes FOUR lanes, and a miss leaves that lane at -1', () => {
    // lane 2's shell is centred far off the ray line, so only that lane misses
    // With the core helper's .x/.y only, lanes 2 and 3 would BOTH read as
    // misses and two cloud decks would vanish
    const out = cpuShellIntersections(ABOVE, DOWN, MISS_CENTRE, [
      SURFACE,
      SURFACE,
      SURFACE,
      SURFACE
    ])
    log('shellIntersections-four-lanes', {
      near: out.near.map(n => n.toFixed(1))
    })
    // the offset centre is 3e6 km away, so a 6.371e6 km shell still contains
    // the observer, a 1e5 km shell cannot
    const partial = cpuShellIntersections(ABOVE, DOWN, MISS_CENTRE, [
      SURFACE,
      SURFACE,
      1e5,
      SURFACE
    ])
    log('shellIntersections-partial', {
      near: partial.near.map(n => n.toFixed(1))
    })
    expect(partial.near[2]).toBe(-1)
    expect(partial.near[0]).toBeGreaterThan(0)
    expect(partial.near[1]).toBeGreaterThan(0)
    expect(partial.near[3]).toBeGreaterThan(0)
    expect(out.near.every(n => n >= 0)).toBe(true)
  })

  it('the near root is the entry and the far root the exit', () => {
    const deck = SURFACE - 1000
    const out = cpuShellIntersections(ABOVE, DOWN, CENTRE, [
      deck,
      1e9,
      1e9,
      1e9
    ])
    log('shellIntersections-roots', {
      near: out.near[0]?.toFixed(1),
      far: out.far[0]?.toFixed(1)
    })
    expect(out.far[0]).toBeGreaterThan(out.near[0])
    // the chord through a concentric shell is 2*deck long
    expect(out.near[0]).toBeCloseTo(entry(deck), 0)
    expect(out.far[0]).toBeCloseTo(entry(deck) + 2 * deck, 0)
  })

  it('a ray whose line misses the shell reports a miss in every lane', () => {
    const out = cpuShellIntersections(
      ABOVE,
      DOWN,
      MISS_CENTRE,
      [1e5, 1e5, 1e5, 1e5]
    )
    log('shellIntersections-miss-all', { near: out.near })
    for (const lane of out.near) expect(lane).toBe(-1)
  })

  it('a miss reads as exactly -1, not 0', () => {
    // the `- inverseMask` term in the Fn. A miss reported as 0 is zero metres,
    // which reads as "the surface is right here"
    const out = cpuShellIntersections(
      ABOVE,
      DOWN,
      MISS_CENTRE,
      [1e5, 1e5, 1e5, 1e5]
    )
    log('shellIntersections-miss-sentinel', { near: out.near })
    for (const lane of out.near) expect(lane).toBe(-1)
  })

  it('the graph carries the per-lane mask and the -1 sentinel the twin reads', () => {
    // A CPU twin cannot catch a WGSL-only change: it never runs the graph
    // Replacing the mask with a constant 1 leaves every arithmetic test above
    // green, so this is what ties the two halves together
    const { fragment } = compileWGSL(
      raySpheresIntersections(
        vec3(ABOVE[0], ABOVE[1], ABOVE[2]),
        vec3(0, -1, 0),
        vec3(MISS_CENTRE[0], MISS_CENTRE[1], MISS_CENTRE[2]),
        vec4(1e5, 1e5, 1e5, 1e5)
      ).get('near')
    )
    // three emits `nodeVar2 >= vec4<f32>( 0.0 )`, a VECTOR zero. An assertion
    // written as `/>=\s*0/` matches a scalar form and fails on the real one
    const compares = />=\s*vec4<f32>\(\s*0\.0\s*\)/.test(fragment)
    // the inverse-mask construction `vec4(1.0) - mask` plus a subtraction of it
    // Dropping `.sub(inverseMask)` leaves the construction dead and the
    // subtraction gone
    const inverse = /(\w+)\s*=\s*\(\s*vec4<f32>\(\s*1\.0\s*\)\s*-\s*\w+/.exec(
      fragment
    )
    log('shellIntersections-mask-in-graph', {
      compares,
      inverseMaskVar: inverse?.[1] ?? ''
    })
    expect(compares).toBe(true)
    expect(inverse).not.toBeNull()
    // the same variable must be SUBTRACTED inside the struct's two root
    // expressions, which is what turns a miss into -1
    expect(new RegExp(`-\\s*${inverse![1]}\\s*\\)`).test(fragment)).toBe(true)
  })

  it('the graph guards the discriminant with max before the sqrt', () => {
    const { fragment } = compileWGSL(
      raySpheresIntersections(
        vec3(ABOVE[0], ABOVE[1], ABOVE[2]),
        vec3(0, -1, 0),
        vec3(0, 0, 0),
        vec4(SURFACE - 3000, SURFACE - 1000, SURFACE - 200, SURFACE - 100)
      ).get('near')
    )
    const twin = cpuShellIntersections(ABOVE, DOWN, CENTRE, [
      SURFACE - 3000,
      SURFACE - 1000,
      SURFACE - 200,
      SURFACE - 100
    ])
    // the discriminant is the value the mask compares, and the guard must
    // clamp that same value before the sqrt
    const discriminant =
      /(\w+)\s*>=\s*vec4<f32>\(\s*0\.0\s*\)/.exec(fragment)?.[1] ?? ''
    const guarded = new RegExp(
      `sqrt\\(\\s*max\\(\\s*${discriminant}\\s*,\\s*vec4<f32>\\(\\s*0\\.0\\s*\\)\\s*\\)\\s*\\)`
    ).test(fragment)
    log('shellIntersections-fn-vs-twin', {
      discriminant,
      guarded,
      twinHits: twin.near.filter(n => n >= 0).length
    })
    // node cannot run WGSL, so the twin and the graph are tied together
    // structurally: both guard the discriminant, and both produce four lanes
    expect(discriminant).not.toBe('')
    expect(guarded).toBe(true)
    expect(twin.near.filter(n => n >= 0).length).toBe(4)
  })
})
