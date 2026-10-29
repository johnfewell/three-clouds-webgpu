// The cascades debug view, the last of the debug views. Cite:
// clouds.frag:139–169, 585–589

// The colour table must not name cascades the configuration lacks, and the
// march hook must be graph-time: absent from the shader when the view is off

import { Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

const RED = 'vec3<f32>( 1.0, 0.0, 0.0 )'
const GREEN = 'vec3<f32>( 0.0, 1.0, 0.0 )'
const BLUE = 'vec3<f32>( 0.0, 0.0, 1.0 )'
const YELLOW = 'vec3<f32>( 1.0, 1.0, 0.0 )'
const WHITE = 'vec3<f32>( 1.0, 1.0, 1.0 )'

// A constant only the stubbed cascade colour emits, so its presence in the
// march's WGSL cannot be confused with anything else
const CASCADE_MARKER = 0.654321

async function compileColor(
  cascadeCount: number,
  onIndexCall?: () => void
): Promise<string> {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const { Fn, float, uniform, vec3 } = await import('three/tsl')
  const { createDebugCascadeColor } = await import('./debugCascadeColor')

  const getCascadeColor = createDebugCascadeColor({
    getFadedCascadeIndex: () => {
      onIndexCall?.()
      // A uniform-backed int: with a constant index TSL folds every comparison
      // away, which is how this test once passed while the real shader failed
      // with `i32 == abstract-float`
      return uniform(1, 'int')
    },
    ecefToWorldMatrix: uniform(new Matrix4()),
    altitudeCorrection: uniform(new Vector3()),
    cascadeCount
  })

  const node = Fn(() => getCascadeColor(vec3(0, 0, 6361000), float(0.5)))()
  return compileWGSL(node).fragment
}

describe('createDebugCascadeColor', () => {
  setCurrentSpec('debugCascadeColor')

  it('emits one colour per cascade, plus white for out-of-range', async () => {
    const wgsl = await compileColor(4)
    log('debugCascadeColor-4', [
      { field: 'red', expected: true, actual: wgsl.includes(RED) },
      { field: 'green', expected: true, actual: wgsl.includes(GREEN) },
      { field: 'blue', expected: true, actual: wgsl.includes(BLUE) },
      { field: 'yellow', expected: true, actual: wgsl.includes(YELLOW) },
      {
        field: 'white (index < 0)',
        expected: true,
        actual: wgsl.includes(WHITE)
      }
    ])
    for (const c of [RED, GREEN, BLUE, YELLOW, WHITE]) {
      expect(wgsl).toContain(c)
    }
  })

  it('never names a cascade the configuration does not have', async () => {
    const wgsl = await compileColor(2)
    log('debugCascadeColor-2', [
      { field: 'red', expected: true, actual: wgsl.includes(RED) },
      { field: 'green', expected: true, actual: wgsl.includes(GREEN) },
      {
        field: 'blue (cascade 2)',
        expected: false,
        actual: wgsl.includes(BLUE)
      },
      {
        field: 'yellow (cascade 3)',
        expected: false,
        actual: wgsl.includes(YELLOW)
      }
    ])
    expect(wgsl).toContain(RED)
    expect(wgsl).toContain(GREEN)
    expect(wgsl).not.toContain(BLUE)
    expect(wgsl).not.toContain(YELLOW)
  })

  it('compares the cascade index against INTEGER literals', async () => {
    // `cascadeIndex.equal(i)` with a JS number emits `i32 == 1.0`, which fails
    // to compile and takes the pipeline down. compileWGSL does not type-check,
    // so the check is on the emitted text
    const wgsl = await compileColor(4)
    const comparisons = wgsl.split('\n').filter(l => l.includes('=='))
    expect(comparisons.length).toBeGreaterThan(0)
    const floatCompares = comparisons.filter(l => /==\s*-?\d+\.\d+/.test(l))
    expect(
      floatCompares,
      'the cascade index is an i32; comparing it to a float literal does not compile: ' +
        floatCompares.join(' | ')
    ).toEqual([])
  })

  it('routes the position through the injected cascade selector', async () => {
    let calls = 0
    await compileColor(4, () => {
      calls++
    })
    expect(calls).toBe(1)
  })
})

// ── the march hook ────────────────────────────────────────────────────────
// Same variant shape as primaryMarch.bsm.test.ts: the flag may only ADD work

async function compileMarch(withCascades: boolean): Promise<string> {
  const { compileWGSL } = await import('../../test/helpers/compileWGSL')
  const { createMarchClouds } = await import('./primaryMarch')
  const { Fn, float, struct, uniform, vec2, vec3, vec4 } =
    await import('three/tsl')

  const irradianceStruct = struct(
    { direct: 'vec3', indirect: 'vec3' },
    'MockIrradiance'
  )

  const deps: Record<string, unknown> = {
    sampleWeather: Fn(() => vec4(0.6, 0.2, 0.1, 0.05)),
    sampleMedia: Fn(() => float(0.4)),
    getCloudsSunSkyIrradiance: Fn(() =>
      irradianceStruct(vec3(1, 1, 1), vec3(0.2, 0.2, 0.3))
    ),
    marchOpticalDepth: Fn(() => vec2(0.7, 1200)),
    approxMultiScatter: Fn(() => vec3(0.5, 0.5, 0.5)),
    bottomRadius: uniform(6360000),
    sunDirection: uniform(vec3(0, 0, 1)),
    minHeight: uniform(750),
    maxHeight: uniform(1400),
    minIntervalHeights: uniform(vec3(0, 0, 0)),
    maxIntervalHeights: uniform(vec3(0, 0, 0)),
    minLayerHeights: uniform(vec4(750, 0, 0, 0)),
    maxLayerHeights: uniform(vec4(1400, 0, 0, 0)),
    maxIterationCount: 8,
    maxIterationCountToSun: 3,
    minStepSize: uniform(50),
    maxStepSize: uniform(1000),
    perspectiveStepScale: uniform(1.01),
    minDensity: uniform(1e-4),
    minExtinction: uniform(1e-4),
    minTransmittance: uniform(1e-3),
    skyLightScale: uniform(1),
    scatteringCoefficient: uniform(1),
    absorptionCoefficient: uniform(0.02),
    powderScale: uniform(0.8),
    powderExponent: uniform(150),
    worldToUnit: uniform(1 / 6360000),
    shadowTopHeight: uniform(3000)
  }

  if (withCascades) {
    deps.getDebugCascadeColor = () => vec3(CASCADE_MARKER, 0, 0)
  }

  const marchClouds = createMarchClouds(deps as never)
  const node = Fn(() =>
    marchClouds(
      vec3(0, 0, 6361000),
      vec3(0, 0, 1),
      vec2(0, 5000),
      float(0.9),
      float(0.5),
      float(1)
    ).get('layer')
  )()

  return compileWGSL(node).fragment
}

describe('primary march — cascades debug hook', () => {
  setCurrentSpec('primaryMarch-cascades')

  it('replaces the shaded radiance when the view is on', async () => {
    const wgsl = await compileMarch(true)
    const present = wgsl.includes(String(CASCADE_MARKER))
    log('primaryMarch-cascades-on', [
      { field: 'compiles', expected: true, actual: wgsl.length > 0 },
      { field: 'cascade colour present', expected: true, actual: present }
    ])
    expect(wgsl.length).toBeGreaterThan(0)
    expect(present, 'the march must apply the cascade colour').toBe(true)
  })

  it('is absent from the shader when the view is off', async () => {
    const wgsl = await compileMarch(false)
    const present = wgsl.includes(String(CASCADE_MARKER))
    log('primaryMarch-cascades-off', [
      { field: 'compiles', expected: true, actual: wgsl.length > 0 },
      { field: 'cascade colour present', expected: false, actual: present }
    ])
    expect(wgsl.length).toBeGreaterThan(0)
    expect(present, 'a Phase-1 variant must not gain debug work').toBe(false)
  })

  it('turning it on only adds — it never restructures the march', async () => {
    const [on, off] = await Promise.all([
      compileMarch(true),
      compileMarch(false)
    ])
    log('primaryMarch-cascades-diff', [
      { field: 'wgsl chars (off)', expected: '<on', actual: off.length },
      { field: 'wgsl chars (on)', expected: '>off', actual: on.length }
    ])
    expect(on.length).toBeGreaterThan(off.length)
  })
})
