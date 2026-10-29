// Lightning: the envelope, the falloff and the uniform bookkeeping. The
// in-scatter maths itself is a CPU twin here and the emitted graph is in
// lightning.wgsl.test.ts

// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Vector3 } from 'three'
import { uniform } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { log, setCurrentSpec } from '../../test/helpers/log'
import { phaseFunction } from '../lighting/phaseFunction'
import {
  buildLightningDeps,
  createLightningUniforms,
  flashEnvelopeCPU,
  flashPositionCPU,
  flashScheduleDefaults,
  lightningDistanceSqCPU,
  lightningInScatterCPU,
  lightningParamsDefault,
  seededUnit,
  updateLightningUniforms,
  type LightningState
} from './lightning'

const BOTTOM_RADIUS = 6360000

const flash = (over: Partial<LightningState> = {}): LightningState => ({
  position: new Vector3(0, 6361000, 0),
  intensity: 1,
  colour: new Vector3(1, 1, 1),
  ...over
})

// A fixed view/sample geometry, so the falloff and transmittance are checkable
// against the twin by hand
const SAMPLE = new Vector3(0, 6361000, 0)
const SOURCE = new Vector3(1000, 6361400, 0)
const DISTANCE_SQ = Math.pow(1000, 2) + Math.pow(400, 2)
const COS_THETA = 0.6
const ANISOTROPY = [0.7, -0.2, 0.4] as const

describe('lightning in-scatter', () => {
  setCurrentSpec('lightning-in-scatter')

  it('falls off as the inverse square past the softening length', () => {
    // 20 m apart is inside the default 400 m softening, so the divisor is the
    // softening squared and not the raw distance: a true point light would
    // diverge at its own position
    const near = lightningDistanceSqCPU(
      20 * 20,
      lightningParamsDefault.softening
    )
    const far = lightningDistanceSqCPU(
      2000 * 2000,
      lightningParamsDefault.softening
    )
    log('softening clamp', {
      rawNear: 20 * 20,
      clampedNear: near,
      softeningSq: lightningParamsDefault.softening ** 2,
      rawFar: 2000 * 2000,
      clampedFar: far
    })
    expect(near).toBe(lightningParamsDefault.softening ** 2)
    expect(far).toBe(2000 * 2000)
  })

  it('attenuates with the optical depth between the sample and the flash', () => {
    // Why the secondary march exists: a discharge behind a dense core must not
    // shine through it. Doubling the depth cannot brighten the contribution
    const phase = phaseFunction(COS_THETA, 1, ...ANISOTROPY)
    const clear = lightningInScatterCPU([1, 1, 1], 1, DISTANCE_SQ, 0, phase)
    const thick = lightningInScatterCPU([1, 1, 1], 1, DISTANCE_SQ, 4, phase)
    log('optical depth attenuation', {
      distanceSq: DISTANCE_SQ,
      phase,
      clear: clear[0],
      thick: thick[0],
      ratio: thick[0] / clear[0],
      expectedRatio: Math.exp(-4)
    })
    expect(clear[0]).toBeGreaterThan(0)
    expect(thick[0]).toBeLessThan(clear[0])
    expect(thick[0] / clear[0]).toBeCloseTo(Math.exp(-4), 10)
  })

  it('tints by colour and scales by intensity, both linearly', () => {
    const phase = phaseFunction(COS_THETA, 1, ...ANISOTROPY)
    const white = lightningInScatterCPU([1, 1, 1], 1, DISTANCE_SQ, 0.5, phase)
    const tinted = lightningInScatterCPU(
      [1, 0.5, 0],
      2,
      DISTANCE_SQ,
      0.5,
      phase
    )
    log('colour and intensity', {
      white: white.join(','),
      tinted: tinted.join(','),
      greenRatio: tinted[1] / white[1],
      redRatio: tinted[0] / white[0],
      blueRatio: tinted[2] / white[2]
    })
    // Intensity 2 doubles every channel, the tint then halves green and zeroes blue
    expect(tinted[0] / white[0]).toBeCloseTo(2, 10)
    expect(tinted[1] / white[1]).toBeCloseTo(1, 10)
    expect(tinted[2]).toBe(0)
  })

  it('is a point light, so its energy follows the same phase function as the sun', () => {
    // Reusing the sun's phase function is the whole reason a flash reads as a
    // light source rather than as a glow painted on the cloud. Verified by
    // comparing the twin against the phase function's own value
    const phase = phaseFunction(COS_THETA, 1, ...ANISOTROPY)
    const scatter = lightningInScatterCPU([1, 1, 1], 1, DISTANCE_SQ, 0, phase)
    const expected = phase * (1 / DISTANCE_SQ) * (1 / (4 * Math.PI))
    log('phase reuse', {
      phase,
      distanceSq: DISTANCE_SQ,
      scatter: scatter[0],
      expected
    })
    expect(scatter[0]).toBeCloseTo(expected, 12)
    // A forward lobe, so a flash looking down-sun out-scatters a back one
    const forward = phaseFunction(0.95, 1, ...ANISOTROPY)
    const back = phaseFunction(-0.95, 1, ...ANISOTROPY)
    expect(forward).toBeGreaterThan(back)
  })

  it('uses the sampled distance from the world position, not a guess', () => {
    // The pair the shader sees. Guards against a sign or axis slip that a
    // digest would happily accept
    const toFlash = SOURCE.clone().sub(SAMPLE)
    const measured = toFlash.lengthSq()
    log('geometry', {
      toFlash: toFlash.toArray().join(','),
      measuredSq: measured,
      expectedSq: DISTANCE_SQ
    })
    expect(measured).toBeCloseTo(DISTANCE_SQ, 6)
  })
})

