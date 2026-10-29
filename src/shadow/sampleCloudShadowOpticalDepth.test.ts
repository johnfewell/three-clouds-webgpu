import { beforeEach, describe, expect, it } from 'vitest'

import { expectClose, table } from '../../test/helpers/cpuTwin'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { cpuReadGroundShadowOpticalDepth } from './sampleCloudShadowOpticalDepth'
import { cpuReadShadowOpticalDepth } from './sampleShadowOpticalDepth'

const WORLD_TO_UNIT = 1 / 6360000

describe('cpuReadGroundShadowOpticalDepth', () => {
  beforeEach(() => {
    setCurrentSpec('sampleCloudShadowOD-ground')
  })

  it('clear texel returns 0 (no extinction)', () => {
    const result = cpuReadGroundShadowOpticalDepth(
      { r: 0, g: 0, b: 0, a: 0 },
      5000,
      WORLD_TO_UNIT
    )
    expect(result).toBe(0)
  })

  it('constant extinction: OD = meanExtinction × distanceToFront', () => {
    const frontDepthWorld = 1000
    const meanExtinction = 0.001
    const maxOD = 2.5

    const shadow = {
      r: frontDepthWorld * WORLD_TO_UNIT,
      g: meanExtinction,
      b: maxOD,
      a: 999
    }
    const distanceToTop = 5000

    const result = cpuReadGroundShadowOpticalDepth(
      shadow,
      distanceToTop,
      WORLD_TO_UNIT
    )

    const expectedDistanceToFront = distanceToTop - frontDepthWorld
    const fromExtinction = meanExtinction * expectedDistanceToFront
    const expected = Math.min(maxOD, fromExtinction)

    table('readGroundShadowOD', [
      { metric: 'distanceToFront', value: expectedDistanceToFront },
      { metric: 'fromExtinction', value: fromExtinction },
      { metric: 'maxOD (cap)', value: maxOD },
      { metric: 'result', expected, actual: result }
    ])

    expectClose(result, expected, { label: 'constant-extinction', abs: 1e-4 })
  })

  it('distanceToFront clamps to 0 when behind the cloud', () => {
    const shadow = {
      r: 8000 * WORLD_TO_UNIT,
      g: 0.005,
      b: 3.0,
      a: 0.2
    }

    const result = cpuReadGroundShadowOpticalDepth(shadow, 1000, WORLD_TO_UNIT)
    expect(result).toBe(0)
  })

  it('tail (.a) is ignored in ground formula', () => {
    const shadow = {
      r: 500 * WORLD_TO_UNIT,
      g: 0.01,
      b: 0.5,
      a: 99.0
    }

    const result = cpuReadGroundShadowOpticalDepth(shadow, 10000, WORLD_TO_UNIT)

    const distanceToFront = 10000 - 500
    const fromExtinction = 0.01 * distanceToFront
    // Ground uses min(shadow.b, ...), .a is not added
    expect(result).toBe(Math.min(shadow.b, fromExtinction))
    expect(result).toBe(shadow.b)

    log('tail-ignored', { maxOD: shadow.b, fromExtinction, result })
  })
})

