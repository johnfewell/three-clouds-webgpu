// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Four shape controls the port lacks: a darker base, a horizon coverage bank, a
// wind shear and one rounded-to-wispy edge knob. Every magnitude is a
// graph-time literal, and docs/EXPERIMENTAL.md has the prose and the costs
import { clamp, cross, float, Fn, max, smoothstep, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// Neutral is every magnitude at zero, so an untouched context reads as the
// reference on all four
export interface CloudShapeParams {
  // Beer extinction of the sun by the cloud above a sample, so a base is
  // darker than its top. Zero is off
  baseShadowStrength: number
  // Fraction of the layer the darkening spans, 0 to 1. Read only when
  // baseShadowStrength is non-zero
  baseShadowHeight: number
  // Coverage added to every lane past horizonCoverageStart, so a distant sky
  // reads more overcast than the weather map alone would give it. Zero is off,
  // and a negative amount thins the distance instead
  horizonCoverageAmount: number
  // Metres from the camera where the bank starts
  horizonCoverageStart: number
  // Metres over which it reaches the full amount
  horizonCoverageRamp: number
  // Horizontal lean of the cloud tops, in metres at the top of the layer
  // relative to its base, along the local east and north. Both zero is off
  windSkewEast: number
  windSkewNorth: number
  // Scales how hard the shape texture carves an edge: 0 is the reference, 1
  // carves twice as hard for thin wispy edges, and a negative value carves
  // less for rounded solid ones
  erosionShape: number
}

export const cloudShapeDefaults: Readonly<CloudShapeParams> = Object.freeze({
  baseShadowStrength: 0,
  baseShadowHeight: 0.3,
  horizonCoverageAmount: 0,
  horizonCoverageStart: 8000,
  horizonCoverageRamp: 40000,
  windSkewEast: 0,
  windSkewNorth: 0,
  erosionShape: 0
})

// Which of the four are on, and by how much. The cache key and the graph
// rebuild both read this, so a value that changes while a feature is already
// on still moves the program
export function cloudShapeKey(params: Readonly<CloudShapeParams>): string {
  return [
    params.baseShadowStrength,
    params.baseShadowHeight,
    params.horizonCoverageAmount,
    params.horizonCoverageStart,
    params.horizonCoverageRamp,
    params.windSkewEast,
    params.windSkewNorth,
    params.erosionShape
  ].join(',')
}

// Transmittance of the sun through the cloud above a sample at normalized
// height h. Beer-Lambert over the depth still to climb, so it is 1 at the top
// and exp(-strength) at the base
export const baseShadowTransmittance = /*#__PURE__*/ Fn(
  ([heightFraction, strength, heightSpan]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    // max() for a span of 0, which would divide by zero and hand the base a
    // step of 1 or NaN instead of the ramp the caller asked for
    const depth = clamp(
      float(1)
        .sub(heightFraction)
        .div(max(heightSpan, float(1e-3))),
      0,
      1
    )
    return depth.mul(strength).negate().exp()
  }
)

// Coverage to add at this distance along the view ray: zero inside the start,
// the full amount past start plus ramp. The ramp is floored because WGSL
// smoothstep over equal edges is undefined, so a step is a hard one, not a NaN
export const horizonCoverageBank = /*#__PURE__*/ Fn(
  ([rayDistance, amount, start, ramp]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const width = max(ramp, float(1))
    return smoothstep(start, start.add(width), rayDistance).mul(amount)
  }
)

// How far to displace a sample's shape lookup horizontally, in metres, at this
// normalized height. The lean runs along the local east and north, so it is
// the same compass direction everywhere on the globe
export const windSkewOffset = /*#__PURE__*/ Fn(
  ([surfaceNormal, heightFraction, skewEast, skewNorth]: [
    Node<'vec3'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>
  ]) => {
    const up = vec3(0, 1, 0)
    const eastRaw = cross(up, surfaceNormal)
    const eastLength = eastRaw.length()
    // At a pole eastRaw collapses and normalize would hand back a NaN that
    // spreads through the shape lookup, so the lean fades out as it does
    const east = eastRaw.div(max(eastLength, float(1e-4)))
    const north = cross(surfaceNormal, east)
    const poleFade = smoothstep(float(0), float(0.01), eastLength)
    return east
      .mul(skewEast)
      .add(north.mul(skewNorth))
      .mul(heightFraction)
      .mul(poleFade)
  }
)

// The per-lane shape amount with the edge control folded in. Only the carve is
// scaled, so the amount a layer's own shapeAmount asked for still decides how
// much noise reaches it
export const erosionShapeAmount = /*#__PURE__*/ Fn(
  ([amounts, erosion]: [Node<'vec4'>, Node<'float'>]) => {
    return amounts.mul(max(erosion.add(1), float(0)))
  }
)

// The polar axis, for the CPU twin's cross products. The shader builds the
// same vector with vec3(0, 1, 0)
const SKY_AXIS: [number, number, number] = [0, 1, 0]

export function unitVec(v: readonly number[]): [number, number, number] {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!)
  return n === 0 ? [0, 0, 0] : [v[0]! / n, v[1]! / n, v[2]! / n]
}

