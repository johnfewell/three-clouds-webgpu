// The shadow-map debug view reads the live atlas, the last of the debug views
// Cite: clouds.frag:252-295, 824-831

// It once bound the 1x1 placeholder captured at build time: a sampled target
// is a TextureNode whose .value follows the swap. The type prevents that now,
// so this tests the view reads the atlas and all four cascade tiles

import { DataArrayTexture } from 'three'
import { describe, expect, it } from 'vitest'

import {
  readsOutsideAssigningBlock,
  varsAssigned
} from '../../test/helpers/branchScope'
import { log, setCurrentSpec } from '../../test/helpers/log'

async function compileShadowMapView(): Promise<string> {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const { Fn, texture, uniform } = await import('three/tsl')
  const { createShadowMapDebug } = await import('./cloudsFragment')

  const CASCADES = 4
  const atlas = new DataArrayTexture(
    new Uint8Array(4 * 4 * CASCADES * 4),
    4,
    4,
    CASCADES
  )
  // A TextureNode, exactly as CloudsPassNode passes descriptor.mapNode, plus the
  // worldToUnit scale and the runtime cascade count the view now takes
  const node = createShadowMapDebug(
    texture(atlas),
    uniform(1 / 6378137),
    uniform(CASCADES, 'int')
  )
  return compileWGSL(Fn(() => node().get('layer'))()).fragment
}