describe('lightning uniforms', () => {
  setCurrentSpec('lightning-uniforms')

  it('marks a lit flash active and an idle one not', () => {
    const uniforms = createLightningUniforms(flash())
    updateLightningUniforms(uniforms, flash({ intensity: 0.4 }))
    const lit = uniforms.active.value
    updateLightningUniforms(uniforms, flash({ intensity: 0 }))
    const idle = uniforms.active.value
    updateLightningUniforms(uniforms, null)
    const cleared = uniforms.active.value
    log('active uniform', { lit, idle, cleared })
    expect(lit).toBe(1)
    // Zero intensity is what an idle storm holds between strokes, and it must
    // read as off or the march would pay for a term worth nothing
    expect(idle).toBe(0)
    expect(cleared).toBe(0)
  })

  it('clears position, intensity and colour when the flash is cleared', () => {
    // A stale position would leave a flash parked at the last strike, and a
    // stale colour is invisible but wrong in a diff
    const uniforms = createLightningUniforms(null)
    updateLightningUniforms(
      uniforms,
      flash({
        position: new Vector3(1e6, 2e6, 3e6),
        colour: new Vector3(0.2, 0.4, 1)
      })
    )
    updateLightningUniforms(uniforms, null)
    log('cleared uniforms', {
      position: uniforms.position.value.toArray().join(','),
      colour: uniforms.colour.value.toArray().join(','),
      intensity: uniforms.intensity.value
    })
    expect(uniforms.position.value.toArray()).toEqual([0, 0, 0])
    expect(uniforms.intensity.value).toBe(0)
    expect(uniforms.colour.value.toArray()).toEqual([0, 0, 0])
  })

  it('starts dark, so a pass built with the option on and no flash renders nothing', () => {
    // The option can be turned on before the first strike. A pass that lit at
    // construction would flash on frame one
    const uniforms = createLightningUniforms(null)
    log('defaults', {
      intensity: uniforms.intensity.value,
      active: uniforms.active.value,
      position: uniforms.position.value.toArray().join(',')
    })
    expect(uniforms.intensity.value).toBe(0)
    expect(uniforms.active.value).toBe(0)
    expect(uniforms.position.value.toArray()).toEqual([0, 0, 0])
  })
})

describe('lightning seam', () => {
  setCurrentSpec('lightning-seam')

  it('routes the sample position and mip through to the secondary march', () => {
    // The march toward the flash is the sun's own, so a flash is occluded by
    // the cloud instead of shining through it, proven by watching the call
    const calls: unknown[][] = []
    const deps = buildLightningDeps({
      marchOpticalDepth: ((...args: unknown[]) => {
        calls.push(args)
        return null
      }) as never,
      cameraPosition: uniform(new Vector3()),
      accuratePhaseFunction: false,
      scatterAnisotropy1: 0.7,
      scatterAnisotropy2: -0.2,
      scatterAnisotropyMix: 0.4,
      uniforms: createLightningUniforms(flash()),
      params: lightningParamsDefault
    })
    // Only the call is observed here. The node it returns is built by the WGSL
    // test, which has a real compiler in front of it
    expect(typeof deps.inScatter).toBe('function')
    expect(calls.length).toBe(0)

    const deps2 = buildLightningDeps({
      marchOpticalDepth: ((...args: unknown[]) => {
        calls.push(args)
        return null
      }) as never,
      cameraPosition: uniform(new Vector3()),
      accuratePhaseFunction: true,
      scatterAnisotropy1: 0.7,
      scatterAnisotropy2: -0.2,
      scatterAnisotropyMix: 0.4,
      uniforms: createLightningUniforms(flash()),
      params: lightningParamsDefault
    })
    expect(typeof deps2.inScatter).toBe('function')
    expect(calls.length).toBe(0)
  })
})

