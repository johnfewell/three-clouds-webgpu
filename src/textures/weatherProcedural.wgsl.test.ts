// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: turbulence.frag, localWeather.frag:77-82
// Both Fns had a CPU twin in test/helpers/weatherTextureReference.ts and no WGSL
// snapshot, and `turbulence` unrolls to ~4700 node vars

import { vec2 } from 'three/tsl'
import { beforeEach, describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { localWeather } from './localWeather'
import { turbulence } from './turbulence'

// Every `clamp(` body in the fragment, matched by paren depth, outermost first
// A regex cannot do this: `clamp(` nests inside the Worley fbm's per-cell
// distance clamps, and the non-greedy form returns the innermost
function matchingClamps(fragment: string): string[] {
  const out: string[] = []
  for (let k = 0; k < fragment.length; k++) {
    if (!fragment.startsWith('clamp(', k)) continue
    let depth = 0
    let j = k + 5
    for (; j < fragment.length; j++) {
      if (fragment[j] === '(') depth++
      else if (fragment[j] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(fragment.slice(k + 6, j))
  }
  return out
}

describe('turbulence, WGSL', () => {
  beforeEach(() => setCurrentSpec('turbulence-wgsl'))

  it('compiles, and it is a large graph', () => {
    const { fragment } = compileWGSL(turbulence(vec2(0.3, 0.7)))
    log('turbulence-wgsl-size', {
      length: fragment.length,
      nodeVars: (fragment.match(/nodeVar\d+/g) ?? []).length
    })
    // the unrolled curl samples the perlin field six times, the graph is
    // thousands of nodes wide, and a collapse to a fraction of that is the
    // failure this test exists to notice
    expect(fragment.length).toBeGreaterThan(100000)
  })

  it('samples the perlin field six times, not once', () => {
    // curl needs plus and minus delta on each axis. Sharing one sample across axes
    // makes the discrete differences zero and the field uniform, which is the
    // failure the comment on perlin3d warns about
    const { fragment } = compileWGSL(turbulence(vec2(0.3, 0.7)))
    const fbmSums = (fragment.match(/\/\s*1\.75/g) ?? []).length
    log('turbulence-wgsl-probes', {
      // three emits each perlin3d call's 4-octave sum as `... / 1.75`, so the
      // count of those divisions is the count of field samples
      fbmSums,
      mixes: (fragment.match(/mix\(/g) ?? []).length
    })
    expect(fbmSums).toBeGreaterThanOrEqual(6)
  })

  it('uses three DISTINCT perlin offsets, not one field three times', () => {
    // the offsets are (-19.1, 33.4, 47.2) and (74.2, -124.5, 99.4)
    const { fragment } = compileWGSL(turbulence(vec2(0.3, 0.7)))
    const offsets = [-19.1, 33.4, 47.2, 74.2, -124.5, 99.4].map(v =>
      new RegExp(`${v}`).test(fragment)
    )
    log('turbulence-wgsl-offsets', {
      present: offsets.filter(Boolean).length,
      of: offsets.length
    })
    expect(offsets.filter(Boolean).length).toBe(offsets.length)
  })

  it('central differences use delta = 0.1 on every axis', () => {
    const { fragment } = compileWGSL(turbulence(vec2(0.3, 0.7)))
    const half = /vec3<f32>\(\s*0\.0,\s*0\.1,\s*0\.0\s*\)/.test(fragment)
    log('turbulence-wgsl-delta', { halfDelta: half })
    expect(fragment).toMatch(/0\.1/)
    expect(half).toBe(true)
  })

  it('normalises the curl, then packs into [0, 1] with alpha 1', () => {
    // `normalize(vec3(x,y,z) * 5.0)`, the 1/(2*delta) divisor is kept to match
    // the reference line for line, and cancels under the normalize
    const { fragment } = compileWGSL(turbulence(vec2(0.3, 0.7)))
    const main = fragment.slice(fragment.indexOf('fn main'))
    log('turbulence-wgsl-pack', {
      hasNormalize: main.includes('normalize'),
      hasHalfShift: /\* vec3<f32>\( 0\.5 \) \) \+ vec3<f32>\( 0\.5 \)/.test(
        main
      )
    })
    expect(main).toContain('normalize')
    // rgb = c*0.5 + 0.5, alpha = 1
    expect(main).toMatch(/\* vec3<f32>\( 0\.5 \) \) \+ vec3<f32>\( 0\.5 \)/)
    expect(main).toMatch(/\), 1\.0 \);/)
  })

  it('the curl components are wired as a right-handed cross difference', () => {
    // curl_x = dFz/dy - dFy/dz, and so on. Reading the emitted order catches a
    // transposed component, which rotates the field and is invisible in a
    // packed texture
    const { fragment } = compileWGSL(turbulence(vec2(0.3, 0.7)))
    const main = fragment.slice(fragment.indexOf('fn main'))
    const cross =
      /normalize\( \( vec3<f32>\(([\s\S]*?)\) \* vec3<f32>\( 5\.0 \) \) \)/.exec(
        main
      )
    log('turbulence-wgsl-cross', { found: cross != null })
    expect(cross).not.toBeNull()
    // six node vars appear across the three components, two per axis
    const used = new Set(cross![1]!.match(/nodeVar\d+/g) ?? [])
    expect(used.size).toBe(6)
  })
})

