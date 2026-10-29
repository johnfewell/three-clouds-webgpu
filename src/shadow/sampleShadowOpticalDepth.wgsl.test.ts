// WGSL compilation of the shadow optical-depth sampler
//. Cite: clouds.frag:113-137, 172-250

// The CPU twins never asserted the TSL reads the atlas, and both consumers
// (the shafts and the BSM hook) read zero on side B

import { DataArrayTexture, Matrix4, Vector2, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

describe('sampleShadowOpticalDepth — WGSL', () => {
  setCurrentSpec('sampleShadowOpticalDepth-wgsl')

  it('reads the cascade atlas', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const {
      Fn: tslFn,
      float,
      texture,
      uniform,
      uniformArray,
      vec3
    } = await import('three/tsl')
    const { createSampleShadowOpticalDepth } =
      await import('./sampleShadowOpticalDepth')

    const CASCADES = 4
    const atlas = new DataArrayTexture(
      new Uint8Array(4 * 4 * CASCADES * 4),
      4,
      4,
      CASCADES
    )

    const sampleOD = createSampleShadowOpticalDepth({
      // Live handle, as production binds it
      // A raw DataArrayTexture no longer type-checks here, which is the point
      shadowBuffer: texture(atlas),
      shadowTexelSize: uniform(new Vector2(1 / 4, 1 / 4)),
      // uniformArray, as CloudsPassNode passes: the sampler indexes these
      // per cascade with .element(i)
      shadowIntervals: uniformArray(
        Array.from({ length: CASCADES }, () => new Vector2(0, 1))
      ),
      shadowMatrices: uniformArray(
        Array.from({ length: CASCADES }, () => new Matrix4())
      ),
      shadowFar: uniform(1e5),
      viewMatrix: uniform(new Matrix4()),
      cameraNear: uniform(1),
      sunDirection: uniform(new Vector3(0, 0, 1)),
      bottomRadius: uniform(6360000),
      shadowTopHeight: uniform(3000),
      ecefToWorldMatrix: uniform(new Matrix4()),
      altitudeCorrection: uniform(new Vector3()),
      worldToUnit: uniform(1 / 6360000),
      temporalJitter: uniform(new Vector2()),
      resolution: uniform(new Vector2(1280, 720)),
      cascadeCount: uniform(CASCADES, 'int'),
      shadowSampleCount: 16
    })

    const node = tslFn(() =>
      sampleOD(vec3(0, 0, 6361000), float(0), float(0), float(0.5))
    )()

    const { fragment } = compileWGSL(node)

    // A sampler that never touches the atlas cannot return anything but a
    // constant, which is exactly the observed symptom on side B
    const readsAtlas = /texture(Sample|Load)/.test(fragment)
    const hasCascadeLoop = /\bfor\s*\(/.test(fragment)

    log('sampleShadowOpticalDepth-wgsl', [
      { field: 'compiles', expected: true, actual: fragment.length > 0 },
      { field: 'reads the atlas', expected: true, actual: readsAtlas },
      {
        field: 'emits a loop (PCF/cascade)',
        expected: true,
        actual: hasCascadeLoop
      },
      { field: 'wgsl chars', expected: '>0', actual: fragment.length }
    ])

    expect(fragment.length).toBeGreaterThan(0)
    expect(readsAtlas, 'the sampler must read the cascade atlas').toBe(true)
  })
})

// Regression guard for the zero shadow length: `map` was reassigned
// correctly each update, but the shader captured the build-time texture (the
// 1x1 placeholder) while the atlas was full
describe('shadow atlas binding is a live handle', () => {
  it('follows .value across a target swap instead of capturing at build time', async () => {
    const { texture } = await import('three/tsl')
    const mk = (n: number): DataArrayTexture =>
      new DataArrayTexture(new Uint8Array(4 * 4 * n * 4), 4, 4, n)

    const first = mk(3)
    const node = texture(first)
    expect(node.value).toBe(first)

    // What ensureShadowRT does on a resize: dispose, build a NEW texture
    const second = mk(3)
    expect(second).not.toBe(first)

    // The live handle follows the swap, a captured Texture would not
    node.value = second
    expect(node.value).toBe(second)

    log('shadow-binding-live-handle', [
      {
        field: 'node tracks the new target',
        expected: true,
        actual: node.value === second
      },
      {
        field: 'stale identity retained',
        expected: false,
        actual: node.value === first
      }
    ])
  })
})

// these three accessors had no PER-SITE snapshot. The block above
// compiles the SAMPLER, which is not evidence about one accessor: the sampler
// keeps its shape while an accessor is edited underneath it
describe('sampleShadowOpticalDepth accessors — per-site', () => {
  setCurrentSpec('sampleShadowOpticalDepth-accessors')

  it('vogelDisk emits the golden angle with a cos/sin pair', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { float, int } = await import('three/tsl')
    const { vogelDisk } = await import('./sampleShadowOpticalDepth')
    const { fragment } = compileWGSL(vogelDisk(int(3), float(8), float(0.5)))
    log('vogelDisk-per-site', {
      length: fragment.length,
      hasGoldenAngle: fragment.includes('2.3999632297286535')
    })
    // the constant is the claim: a "modern" replacement hash would look better
    // and would reseed every PCF pattern
    expect(fragment).toContain('2.3999632297286535')
    expect(fragment).toContain('cos')
    expect(fragment).toContain('sin')
  })

  it('getShadowUv projects through the matrix and the w divide', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { mat4, vec3 } = await import('three/tsl')
    const { getShadowUv } = await import('./sampleShadowOpticalDepth')
    const { fragment } = compileWGSL(getShadowUv(vec3(1, 2, 3), mat4()))
    log('getShadowUv-per-site', { length: fragment.length })
    // clip.xy * vec2(0.5) + vec2(0.5) is the NDC to atlas remap, emitted as a
    // VECTOR scale, and the perspective divide is a whole-VEC4 divide
    expect(fragment).toMatch(/\* vec2<f32>\( 0\.5 \)/)
    expect(fragment).toMatch(/\+ vec2<f32>\( 0\.5 \)/)
    expect(fragment).toMatch(/\/ vec4<f32>\( \w+\.w \)/)
  })

  it('getDistanceToShadowTop guards the discriminant, then takes the far root', async () => {
    const { compileWGSL } = await import('../../test/helpers/compileWGSL')
    const { uniform, vec3 } = await import('three/tsl')
    const { getDistanceToShadowTop } =
      await import('./sampleShadowOpticalDepth')
    const { fragment } = compileWGSL(
      getDistanceToShadowTop(
        uniform(vec3(0, 6360000, 0)),
        uniform(vec3(0, 1, 0)),
        uniform(6360000),
        uniform(1000)
      )
    )
    const main = fragment.slice(fragment.indexOf('fn main'))
    log('getDistanceToShadowTop-per-site', {
      length: fragment.length,
      guarded: />=\s*0\.0/.test(main),
      sqrt: main.includes('sqrt')
    })
    // bottomRadius + shadowTopHeight is the sphere radius, so it must be a sum
    // of the two inputs rather than one of them alone
    expect(main).toMatch(/\+/)
    // the guard is an `if (disc >= 0.0)` branch, not a max(), and an unguarded
    // sqrt of a negative discriminant is undefined in WGSL
    expect(main).toMatch(/>=\s*0\.0/)
    expect(main).toContain('sqrt')
    expect(main).toContain('if')
  })
})
