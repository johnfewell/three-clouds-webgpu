// The shaft march: which pixels march, how far, and what the segment
// integrates. The geometry is the part with a real failure mode, because an
// empty segment and a real one differ by a sign

import { float, struct, uniform, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import { clouds } from '../CloudsPassNode'
import {
  RAIN_SHAFT_STEP_COUNT,
  rainShaftDensityFromNoiseCPU
} from '../experimental/rainShafts'
import {
  createRainShaftMarch,
  rainShaftSegmentCPU,
  rainShaftStepCPU
} from './rainShaftMarch'

// The split-irradiance struct the real accessor returns, as constants. The march
// reads both members and nothing else, so the values do not matter here
const irradianceStruct = struct(
  { direct: 'vec3', indirect: 'vec3' },
  'TestSplitIrradiance'
)

const BOTTOM_RADIUS = 6_371_000
const BASE_HEIGHT = 750

// The shell the shafts hang from, as the shader builds it
const shell = BOTTOM_RADIUS + BASE_HEIGHT

function marchWGSL(): string {
  const pass = clouds({ sceneDepth: null })
  const march = createRainShaftMarch({
    density: (height, uv) =>
      float(1e-4).mul(float(uv.x)).add(float(height).mul(1e-7)),
    getCloudsSunSkyIrradiance: () =>
      irradianceStruct(vec3(1, 1, 1), vec3(0.5, 0.5, 0.5)),
    bottomRadius: uniform(BOTTOM_RADIUS),
    baseHeight: uniform(BASE_HEIGHT),
    maxRayDistance: uniform(200_000)
  })
  const out = normalizeWGSL(
    compileWGSL(
      march(
        vec3(0, BOTTOM_RADIUS + 2, 0),
        vec3(0, 1, 0),
        float(1200),
        float(0)
      ),
      { width: 4, height: 4 }
    ).fragment
  )
  pass.dispose()
  return out
}

describe('the shaft segment', () => {
  it('runs from the camera to the cloud base for a ray looking up', () => {
    // Straight up from 2 m: the camera is inside the shell, so the segment is
    // the whole climb to the base and nothing is clipped
    const segment = rainShaftSegmentCPU(
      BOTTOM_RADIUS + 2,
      BOTTOM_RADIUS + 2,
      shell,
      200_000,
      0
    )
    table('shaft segment, ray up', [
      { field: 'near', expected: 0, actual: segment.near },
      {
        field: 'far',
        expected: BASE_HEIGHT - 2,
        actual: segment.far,
        delta: Math.abs(segment.far - (BASE_HEIGHT - 2))
      },
      { field: 'step', expected: 'span/4', actual: segment.steps }
    ])
    expect(segment.near).toBe(0)
    expect(segment.far).toBeCloseTo(BASE_HEIGHT - 2, 6)
    expect(segment.steps).toBeCloseTo(segment.far / RAIN_SHAFT_STEP_COUNT, 9)
  })

  it('stops at the scene when the ray hits something first', () => {
    // A camera above the deck looking down at terrain 900 m below it: the
    // segment is the drop to the surface, not the drop through the shell
    const segment = rainShaftSegmentCPU(
      BOTTOM_RADIUS + 1200,
      -(BOTTOM_RADIUS + 1200),
      shell,
      200_000,
      900
    )
    log('shaft segment, ray down at terrain', { ...segment })
    expect(segment.far).toBeCloseTo(900, 6)
    expect(segment.near).toBeGreaterThan(0)
    expect(segment.steps).toBeGreaterThan(0)
  })

  it('is empty for a ray that never enters the band', () => {
    // Above the base looking up: both roots of the shell are behind the camera,
    // so the span clamps to zero and four zero-length steps integrate to
    // transmittance 1. This is the no-branch rejection of the empty pixels
    const segment = rainShaftSegmentCPU(
      BOTTOM_RADIUS + 5000,
      BOTTOM_RADIUS + 5000,
      shell,
      200_000,
      0
    )
    log('shaft segment, ray up from above the deck', { ...segment })
    expect(segment.far).toBeLessThan(0)
    expect(segment.steps).toBe(0)
  })

  it('bounds a near-horizontal ray by the march limit, not by infinity', () => {
    const horizontal = rainShaftSegmentCPU(
      BOTTOM_RADIUS + 2,
      0,
      shell,
      200_000,
      0
    )
    log('shaft segment, ray along the ground', { ...horizontal })
    expect(horizontal.far).toBeGreaterThan(0)
    expect(horizontal.far).toBeLessThanOrEqual(200_000)
  })
})

describe('the shaft integration', () => {
  it('is a no-op for an empty segment', () => {
    const step = rainShaftStepCPU(1, 0, 0, 5)
    log('empty segment step', { ...step })
    expect(step.transmittance).toBe(1)
    expect(step.inScatter).toBe(0)
  })

  it('attenuates by exp(-extinction * distance) and adds the rest', () => {
    const extinction = 2e-4
    const distance = 900
    const step = rainShaftStepCPU(1, extinction, distance, 1)
    const expected = Math.exp(-extinction * distance)
    table('shaft step', [
      {
        field: 'transmittance',
        expected,
        actual: step.transmittance,
        delta: Math.abs(step.transmittance - expected)
      },
      {
        field: 'inScatter',
        expected: 1 - expected,
        actual: step.inScatter,
        delta: Math.abs(step.inScatter - (1 - expected))
      }
    ])
    expect(step.transmittance).toBeCloseTo(expected, 12)
    expect(step.inScatter).toBeCloseTo(1 - expected, 12)
  })

  it('a full column of the shipped density is a grey curtain, not fog', () => {
    // The energy-conserving form: albedo * (1 - T) integrated along the segment
    // A 2 km column at the shipped density has to stay translucent enough that
    // the sky behind it still reads
    const perMetre = rainShaftDensityFromNoiseCPU(
      0.9,
      0.52,
      0.22,
      1,
      0.75,
      1.5e-4
    )
    let transmittance = 1
    let inScatter = 0
    const step = (BASE_HEIGHT - 2) / RAIN_SHAFT_STEP_COUNT
    for (let i = 0; i < RAIN_SHAFT_STEP_COUNT; i++) {
      const s = rainShaftStepCPU(transmittance, perMetre, step, 1)
      inScatter += s.inScatter
      transmittance = s.transmittance
    }
    log('750 m column at the shipped density', {
      extinctionPerMetre: perMetre,
      transmittance,
      inScatter,
      opticalDepth: -Math.log(transmittance)
    })
    expect(transmittance).toBeLessThan(1)
    expect(transmittance).toBeGreaterThan(0.3)
    // Energy conserving: what is scattered plus what is left is one
    expect(inScatter + transmittance).toBeCloseTo(1, 12)
  })

  it('compiles to WGSL with a closed loop and no texture sample', () => {
    const wgsl = marchWGSL()
    log('shaft march WGSL', {
      bytes: wgsl.length,
      loops: wgsl.includes('for'),
      textureSample: wgsl.includes('textureSample')
    })
    expect(wgsl).toContain('for')
    // Pure ALU plus the irradiance struct: a texture fetch here would be an
    // implicit-LOD sample inside a loop, which returns zeros on Dawn
    expect(wgsl).not.toContain('textureSample')
  })

  it('reads the sun through the marched shadow length', () => {
    // The whole "darkens under the cloud" claim rests on this one multiply
    const wgsl = marchWGSL()
    log('shaft sun transmittance', { hasExp: wgsl.includes('exp(') })
    expect(wgsl).toContain('exp(')
  })
})