describe('localWeather, WGSL', () => {
  beforeEach(() => setCurrentSpec('localWeather-wgsl'))

  it('compiles with a smoothstep per channel', () => {
    const { fragment } = compileWGSL(localWeather(vec2(0.3, 0.7)))
    const smoothsteps = (fragment.match(/smoothstep\(/g) ?? []).length
    log('localWeather-wgsl-smoothsteps', {
      smoothsteps,
      length: fragment.length
    })
    // mid, low and high are each smoothstepped, three of them
    expect(smoothsteps).toBeGreaterThanOrEqual(3)
  })

  it('red subtracts mid and clamps, so low and mid cannot stack into a deck', () => {
    // localWeather.frag:77-82, red = clamp(lowRaw - mid, 0, 1)
    // `clamp(` nests inside the Worley fbm's distance clamps, several of them also
    // bounded 0..1, so match by paren DEPTH within the fragment entry alone
    const { fragment } = compileWGSL(localWeather(vec2(0.3, 0.7)))
    const entry = fragment.slice(fragment.indexOf('output.color'))
    const bounded = matchingClamps(entry).filter(c =>
      /,\s*0\.0,\s*1\.0\s*$/.test(c)
    )
    log('localWeather-wgsl-red', {
      entryClamps: matchingClamps(entry).length,
      bounded: bounded.length,
      outerHasSubtract: bounded[0] ? /-/.test(bounded[0]) : false
    })
    expect(bounded.length).toBeGreaterThan(0)
    // the OUTERMOST bounded clamp in the entry is the red channel's
    const outer = bounded[0]!
    expect(outer).toMatch(/-/)
    // ...and it smoothsteps the low channel with the (0.8, 1.4) edges
    expect(outer).toMatch(/smoothstep\( 0\.8, 1\.4,/)
  })

  it('high clouds are anisotropic: frequency (6, 12, 1)', () => {
    const { fragment } = compileWGSL(localWeather(vec2(0.3, 0.7)))
    log('localWeather-wgsl-high-anisotropy', {
      has6: /6\.0/.test(fragment),
      has12: /12\.0/.test(fragment)
    })
    // vec3(6, 12, 1) is not 1 everywhere, so a collapsed isotropic frequency
    // loses both constants
    expect(fragment).toMatch(/6\.0/)
    expect(fragment).toMatch(/12\.0/)
  })

  it('alpha is exactly 1, not the dead 4-octave Perlin the reference discards', () => {
    // localWeather.frag:77-82 computes an "Extra" Perlin into alpha and
    // overwrites it with 1.0 on the next line. The port is faithful by NOT
    // porting that dead value, so the emitted vec4 must end in 1.0
    const { fragment } = compileWGSL(localWeather(vec2(0.3, 0.7)))
    const main = fragment.slice(fragment.indexOf('fn main'))
    const out = /output\.color = vec4<f32>\(([\s\S]*?)\);/.exec(main)
    log('localWeather-wgsl-alpha', { output: out?.[1] ?? '' })
    expect(out).not.toBeNull()
    expect(out![1]).toMatch(/,\s*1\.0\s*$/)
  })

  it('mid is offset by 0.5 on every axis and low is not', () => {
    // the offset is what stops mid correlating with low. Losing it produces a
    // texture that still looks like weather
    const { fragment } = compileWGSL(localWeather(vec2(0.3, 0.7)))
    log('localWeather-wgsl-mid-offset', {
      hasHalfOffset: /0\.5/.test(fragment)
    })
    expect(fragment).toMatch(/0\.5/)
  })
})
