// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Vector3 } from 'three'
import {
  dot,
  exp,
  float,
  Fn,
  If,
  max,
  normalize,
  sqrt,
  uniform,
  vec3
} from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'

import {
  accuratePhaseFunctionTSL,
  phaseFunctionTSL
} from '../lighting/phaseFunction'

// A flash is a point source inside the cloud volume, so it contributes to the
// march the way any other light does, one in-scatter term per shaded sample
// Nothing here is time-dependent, so the shader carries no clock

// The one instant the consumer sets and clears, in the ECEF metres the march
// works in and the linear RGB the rest of the lighting uses
export interface LightningState {
  // Flash origin, ECEF metres. Inside the cloud volume for the effect to read
  position: Vector3
  // Radiance scale. 0 is exactly off, so an idle storm needs no graph rebuild
  intensity: number
  // Linear RGB tint of the discharge
  colour: Vector3
}

export interface LightningParams {
  // Softening length in metres on the inverse-square falloff. A true point
  // light diverges at its own position and every sample near it goes to
  // infinity
  softening: number
  // Iterations for the secondary march toward the flash. 6 covers about
  // 1.05 km at the default `minSecondaryStepSize` 100 and `secondaryStepScale` 2
  depthIterationCount: number
  // Phase function attenuation, raised for a discharge's forward scattering
  phaseAttenuation: number
}

export const lightningParamsDefault: Readonly<LightningParams> = Object.freeze({
  softening: 400,
  depthIterationCount: 6,
  phaseAttenuation: 1
})

export interface LightningUniforms {
  position: UniformNode<'vec3', Vector3>
  intensity: UniformNode<'float', number>
  colour: UniformNode<'vec3', Vector3>
  // 1 while a flash is lit, 0 otherwise. Read as a uniform, not a graph branch
  active: UniformNode<'float', number>
}

const ZERO = new Vector3()

// A null flash is a real state, not an absent one: the uniforms exist whenever
// the option is on so a consumer can strike and clear without a rebuild
export function createLightningUniforms(
  state: LightningState | null
): LightningUniforms {
  return {
    position: uniform(state?.position.clone() ?? new Vector3()).setName(
      'lightning_position'
    ),
    intensity: uniform(state?.intensity ?? 0).setName('lightning_intensity'),
    colour: uniform(state?.colour.clone() ?? new Vector3(1, 1, 1)).setName(
      'lightning_colour'
    ),
    active: uniform(state != null && state.intensity > 0 ? 1 : 0).setName(
      'lightning_active'
    )
  }
}

export function updateLightningUniforms(
  uniforms: LightningUniforms,
  state: LightningState | null
): void {
  uniforms.position.value.copy(state?.position ?? ZERO)
  uniforms.intensity.value = state?.intensity ?? 0
  uniforms.colour.value.copy(state?.colour ?? ZERO)
  uniforms.active.value = state != null && state.intensity > 0 ? 1 : 0
}

