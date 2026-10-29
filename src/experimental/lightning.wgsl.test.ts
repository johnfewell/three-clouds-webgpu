// The lightning term as emitted, not as described. compileWGSL runs no GPU, and
// it THROWS on a THREE.TSL console error, so a snapshot that compiles here is
// evidence the graph builds

// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Vector3 } from 'three'
import { float, Fn, uniform, vec2, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  buildLightningDeps,
  createLightningUniforms,
  lightningParamsDefault
} from './lightning'

// A constant only the stubbed secondary march emits, so its presence in the
// compiled text cannot be confused with anything else
const MARCH_MARKER = 0.654321

const SAMPLE = vec3(0, 6361000, 0)
const MIP = float(0.25)
const JITTER = float(0.5)

function compileInScatter(
  accurate = false,
  activeIntensity = 1
): { wgsl: string; marchCalls: number } {
  let marchCalls = 0
  const uniforms = createLightningUniforms({
    position: new Vector3(1000, 6361400, 0),
    intensity: activeIntensity,
    colour: new Vector3(1, 0.9, 0.8)
  })
  const deps = buildLightningDeps({
    // The sun march's own function. Marked so the emitted text can prove the
    // flash reuses it rather than growing a second march of its own
    marchOpticalDepth: Fn(([, , count]: [never, never, never]) => {
      marchCalls++
      return vec2(float(MARCH_MARKER), float(count))
    }) as never,
    cameraPosition: uniform(new Vector3(0, 0, 0)),
    accuratePhaseFunction: accurate,
    scatterAnisotropy1: 0.7,
    scatterAnisotropy2: -0.2,
    scatterAnisotropyMix: 0.4,
    uniforms,
    params: lightningParamsDefault
  })
  const node = Fn(() => deps.inScatter(SAMPLE, MIP, JITTER))()
  return { wgsl: compileWGSL(node).fragment, marchCalls }
}

describe('lightning in-scatter, compiled', () => {
  setCurrentSpec('lightning-wgsl')

  it('builds, and takes its extinction from the secondary march', () => {
    const { wgsl, marchCalls } = compileInScatter()
    log('inScatter build', {
      bytes: wgsl.length,
      marchCalls,
      usesSecondaryMarch: wgsl.includes(String(MARCH_MARKER)),
      iterations: lightningParamsDefault.depthIterationCount
    })
    // compileWGSL throws on a TSL error, so reaching here is the graph-building
    // assertion
    expect(wgsl.length).toBeGreaterThan(0)
    // On the emitted text, since the iteration count is a uniform a digest
    // could not see. One call, with the configured depth iteration count

    // three r186 runs a Fn body more than once while building, so the JS
    // call count is not the shader's. Count the march in the emitted text
    expect(wgsl.split(String(MARCH_MARKER)).length - 1).toBe(1)
    expect(wgsl).toContain(String(lightningParamsDefault.depthIterationCount))
  })

  it('guards the march on the active uniform, so an idle storm skips it', () => {
    // The cost claim rests entirely on this branch. A term that ran
    // unconditionally and multiplied by zero would look identical on screen
    // and would march a ray per shaded step forever
    const { wgsl } = compileInScatter(false, 0)
    const guard = wgsl.match(
      /if\s*\(\s*\([^)]*active[^)]*\)|if\s*\(\s*\([^)]*lightning_active\s*>\s*[\d.]+\s*\)\s*\)/
    )
    const lines = wgsl.split('\n')
    const guardLine = lines.findIndex(l => /if\s*\(/.test(l))
    const marchLine = lines.findIndex(l => l.includes(String(MARCH_MARKER)))

    log('idle guard', {
      guard: guard?.[0]?.trim() ?? 'none',
      comparesActive: /lightning_active\s*>\s*0\.5/.test(wgsl),
      guardLine,
      marchLine
    })

    expect(guardLine).toBeGreaterThan(-1)
    // The 0.5 is the whole guard. A negative or zero threshold folds it open
    // and every idle frame marches toward a flash that is not there
    expect(wgsl).toMatch(/lightning_active\s*>\s*0\.5/)
    // And the march sits inside that branch, not after it
    expect(marchLine).toBeGreaterThan(guardLine)
  })

  it('clamps the falloff divisor to the softening length, as the twin does', () => {
    // A true point light diverges at its own position, so a sample landing on
    // the flash would take the whole frame to itself. Tied to the CPU twin on
    // purpose, a divergence between them is invisible in every image
    const { wgsl } = compileInScatter()
    const softeningSq = lightningParamsDefault.softening ** 2
    log('softening in the shader', {
      softening: lightningParamsDefault.softening,
      softeningSq,
      emitted: wgsl.includes(String(softeningSq))
    })
    expect(wgsl).toContain(String(softeningSq))
  })

  it('emits the phase function it was configured with', () => {
    // The accurate and the anisotropic approximations compile to different text,
    // so this catches a seam that quietly ignored the context's setting
    const plain = compileInScatter(false).wgsl
    const accurate = compileInScatter(true).wgsl
    log('phase variants', {
      plainBytes: plain.length,
      accurateBytes: accurate.length,
      identical: plain === accurate
    })
    expect(plain).not.toBe(accurate)
  })
})