export function cpuBaseShadowTransmittance(
  heightFraction: number,
  strength: number,
  heightSpan: number
): number {
  const span = Math.max(heightSpan, 1e-3)
  const depth = Math.min(Math.max((1 - heightFraction) / span, 0), 1)
  return Math.exp(-depth * strength)
}

export function cpuHorizonCoverageBank(
  rayDistance: number,
  amount: number,
  start: number,
  ramp: number
): number {
  const width = Math.max(ramp, 1)
  const t = Math.min(Math.max((rayDistance - start) / width, 0), 1)
  // The same shape as smoothstep's cubic: 3t^2 - 2t^3
  return t * t * (3 - 2 * t) * amount
}

export function cpuWindSkewOffset(
  surfaceNormal: readonly number[],
  heightFraction: number,
  skewEast: number,
  skewNorth: number
): number[] {
  const n = unitVec(surfaceNormal)
  const eastRaw: [number, number, number] = [
    SKY_AXIS[1] * n[2] - SKY_AXIS[2] * n[1],
    SKY_AXIS[2] * n[0] - SKY_AXIS[0] * n[2],
    SKY_AXIS[0] * n[1] - SKY_AXIS[1] * n[0]
  ]
  const eastLength = Math.hypot(eastRaw[0], eastRaw[1], eastRaw[2])
  const guard = Math.max(eastLength, 1e-4)
  const east: [number, number, number] = [
    eastRaw[0] / guard,
    eastRaw[1] / guard,
    eastRaw[2] / guard
  ]
  const north: [number, number, number] = [
    n[1] * east[2] - n[2] * east[1],
    n[2] * east[0] - n[0] * east[2],
    n[0] * east[1] - n[1] * east[0]
  ]
  // smoothstep(0, 0.01, x) as above, so the pole fade matches the shader's
  const t = Math.min(eastLength / 0.01, 1)
  const poleFade = t * t * (3 - 2 * t)
  const lean: number[] = []
  for (let i = 0; i < 3; i++) {
    lean.push(
      (east[i]! * skewEast + north[i]! * skewNorth) * heightFraction * poleFade
    )
  }
  return lean
}

export function cpuErosionShapeAmount(amount: number, erosion: number): number {
  return amount * Math.max(erosion + 1, 0)
}

// The four seams. A null field is a feature whose value is zero, and it emits
// no nodes at all: that, rather than a zeroed version of the maths, is what
// keeps the default graph byte-identical to the reference
export interface CloudShapeDeps {
  // primaryMarch.ts: multiplies the direct sun term of a shaded sample
  baseShadow: ((heightFraction: Node<'float'>) => Node<'float'>) | null
  // primaryMarch.ts: added to the weather density of a marched step. A vec4,
  // not a float, because the addition lands outside sampleWeather's lane masking
  horizonCoverage: ((rayDistance: Node<'float'>) => Node<'vec4'>) | null
  // sampleShape.ts: displaces the shape lookup before it is sampled
  windSkew:
    | ((
        surfaceNormal: Node<'vec3'>,
        heightFraction: Node<'float'>
      ) => Node<'vec3'>)
    | null
  // sampleShape.ts: scales the per-lane shape carve
  erosion: ((amounts: Node<'vec4'>) => Node<'vec4'>) | null
}

// The four seams for `params`, with `active` the layer set's live lanes
// The bank lands after sampleWeather's own lane masking, so an inactive lane
// would otherwise read occupied and integrate for nothing (EXPERIMENTAL.md)
export function buildCloudShapeDeps(
  params: Readonly<CloudShapeParams>,
  active: readonly [boolean, boolean, boolean, boolean] = [
    true,
    true,
    true,
    true
  ]
): CloudShapeDeps {
  const lane = (i: number) => (active[i] ? float(1) : float(0))
  const activeMask = vec4(lane(0), lane(1), lane(2), lane(3))
  const strength = float(params.baseShadowStrength)
  const span = float(params.baseShadowHeight)
  const amount = float(params.horizonCoverageAmount)
  const start = float(params.horizonCoverageStart)
  const ramp = float(params.horizonCoverageRamp)
  const skewEast = float(params.windSkewEast)
  const skewNorth = float(params.windSkewNorth)
  const erosion = float(params.erosionShape)
  return {
    baseShadow:
      params.baseShadowStrength > 0
        ? heightFraction =>
            baseShadowTransmittance(heightFraction, strength, span)
        : null,
    horizonCoverage:
      params.horizonCoverageAmount !== 0
        ? rayDistance =>
            vec4(horizonCoverageBank(rayDistance, amount, start, ramp)).mul(
              activeMask
            )
        : null,
    windSkew:
      params.windSkewEast !== 0 || params.windSkewNorth !== 0
        ? (surfaceNormal, heightFraction) =>
            windSkewOffset(surfaceNormal, heightFraction, skewEast, skewNorth)
        : null,
    erosion:
      params.erosionShape !== 0
        ? amounts => erosionShapeAmount(amounts, erosion)
        : null
  }
}