// The seam the march consumes. Null when the option is off, and null emits no
// nodes at all, which is the whole of the byte-identity argument
export interface LightningDeps {
  inScatter: (
    position: Node<'vec3'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec3'>
}

export interface LightningBuildDeps {
  // The sun march's own function, reused rather than a second march written
  marchOpticalDepth: (
    rayOrigin: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    maxIterationCount: Node<'float'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ) => Node<'vec2'>
  // The camera, to recover the ray direction at a shaded sample
  cameraPosition: Node<'vec3'>
  accuratePhaseFunction: boolean
  scatterAnisotropy1: number
  scatterAnisotropy2: number
  scatterAnisotropyMix: number
  uniforms: LightningUniforms
  params: LightningParams
}

// RECIPROCAL_PI4, as the sun and sky terms use it
const RECIPROCAL_PI4 = 1 / (4 * Math.PI)

// In-scattered radiance from one flash at one shaded sample. Reuses the sun's
// secondary march for the extinction between the sample and the flash, so a
// discharge behind a dense core is occluded rather than shining through it
export function buildLightningDeps(deps: LightningBuildDeps): LightningDeps {
  const {
    marchOpticalDepth,
    cameraPosition,
    accuratePhaseFunction,
    scatterAnisotropy1,
    scatterAnisotropy2,
    scatterAnisotropyMix,
    uniforms,
    params
  } = deps

  const phase = Fn(([cosTheta]: [Node<'float'>]) =>
    accuratePhaseFunction
      ? accuratePhaseFunctionTSL(cosTheta, float(params.phaseAttenuation))
      : phaseFunctionTSL(
          cosTheta,
          float(params.phaseAttenuation),
          float(scatterAnisotropy1),
          float(scatterAnisotropy2),
          float(scatterAnisotropyMix)
        )
  )

  const inScatter = Fn(
    ([position, mipLevel, jitter]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      // Uniform flow throughout: the sample is always inside the shell the
      // primary march reached, and softening keeps the falloff finite there
      const toFlash = uniforms.position.sub(position)
      const distanceSq = max(
        dot(toFlash, toFlash),
        float(params.softening * params.softening)
      )
      const distance = sqrt(distanceSq)
      const lightDirection = toFlash.div(distance)

      // Same angle convention as the sun: the direction to the light against
      // the ray direction. The ray leaves the camera, so the view direction at a
      // shaded sample is the sample minus the camera (cloudsFragment.ts:456)
      const viewDirection = normalize(position.sub(cameraPosition))
      const cosTheta = dot(lightDirection, viewDirection)

      const opticalDepth = marchOpticalDepth(
        position,
        lightDirection,
        float(params.depthIterationCount),
        mipLevel,
        jitter
      ).x

      return uniforms.colour
        .mul(uniforms.intensity.div(distanceSq))
        .mul(exp(opticalDepth.negate()))
        .mul(phase(cosTheta))
        .mul(RECIPROCAL_PI4)
    }
  )

  // A Fn, not a plain closure, because it emits an If and the gate fails
  // control flow outside a measured body. Uniform because `active` is, so an
  // idle storm skips the march rather than paying for a term worth zero
  const guarded = Fn(
    ([position, mipLevel, jitter]: [
      Node<'vec3'>,
      Node<'float'>,
      Node<'float'>
    ]) => {
      const contribution = vec3(0).toVar()
      If(uniforms.active.greaterThan(0.5), () => {
        contribution.assign(inScatter(position, mipLevel, jitter))
      })
      return contribution
    }
  )

  return { inScatter: guarded }
}

// CPU twin of the in-scatter term. extinction is the total optical depth
// toward the flash, which the GPU gets from the reused secondary march
export function lightningInScatterCPU(
  colour: [number, number, number],
  intensity: number,
  distanceSq: number,
  opticalDepth: number,
  phaseValue: number
): [number, number, number] {
  const falloff = intensity / distanceSq
  const transmittance = Math.exp(-opticalDepth)
  const scale = falloff * transmittance * phaseValue * RECIPROCAL_PI4
  return [colour[0] * scale, colour[1] * scale, colour[2] * scale]
}

// The softening as the shader applies it, so a caller can predict the falloff
export function lightningDistanceSqCPU(
  distanceSq: number,
  softening: number
): number {
  return Math.max(distanceSq, softening * softening)
}

// A stroke group is two quick strokes then a slow decay. Real discharges
// flicker, and one exponential reads as a camera flash rather than lightning
const STROKES = [0, 0.055, 0.14]

// Seconds for a stroke to reach full scale. Also where its decay begins
const STROKE_ATTACK = 0.012

export interface FlashScheduleOptions {
  // Seconds between the start of one stroke group and the next
  interval: number
  // Seconds one stroke takes to fall to nothing
  duration: number
  // Peak intensity of the first stroke, relative to the consumer's scale
  peak: number
  // Peak intensity of each restrike, as a fraction of the first
  restrikeRatio: number
}

export const flashScheduleDefaults: Readonly<FlashScheduleOptions> =
  Object.freeze({
    interval: 4,
    duration: 0.42,
    peak: 1,
    restrikeRatio: 0.55
  })

export interface FlashSample {
  // 0 before the first stroke, back to 0 after the group ends
  intensity: number
  // Seconds into the current stroke group, for a caller that gates on it
  timeInGroup: number
}

// The envelope at `time`, given a seed. Deterministic and seek-safe: `time` in,
// intensity out, with no state to carry between calls
export function flashEnvelopeCPU(
  time: number,
  seed: number,
  options: Readonly<FlashScheduleOptions> = flashScheduleDefaults
): FlashSample {
  const { interval, duration, peak, restrikeRatio } = options
  if (interval <= 0 || duration <= 0 || time < 0) {
    return { intensity: 0, timeInGroup: 0 }
  }
  const group = Math.floor(time / interval)
  const timeInGroup = time - group * interval
  // A seeded per-group offset, so two cells do not flash on the same frame
  const jitter = seededUnit(group, seed) * duration * 0.25
  const local = timeInGroup - jitter
  if (local < 0 || local > duration) {
    return { intensity: 0, timeInGroup }
  }
  let intensity = 0
  for (const [index, offset] of STROKES.entries()) {
    const since = local - offset
    if (since < 0) continue
    const scale = index === 0 ? peak : peak * restrikeRatio
    // The decay starts once the stroke is up, not at the stroke's onset, so a
    // stroke reaches exactly `scale`. Starting both at the onset made the
    // nominal peak unreachable and the parameter a lie by about 11%
    const attack = Math.min(1, since / STROKE_ATTACK)
    const decay = Math.exp(-Math.max(0, since - STROKE_ATTACK) / (duration / 4))
    intensity = Math.max(intensity, scale * attack * decay)
  }
  return { intensity, timeInGroup }
}

// A 32-bit hash of one integer, mapped to [0, 1). Deterministic, no state
export function seededUnit(index: number, seed: number): number {
  let h = Math.imul(index + 1, 374761393) ^ Math.imul(seed + 1, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// A seeded strike on a shell, so a demo scene storms with no scene code of its
// own. Consumers place their own flashes for anything richer
export function flashPositionCPU(
  index: number,
  seed: number,
  bottomRadius: number,
  altitude: number
): Vector3 {
  // Two hashed angles, so the sequence never revisits a spot and never clusters
  const azimuth = seededUnit(index * 2, seed) * Math.PI * 2
  const polar = Math.acos(1 - 2 * seededUnit(index * 2 + 1, seed))
  const radius = bottomRadius + altitude
  return new Vector3(
    radius * Math.sin(polar) * Math.cos(azimuth),
    radius * Math.sin(polar) * Math.sin(azimuth),
    radius * Math.cos(polar)
  )
}
