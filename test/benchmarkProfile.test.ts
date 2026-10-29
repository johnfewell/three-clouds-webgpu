import { describe, expect, it } from 'vitest'

import {
  ATMOSPHERE_MODES,
  RAYMARCH_MODES,
  summarisePasses,
  validateAtmosphereReceipt,
  validateProfileOptions,
  type ProfilePass
} from '../examples/parity/scripts/benchmarks/profile.mjs'
import {
  atmosphereProfileModes,
  profileRaymarches
} from '../examples/parity/src/atmosphereProfile'

const pass = (name: string, ms: number): ProfilePass => ({
  type: 'render',
  uid: '1:f1',
  names: [name],
  startNs: '1',
  endNs: '2',
  ms
})

describe('diagnostic GPU profiling', () => {
  // The benchmark scripts are plain .mjs and keep their own copy of the
  // harness profile lists. This pins the copy to atmosphereProfile.ts
  it('matches the harness atmosphere profiles and their raymarch rule', () => {
    expect([...ATMOSPHERE_MODES]).toEqual([...atmosphereProfileModes])
    expect([...RAYMARCH_MODES]).toEqual(
      atmosphereProfileModes.filter(profileRaymarches)
    )
  })

  it('verifies actual per-consumer counts and integration, refusing empty receipts', () => {
    const receipt = {
      integration: { cloudsRaymarch: true, sceneRaymarch: true },
      frames: [
        [
          { ...pass('CloudsPass', 1), scatteringSamples: [256, 256] },
          { ...pass('RenderPipeline', 1), scatteringSamples: [64, 64] }
        ]
      ]
    }
    expect(() =>
      validateAtmosphereReceipt(receipt, 'samples-scene-64')
    ).not.toThrow()
    expect(() =>
      validateAtmosphereReceipt(receipt, 'samples-clouds-64')
    ).toThrow(/per-pass/)
    expect(() => validateAtmosphereReceipt(receipt, 'lookup-both')).toThrow(
      /integration/
    )
    expect(() =>
      validateAtmosphereReceipt({ ...receipt, frames: [] }, 'reference')
    ).toThrow(/Empty/)
    expect(() =>
      validateAtmosphereReceipt({ ...receipt, frames: [[]] }, 'raymarch-256')
    ).toThrow(/per-pass/)
    // ADR-013 Amendment 6: 'reference' is the LUT lookup. A lookup receipt must
    // show raymarch off on both consumers and is not held to any sample count
    const lookup = {
      integration: { cloudsRaymarch: false, sceneRaymarch: false },
      frames: [[{ ...pass('CloudsPass', 1), scatteringSamples: [4, 14] }]]
    }
    for (const mode of ['reference', 'lookup-both'] as const)
      expect(() => validateAtmosphereReceipt(lookup, mode)).not.toThrow()
    expect(() => validateAtmosphereReceipt(receipt, 'reference')).toThrow(
      /integration/
    )
    expect(() =>
      validateProfileOptions(
        { qualityScreen: true, scatteringSamples: [64, 64] },
        'webgpu'
      )
    ).toThrow(/combined/)
  })
  it('keeps the parity setting unless an explicit ablation is requested', () => {
    expect(() => validateProfileOptions({}, 'webgpu')).not.toThrow()
    expect(() =>
      validateProfileOptions({ scatteringSamples: [4, 14] }, 'webgpu')
    ).not.toThrow()
    expect(() => validateProfileOptions({}, 'webgl')).toThrow(/WebGPU/)
    for (const samples of [
      [0, 14],
      [14, 4],
      [1.5, 14],
      [4, Infinity],
      [1, 513]
    ])
      expect(() =>
        validateProfileOptions(
          { scatteringSamples: samples as [number, number] },
          'webgpu'
        )
      ).toThrow(/integers/)
  })

  it('groups repeated passes within each frame without claiming a frame total', () => {
    const summary = summarisePasses([
      [pass('ShadowPass', 1), pass('ShadowPass', 2), pass('CloudsPass', 9)],
      [pass('ShadowPass', 4)]
    ])
    expect(summary['render:ShadowPass']).toEqual({
      framesPresent: 2,
      medianMs: 3.5,
      values: [3, 4]
    })
    expect(summary['render:CloudsPass']?.framesPresent).toBe(1)
  })

  it('rejects empty, unlabelled, or invalid measurements', () => {
    expect(() => summarisePasses([])).toThrow(/zero frames/)
    expect(() => summarisePasses([[]])).toThrow(/zero passes/)
    expect(() => summarisePasses([[{ ...pass('', 1), names: [] }]])).toThrow(
      /Unlabelled/
    )
    expect(() => summarisePasses([[pass('CloudsPass', NaN)]])).toThrow(
      /Invalid/
    )
  })
})
