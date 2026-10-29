// The Beer-shadow-map hook in the primary march,
// cite: clouds.frag:545-557

// The deps were never passed, so the atlas was never sampled in the march. On,
// the flag must add the sample. Off, the Phase-1 shader stays byte-identical

import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'

// A marker only the BSM sampler emits, so it cannot be confused with any other
// constant in the shader
const BSM_MARKER = 0.123456

async function compileMarch(withShadows: boolean): Promise<string> {
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

  if (withShadows) {
    deps.shadows = true
    deps.maxShadowFilterRadius = uniform(6)
    deps.sampleShadowOpticalDepth = Fn(() => float(BSM_MARKER))
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

describe('primary march — BSM hook variants', () => {
  setCurrentSpec('primaryMarch-bsm')

  it('shadows=true samples the shadow optical depth inside the march', async () => {
    const wgsl = await compileMarch(true)
    const sampled = wgsl.includes(String(BSM_MARKER))
    log('primaryMarch-bsm-on', [
      { field: 'compiles', expected: true, actual: wgsl.length > 0 },
      { field: 'BSM sample present', expected: true, actual: sampled }
    ])
    expect(wgsl.length).toBeGreaterThan(0)
    expect(sampled, 'the march must add the BSM optical depth').toBe(true)
  })

  it('shadows=false leaves the Phase-1 shader free of any BSM sample', async () => {
    const wgsl = await compileMarch(false)
    const sampled = wgsl.includes(String(BSM_MARKER))
    log('primaryMarch-bsm-off', [
      { field: 'compiles', expected: true, actual: wgsl.length > 0 },
      { field: 'BSM sample present', expected: false, actual: sampled }
    ])
    expect(wgsl.length).toBeGreaterThan(0)
    expect(sampled, 'Phase-1 variants must not gain a BSM sample').toBe(false)
  })

  it('the flag is the only difference: off-variant is a strict subset shape', async () => {
    const [on, off] = await Promise.all([
      compileMarch(true),
      compileMarch(false)
    ])
    // Turning the hook on may only ADD work, never restructure the march
    log('primaryMarch-bsm-diff', [
      {
        field: 'wgsl chars (shadows off)',
        expected: '<on',
        actual: off.length
      },
      { field: 'wgsl chars (shadows on)', expected: '>off', actual: on.length }
    ])
    expect(on.length).toBeGreaterThan(off.length)
  })
})