describe('ground vs in-cloud sampler comparison', () => {
  beforeEach(() => {
    setCurrentSpec('sampleCloudShadowOD-comparison')
  })

  it('acceptance: texel (r=0, g=1, b=2, a=5) distanceToTop=3 → ground=2, inCloud=3', () => {
    const shadow = { r: 0, g: 1, b: 2, a: 5 }
    const distanceToTop = 3
    const worldToUnit = 1

    const groundOD = cpuReadGroundShadowOpticalDepth(
      shadow,
      distanceToTop,
      worldToUnit
    )
    const inCloudOD = cpuReadShadowOpticalDepth(
      shadow,
      distanceToTop,
      0,
      worldToUnit
    )

    table('acceptance-texel', [
      { sampler: 'ground', od: groundOD, formula: 'min(b, g*dToFront)' },
      { sampler: 'inCloud', od: inCloudOD, formula: 'min(b+a, g*dToFront)' }
    ])

    // Ground: min(2, 1 * max(0, 3 - 0/1)) = min(2, 3) = 2
    expect(groundOD).toBe(2)
    // In-cloud: min(2+5, 1 * max(0, 3 - 0 - 0/1)) = min(7, 3) = 3
    expect(inCloudOD).toBe(3)

    // They differ by the tail term capping at shadow.b vs shadow.b+shadow.a
    expect(inCloudOD).toBeGreaterThan(groundOD)
  })

  it('acceptance: r=1×worldToUnit → distanceToFront=2 for both', () => {
    const worldToUnit = 0.001
    const shadow = { r: 1 * worldToUnit, g: 1, b: 100, a: 100 }
    const distanceToTop = 3

    const groundOD = cpuReadGroundShadowOpticalDepth(
      shadow,
      distanceToTop,
      worldToUnit
    )
    const inCloudOD = cpuReadShadowOpticalDepth(
      shadow,
      distanceToTop,
      0,
      worldToUnit
    )

    // distanceToFront = 3 - 1*worldToUnit/worldToUnit = 3 - 1 = 2
    // ground: min(100, 1*2) = 2
    // inCloud: min(200, 1*2) = 2
    expect(groundOD).toBe(2)
    expect(inCloudOD).toBe(2)

    log('unit-conversion', {
      worldToUnit,
      storedR: shadow.r,
      decodedFrontDepth: shadow.r / worldToUnit,
      distanceToFront: 2,
      groundOD,
      inCloudOD
    })
  })

  it('large OD: ground caps at shadow.b, in-cloud at shadow.b+shadow.a', () => {
    const shadow = { r: 0, g: 10, b: 1.5, a: 0.8 }
    const distanceToTop = 1000
    const worldToUnit = 1

    const groundOD = cpuReadGroundShadowOpticalDepth(
      shadow,
      distanceToTop,
      worldToUnit
    )
    const inCloudOD = cpuReadShadowOpticalDepth(
      shadow,
      distanceToTop,
      0,
      worldToUnit
    )

    // Both hit the cap: extinction path = 10 * 1000 = 10000
    // Ground cap: min(1.5, 10000) = 1.5
    // In-cloud cap: min(1.5+0.8, 10000) = 2.3
    expect(groundOD).toBe(1.5)
    expect(inCloudOD).toBe(2.3)

    table('cap-comparison', [
      { sampler: 'ground', od: groundOD, cap: shadow.b },
      { sampler: 'inCloud', od: inCloudOD, cap: shadow.b + shadow.a }
    ])
  })

  it('when extinction path < both caps, both samplers agree', () => {
    const shadow = { r: 0, g: 0.001, b: 100, a: 50 }
    const distanceToTop = 500
    const worldToUnit = 1

    const groundOD = cpuReadGroundShadowOpticalDepth(
      shadow,
      distanceToTop,
      worldToUnit
    )
    const inCloudOD = cpuReadShadowOpticalDepth(
      shadow,
      distanceToTop,
      0,
      worldToUnit
    )

    // extinction path = 0.001 * 500 = 0.5, which is < 100 and < 150
    expect(groundOD).toBeCloseTo(0.5)
    expect(inCloudOD).toBeCloseTo(0.5)
    expect(groundOD).toBeCloseTo(inCloudOD)
  })
})

describe('source verification', () => {
  it('ground sampler does NOT use shadow.a (no tail)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleCloudShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    // Ground formula uses min(shadow.b, ...), with no .a addition
    expect(source).toContain('min(shadow.b, shadow.g.mul(distanceToFront))')
    expect(source).not.toContain('shadow.b.add(shadow.a)')
    expect(source).toContain('Cite: aerialPerspectiveEffect.frag:177–183')
    expect(source).not.toContain(
      'Cite: clouds.frag:172–183 — ground formula omits tail'
    )
  })

  it('in-cloud sampler DOES use shadow.a (tail term)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('shadow.b.add(shadow.a)')
  })

  it('createCloudShadowTransmittance is exported', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleCloudShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('export function createCloudShadowTransmittance')
  })

  it('factory accepts CloudShadowDescriptor (descriptor-based API)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleCloudShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain(
      'createSampleCloudShadowOpticalDepth(\n  descriptor: CloudShadowDescriptor'
    )
    expect(source).toContain('import type { CloudShadowDescriptor }')
    // The live handle, not the raw texture (a stale build-time
    // capture). Matched without whitespace so prettier's line breaks cannot
    // fail it
    const flat = source.replace(/\s+/g, '')
    expect(flat).toContain('descriptor.mapNode.sample(')
    // ...with an explicit LOD: in the march and PCF loops implicit LOD is
    // undefined in WGSL and returned ~zeros, and .level(float(0)) is
    // derivative-free
    expect(flat).toContain('.level(float(0))')
    expect(source).not.toContain('texture(descriptor.map,')
    expect(source).toContain('descriptor.intervals')
    expect(source).toContain('descriptor.matrices')
    expect(source).toContain('descriptor.far')
    expect(source).toContain('descriptor.topHeight')
    expect(source).toContain('descriptor.texelSize')
  })

  it('ground sampler has no distanceOffset parameter', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleCloudShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    // readGroundShadowOpticalDepth takes (uv, distanceToTop, cascadeIndex)
    // NOT (uv, distanceToTop, distanceOffset, cascadeIndex) like the in-cloud one
    expect(source).toContain(
      'readGroundShadowOpticalDepth = Fn(\n    ([uv, distanceToTop, cascadeIndex]'
    )
  })

  it('enabled=false factory returns constant float(1)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(
        new URL('./sampleCloudShadowOpticalDepth.ts', import.meta.url).pathname,
        'utf8'
      )
    )
    expect(source).toContain('!enabled || descriptor.cascadeCount === 0')
    expect(source).toContain('float(1)')
  })
})