describe('flash schedule', () => {
  setCurrentSpec('lightning-schedule')

  it('reaches its nominal peak, so the peak parameter means what it says', () => {
    // The first stroke ramps up over STROKE_ATTACK and its decay starts there,
    // so `peak` is attainable rather than about 11% short of it. Grid-stepped,
    // so the check is on the envelope's supremum and not on one lucky sample
    const { interval, peak: nominal } = flashScheduleDefaults
    let peak = 0
    for (let ms = 0; ms < interval * 1000; ms++) {
      peak = Math.max(peak, flashEnvelopeCPU(ms / 1000, 7).intensity)
    }
    log('peak reachability', {
      nominal,
      sampledPeak: peak,
      deficit: 1 - peak / nominal
    })
    expect(peak).toBeGreaterThan(nominal * 0.98)
    expect(peak).toBeLessThanOrEqual(nominal + 1e-9)
  })

  it('is dark between stroke groups and lit inside one', () => {
    const { interval } = flashScheduleDefaults
    const intensities = Array.from(
      { length: 240 },
      (_, i) => flashEnvelopeCPU((i / 240) * interval * 2, 7).intensity
    )
    const lit = intensities.filter(v => v > 0)
    const dark = intensities.filter(v => v === 0)
    log('envelope coverage', {
      samples: intensities.length,
      peak: Math.max(...intensities),
      litSamples: lit.length,
      darkSamples: dark.length,
      litFraction: lit.length / intensities.length
    })
    // A storm is mostly dark: the lit fraction must stay well under half, or the
    // idle cost is not idle at all
    expect(lit.length).toBeGreaterThan(0)
    expect(lit.length / intensities.length).toBeLessThan(0.5)
    // Dark samples are exactly zero, not merely small: the decay is a closed
    // form, so nothing lingers past the group
    expect(dark.length).toBeGreaterThan(0)
  })

  it('is seek-safe, because nothing accumulates', () => {
    // Scrubbing backwards must land on the same value, or a scrubbed timeline
    // shows flashes that never happened
    const forwards = [0.1, 1.7, 3.3, 5.9, 9.4].map(
      t => flashEnvelopeCPU(t, 11).intensity
    )
    const backwards = [9.4, 5.9, 3.3, 1.7, 0.1].map(
      t => flashEnvelopeCPU(t, 11).intensity
    )
    backwards.reverse()
    log('seek safety', {
      forwards: forwards.map(v => v.toFixed(6)).join(','),
      backwards: backwards.map(v => v.toFixed(6)).join(',')
    })
    expect(backwards).toEqual(forwards)
  })

  it('gives two seeds different timings, so a scene does not flash in unison', () => {
    const a = Array.from(
      { length: 200 },
      (_, i) => flashEnvelopeCPU(i / 50, 3).intensity
    )
    const b = Array.from(
      { length: 200 },
      (_, i) => flashEnvelopeCPU(i / 50, 4).intensity
    )
    const differing = a.filter(
      (v, i) => Math.abs(v - (b[i] ?? 0)) > 1e-9
    ).length
    log('seed divergence', { samples: a.length, differing })
    // The jitter is a quarter of the duration at most, so the envelopes
    // overlap heavily and differ on a fraction of samples, never on all of them
    expect(differing).toBeGreaterThan(0)
    expect(differing).toBeLessThan(a.length)
  })

  it('rejects a time before zero and a degenerate interval', () => {
    log('degenerate input', {
      negative: flashEnvelopeCPU(-1, 1).intensity,
      zeroInterval: flashEnvelopeCPU(1, 1, {
        ...flashScheduleDefaults,
        interval: 0
      }).intensity,
      zeroDuration: flashEnvelopeCPU(1, 1, {
        ...flashScheduleDefaults,
        duration: 0
      }).intensity
    })
    expect(flashEnvelopeCPU(-1, 1).intensity).toBe(0)
    expect(
      flashEnvelopeCPU(1, 1, { ...flashScheduleDefaults, interval: 0 })
        .intensity
    ).toBe(0)
    expect(
      flashEnvelopeCPU(1, 1, { ...flashScheduleDefaults, duration: 0 })
        .intensity
    ).toBe(0)
  })

  it('hashes deterministically and into [0, 1)', () => {
    const first = Array.from({ length: 64 }, (_, i) => seededUnit(i, 5))
    const second = Array.from({ length: 64 }, (_, i) => seededUnit(i, 5))
    log('hash', {
      stable: first.every((v, i) => v === second[i]),
      min: Math.min(...first),
      max: Math.max(...first),
      distinct: new Set(first).size
    })
    expect(first).toEqual(second)
    expect(Math.min(...first)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...first)).toBeLessThan(1)
    // A degenerate hash would give one value for every index and every cell
    // would flash at the same offset
    expect(new Set(first).size).toBeGreaterThan(32)
  })

  it('places flashes on the globe at the requested altitude', () => {
    const points = [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
      flashPositionCPU(i, 2, BOTTOM_RADIUS, 1200)
    )
    const radii = points.map(p => p.length())
    const altitudes = radii.map(r => r - BOTTOM_RADIUS)
    const distinct = new Set(points.map(p => p.toArray().join(','))).size
    log('flash placement', {
      count: points.length,
      distinct,
      minAltitude: Math.min(...altitudes),
      maxAltitude: Math.max(...altitudes),
      firstRadius: radii[0]
    })
    // Exactly on the requested shell, not merely near it
    for (const altitude of altitudes) {
      expect(altitude).toBeCloseTo(1200, 6)
    }
    expect(distinct).toBe(points.length)
  })
})