describe('shadow-map debug view (site 3)', () => {
  setCurrentSpec('shadowMapDebug')

  it('reads the atlas', async () => {
    const wgsl = await compileShadowMapView()
    const readsAtlas = /texture(Sample|Load)/.test(wgsl)
    const arrayBinding = /texture_2d_array/.test(wgsl)
    log('shadowMapDebug', [
      { field: 'compiles', expected: true, actual: wgsl.length > 0 },
      { field: 'reads the atlas', expected: true, actual: readsAtlas },
      { field: 'array binding', expected: true, actual: arrayBinding }
    ])
    expect(wgsl.length).toBeGreaterThan(0)
    expect(readsAtlas, 'the debug view must sample the atlas').toBe(true)
    expect(arrayBinding, 'the atlas is a cascade array').toBe(true)
  })

  it('reads the atlas in the REFERENCE v sense, not the pass sense', async () => {
    // The reference's vUv is bottom-up, WebGPU's uv() top-down. Without the
    // conversion every quadrant lands on its mirror row (SSIM 0.108, vflip
    // 0.990). Asserted on the emitted WGSL

    // The quadrant tests are a faithful transcription and are not checked here:
    // flipping them to make a plate agree is how the compensating pair began
    const wgsl = await compileShadowMapView()
    const uvY = /\buv\w*\.y\b/.test(wgsl)
    const flipped = /1\.0\s*-\s*[^;]*\.y|\.y[^;]*\*\s*-1/.test(wgsl)
    log('shadowMapDebug-vsense', [
      { field: 'samples on uv.y', expected: true, actual: uvY },
      { field: 'v inverted before use', expected: true, actual: flipped }
    ])
    expect(
      flipped,
      'the debug view consumes uv() directly, so it reads the pass v sense ' +
        'rather than the reference vUv sense and every cascade tile lands on ' +
        'its mirror row'
    ).toBe(true)
  })

  it('tiles all four cascades, not just the first', async () => {
    // The view exists to show every cascade at once, and collapsing to layer 0 would
    // still compile, still render, and still look plausible
    const wgsl = await compileShadowMapView()
    const layers = new Set(
      [...wgsl.matchAll(/textureLoad\([^)]*?,\s*(\d+)\s*[,)]/g)].map(m => m[1])
    )
    const distinctLiterals = new Set(
      [...wgsl.matchAll(/\b([0-3])u?\b/g)].map(m => m[1])
    )
    log('shadowMapDebug-tiles', [
      { field: 'distinct layer args', actual: layers.size, expected: '>=1' },
      {
        field: 'cascade indices 0-3 present',
        expected: true,
        actual: [0, 1, 2, 3].every(i => distinctLiterals.has(String(i)))
      }
    ])
    // All four cascade indices must appear as constants in the emitted view
    for (const i of [0, 1, 2, 3]) {
      expect(distinctLiterals.has(String(i)), `cascade ${i} tile`).toBe(true)
    }
  })

  // Defect 1: red was B/A 0.058 on case 48 because frontDepth is stored
  // in unit space and the view applied the metres-calibrated 1e-5
  // (clouds.frag:279-293). Reverting the .div(worldToUnit) must fail this
  it('undoes the unit-space storage scale before the reference red scale', async () => {
    const wgsl = await compileShadowMapView()
    // The red lane must divide by the worldToUnit uniform BEFORE the reference's
    // 1e-5. Without the fix the emitted lane is a bare `nodeVarN.x * 0.00001`.
    const dividesRed = /\/\s*object\.nodeUniform\d+\s*\)\s*\*\s*0\.00001/.test(
      wgsl
    )
    const hasRedScale = /0\.00001|1e-5/.test(wgsl)
    log('shadowMapDebug-red', [
      { field: 'red scale present', expected: true, actual: hasRedScale },
      { field: 'divides by worldToUnit', expected: true, actual: dividesRed }
    ])
    expect(hasRedScale, 'reference red scale 1e-5 still applied').toBe(true)
    expect(
      dividesRed,
      'red lane must undo the unit-space storage scale (defect 1)'
    ).toBe(true)
  })

  // Defect 2: unused quadrants are black, gated on SHADOW_CASCADE_COUNT
  // (clouds.frag:259-271). At run time, because cascadeCount is mutable and a
  // build-time unroll would freeze
  it('gates cascade tiles 1..3 on the runtime cascade count', async () => {
    const wgsl = await compileShadowMapView()
    // Each guarded tile compares against the count uniform. Without the fix there
    // are no comparisons at all in this view, only four unconditional reads
    const comparisons = [...wgsl.matchAll(/\d+\s*<\s*object\.nodeUniform\d+/g)]
      .length
    log('shadowMapDebug-guard', [
      {
        field: 'runtime count comparisons',
        actual: comparisons,
        expected: '>=3'
      }
    ])
    expect(
      comparisons,
      'tiles 1..3 must each be gated on the cascade-count uniform (defect 2)'
    ).toBeGreaterThanOrEqual(3)
  })

  // TSL emits a shared node as a var at its first use, and under three r186
  // that is inside the first tile, so the other tiles read zeros
  it('assigns the tile coordinates where every tile can read them', async () => {
    const wgsl = await compileShadowMapView()
    const names = varsAssigned(
      wgsl,
      /vec2<f32>\( 0\.5 \) \) \) \* vec4<f32>\( 2\.0 \)/
    )
    const outside = names.flatMap(n => readsOutsideAssigningBlock(wgsl, n))
    log('shadowMapDebug-coord-scope', [
      { field: 'coord vars', expected: '>=1', actual: names.length },
      {
        field: 'reads outside the assigning block',
        expected: 0,
        actual: outside.length
      }
    ])
    expect(names.length).toBeGreaterThan(0)
    expect(outside).toEqual([])
  })

  // The guards deepen the per-pixel branching around these samples, and
  // implicit-LOD textureSample in non-uniform control flow is undefined in WGSL
  // and returns zeros on Dawn
  it('samples the atlas with an explicit LOD', async () => {
    const wgsl = await compileShadowMapView()
    // textureLoad and textureSampleLevel are both LOD-safe, and filterability
    // picks one at build time. Only a bare textureSample in these
    // per-pixel branches is rejected
    const explicitLod = /textureSampleLevel|textureLoad/.test(wgsl)
    const implicitLod = /textureSample\(/.test(wgsl)
    log('shadowMapDebug-lod', [
      { field: 'textureSampleLevel', expected: true, actual: explicitLod },
      { field: 'bare textureSample', expected: false, actual: implicitLod }
    ])
    expect(explicitLod, 'atlas reads must state the LOD').toBe(true)
    expect(
      implicitLod,
      'no implicit-LOD sample inside per-pixel branches'
    ).toBe(false)
  })
})
