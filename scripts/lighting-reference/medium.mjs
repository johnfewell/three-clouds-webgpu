// The phase function, the volumetric path tracer, and the analytic case that
// checks the tracer. The tracer solves the real multiple scattering problem by
// Monte Carlo, with next-event estimation to the sun
//
// Cite: src/lighting/phaseFunction.ts (the phase the port compiles in)
// https://pbr-book.org/4ed/Light_Transport_II_Volume_Rendering/Volume_Scattering_Integrators

const RECIPROCAL_PI4 = 1 / (4 * Math.PI)

/** The Henyey-Greenstein lobe, normalised so that the integral over the sphere is 1 */
export function henyeyGreenstein(g, cosTheta) {
  const g2 = g * g
  const denom = Math.max(1e-7, Math.pow(1 + g2 - 2 * g * cosTheta, 1.5))
  return (RECIPROCAL_PI4 * (1 - g2)) / denom
}

/**
 * The dual-lobe phase the port uses, with the lobe weights mixed
 * Mirrors src/lighting/phaseFunction.ts phaseFunction()
 */
export function phaseFunction(cosTheta, attenuation, g1, g2, mix) {
  const lobe1 = henyeyGreenstein(g1 * attenuation, cosTheta)
  const lobe2 = henyeyGreenstein(g2 * attenuation, cosTheta)
  return lobe1 * (1 - mix) + lobe2 * mix
}

/** The phase the experiment uses: the port's default anisotropies, no attenuation */
export function scenePhase(cosTheta, scene) {
  return phaseFunction(
    cosTheta,
    1,
    scene.scatterAnisotropy1,
    scene.scatterAnisotropy2,
    scene.scatterAnisotropyMix
  )
}

/**
 * Sample a cosine from a Henyey-Greenstein lobe. The classic inversion, and
 * for g < 0 the lobe is mirrored
 */
export function sampleHenyeyGreenstein(g, u) {
  if (Math.abs(g) < 1e-3) return 1 - 2 * u
  const absG = Math.abs(g)
  const sqr = (1 - absG * absG) / (1 - absG + 2 * absG * u)
  const cosTheta = (1 + absG * absG - sqr * sqr) / (2 * absG)
  return g < 0 ? -cosTheta : cosTheta
}

/** An orthonormal basis around a direction */
function basis(direction) {
  const helper = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const t0 = normalize(cross(helper, direction))
  const t1 = cross(direction, t0)
  return [t0, t1]
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}

/**
 * Sample a direction from the dual-lobe phase around an axis
 *
 * The lobe is picked with the mix weight and the direction is drawn from that
 * lobe's own density, so the returned direction already follows the mixture density
 */

export function samplePhaseDirection(axis, scene, rng) {
  const mix = scene.scatterAnisotropyMix
  const useFirst = rng() < 1 - mix
  const g = useFirst ? scene.scatterAnisotropy1 : scene.scatterAnisotropy2
  const cosTheta = sampleHenyeyGreenstein(g, rng())
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  const phi = 2 * Math.PI * rng()
  const [t0, t1] = basis(axis)
  const direction = [
    axis[0] * cosTheta +
      (t0[0] * Math.cos(phi) + t1[0] * Math.sin(phi)) * sinTheta,
    axis[1] * cosTheta +
      (t0[1] * Math.cos(phi) + t1[1] * Math.sin(phi)) * sinTheta,
    axis[2] * cosTheta +
      (t0[2] * Math.cos(phi) + t1[2] * Math.sin(phi)) * sinTheta
  ]
  return { direction: normalize(direction), weight: 1 }
}

// The seeded generator

/**
 * mulberry32: a small, fast, reproducible generator
 * The seed is derived per pixel and per cell, so a run is bit-for-bit
 * repeatable and one pixel can be re-run on its own
 */
export function createRng(seed) {
  let state = seed >>> 0
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seed from a string and an index, so every sample site is reproducible */
export function hashSeed(text, index) {
  let h = 2166136261 >>> 0
  const key = `${text}:${index}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= Math.imul(index + 1, 2654435761)
  return h >>> 0
}

// Ray geometry

/**
 * The ray's intersection with a spherical shell, as a list of [start, end]
 * intervals along the ray
 */
export function rayShellIntervals(origin, direction, rInner, rOuter) {
  const intervals = []
  const a =
    direction[0] * direction[0] +
    direction[1] * direction[1] +
    direction[2] * direction[2]
  const solve = radius => {
    const b =
      2 *
      (origin[0] * direction[0] +
        origin[1] * direction[1] +
        origin[2] * direction[2])
    const c =
      origin[0] * origin[0] +
      origin[1] * origin[1] +
      origin[2] * origin[2] -
      radius * radius
    const discriminant = b * b - 4 * a * c
    if (discriminant < 0) return null
    const root = Math.sqrt(discriminant)
    return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
  }
  const outer = solve(rOuter)
  if (outer == null) return intervals
  const start = Math.max(0, outer[0])
  const end = outer[1]
  if (end <= start) return intervals
  const inner = solve(rInner)
  if (inner != null) {
    const innerStart = Math.max(start, inner[0])
    const innerEnd = Math.min(end, inner[1])
    if (innerEnd > innerStart) {
      if (innerStart > start) intervals.push([start, innerStart])
      if (end > innerEnd) intervals.push([innerEnd, end])
    } else {
      intervals.push([start, end])
    }
  } else {
    intervals.push([start, end])
  }
  return intervals
}

/** The bands the density lives in, as radius pairs */
export function bandRadii(bands, bottomRadius) {
  return bands.map(([base, top]) => [bottomRadius + base, bottomRadius + top])
}

// The path tracer

// Deterministic optical-depth integration requires step-refinement checks
// This is not ratio tracking and can be biased for varying density
export function sunTransmittance(
  position,
  sunDirection,
  medium,
  scene,
  rng,
  distance = 0
) {
  if (medium.transmittance != null)
    return medium.transmittance(position, sunDirection, rng)
  const intervals = medium.intervals(position, sunDirection)
  let opticalDepth = 0
  for (const [start, end] of intervals) {
    const steps = Math.max(1, Math.ceil((end - start) / scene.shadowStepSize))
    const stepSize = (end - start) / steps
    for (let i = 0; i < steps; i++) {
      const t = start + (i + 0.5) * stepSize
      const point = [
        position[0] + sunDirection[0] * t,
        position[1] + sunDirection[1] * t,
        position[2] + sunDirection[2] * t
      ]
      opticalDepth +=
        checkedExtinction(medium.extinctionAt(point, distance)) * stepSize
    }
  }
  return Math.exp(-opticalDepth)
}

function validateTrace(options) {
  if (!Number.isInteger(options.samples) || options.samples < 1)
    throw new Error('samples must be a positive integer')
  for (const key of ['stepSize', 'shadowStepSize']) {
    if (!Number.isFinite(options.scene[key]) || options.scene[key] <= 0)
      throw new Error(`${key} must be finite and positive`)
  }
  validateDirections(options)
  const limit = options.maxBounces ?? 32
  if (!Number.isInteger(limit) || limit < 0 || limit > 1024)
    throw new Error('maxBounces must be between 0 and 1024')
}

function validateDirections(options) {
  for (const key of ['origin', 'direction', 'sunDirection']) {
    const vector = options[key]
    if (vector.length !== 3 || vector.some(value => !Number.isFinite(value)))
      throw new Error(`${key} must have three finite coordinates`)
    if (key !== 'origin' && Math.abs(Math.hypot(...vector) - 1) > 1e-9)
      throw new Error(`${key} must be a unit direction`)
  }
  if (options.maxDistance != null && options.maxDistance !== Infinity)
    throw new Error('Finite maxDistance needs an explicit boundary model')
  for (const key of ['scatterAnisotropy1', 'scatterAnisotropy2']) {
    if (
      !Number.isFinite(options.scene[key]) ||
      Math.abs(options.scene[key]) >= 1
    )
      throw new Error(`${key} must be strictly between -1 and 1`)
  }
  const mix = options.scene.scatterAnisotropyMix
  if (!Number.isFinite(mix) || mix < 0 || mix > 1)
    throw new Error('Phase mix must be between zero and one')
}

function checkedExtinction(value) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error('Extinction must be finite and nonnegative')
  return value
}

function skyAtEscape(options, origin, direction, throughput, bounce, result) {
  if (bounce === 0 || options.skyRadiance == null) return
  const sky = options.skyRadiance(direction, origin)
  if (
    sky.length !== 3 ||
    sky.some(value => !Number.isFinite(value) || value < 0)
  )
    throw new Error('Sky radiance must have three finite nonnegative channels')
  for (let channel = 0; channel < 3; channel++) {
    const value = throughput * sky[channel]
    result.sky[channel] += value
    if (bounce === 1) result.skySingle[channel] += value
  }
}

function connectSun(options, hit, direction, distance, throughput, rng) {
  const { medium, scene, sunDirection } = options
  const { extinction, scattering } = medium.densityAt(hit.point, distance)
  if (
    !(extinction > 0) ||
    !Number.isFinite(scattering) ||
    scattering < 0 ||
    scattering > extinction
  )
    throw new Error('Invalid medium coefficients at a collision')
  const albedo = scattering / extinction
  const cosine = sunDirection.reduce(
    (sum, value, axis) => sum + value * direction[axis],
    0
  )
  const transmission = sunTransmittance(
    hit.point,
    sunDirection,
    medium,
    scene,
    rng,
    distance
  )
  return {
    albedo,
    contribution: throughput * albedo * scenePhase(cosine, scene) * transmission
  }
}

function traceSample(options, rng, result) {
  const { medium, scene, maxBounces = 32, maxDistance = Infinity } = options
  let throughput = 1
  let direction = options.direction
  let origin = options.origin
  let distance = 0
  // One extra intersection distinguishes an escaped path from a truncated one
  for (let bounce = 0; bounce <= maxBounces + 1; bounce++) {
    const hit = findNextCollision(
      origin,
      direction,
      medium,
      scene,
      rng,
      maxDistance,
      distance
    )
    if (hit == null) {
      skyAtEscape(options, origin, direction, throughput, bounce, result)
      return
    }
    if (bounce > maxBounces) {
      result.truncated++
      return
    }
    distance += hit.distance
    const sun = connectSun(options, hit, direction, distance, throughput, rng)
    result.total += sun.contribution
    if (bounce === 0) result.single += sun.contribution
    throughput *= sun.albedo
    if (throughput === 0) return
    if (bounce >= 3) {
      const survival = Math.min(0.95, throughput)
      if (rng() > survival) return
      throughput /= survival
    }
    direction = samplePhaseDirection(direction, scene, rng).direction
    origin = hit.point
  }
}

export function traceInScatteredRadiance(options) {
  validateTrace(options)
  const rng = createRng(options.seed)
  const result = {
    total: 0,
    single: 0,
    sky: [0, 0, 0],
    skySingle: [0, 0, 0],
    truncated: 0
  }
  for (let sample = 0; sample < options.samples; sample++)
    traceSample(options, rng, result)
  return {
    total: result.total / options.samples,
    single: result.single / options.samples,
    sky: result.sky.map(value => value / options.samples),
    skySingle: result.skySingle.map(value => value / options.samples),
    truncatedSamples: result.truncated
  }
}

// Midpoint coefficients define piecewise homogeneous free-flight intervals
// Collision offsets follow the conditional exponential within the selected step
function findNextCollision(
  origin,
  direction,
  medium,
  scene,
  rng,
  maxDistance,
  baseDistance = 0
) {
  if (medium.sampleCollision != null)
    return medium.sampleCollision(origin, direction, rng)
  const intervals = medium.intervals(origin, direction)
  for (const [start, end] of intervals) {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    )
      throw new Error(
        'Medium intervals must be finite ordered forward distances'
      )
    const limit = Math.min(end, maxDistance)
    if (limit <= start) continue
    const steps = Math.max(1, Math.ceil((limit - start) / scene.stepSize))
    const stepSize = (limit - start) / steps
    for (let i = 0; i < steps; i++) {
      const t = start + (i + 0.5) * stepSize
      const point = [
        origin[0] + direction[0] * t,
        origin[1] + direction[1] * t,
        origin[2] + direction[2] * t
      ]
      const extinction = checkedExtinction(
        medium.extinctionAt(point, baseDistance + t)
      )
      if (extinction <= 0) continue
      const tau = extinction * stepSize
      const survive = Math.exp(-tau)
      if (rng() < 1 - survive) {
        // The position inside the step, from the truncated exponential
        const u = rng()
        const offset = -Math.log(1 - u * (1 - survive)) / extinction
        const hitT = start + i * stepSize + Math.min(offset, stepSize)
        return {
          point: [
            origin[0] + direction[0] * hitT,
            origin[1] + direction[1] * hitT,
            origin[2] + direction[2] * hitT
          ],
          distance: hitT
        }
      }
    }
  }
  return null
}

// The analytic case

/**
 * The single-scattered radiance of a homogeneous slab, in closed form
 *
 * The slab fills 0 < z < height, the sun is at the zenith and the view makes
 * the angle whose cosine is viewCos with the vertical. The integral of
 * sigma_s exp(-sigma_t s) exp(-sigma_t (height - s viewCos)) over the path
 * has a closed form, so the tracer's single-scattered estimate can be checked
 * against a number rather than against another estimate
 */
export function analyticHomogeneousSingleScatter(options) {
  const {
    sigmaS,
    sigmaT,
    height,
    viewCos,
    phaseAt,
    sunIrradiance = 1
  } = options
  const phase = phaseAt
  if (sigmaT === 0) return (sigmaS * phase * sunIrradiance * height) / viewCos
  if (Math.abs(viewCos - 1) < 1e-9) {
    return sigmaS * phase * sunIrradiance * height * Math.exp(-sigmaT * height)
  }
  const pathLength = height / viewCos
  const numerator = 1 - Math.exp(-sigmaT * pathLength * (1 - viewCos))
  const denominator = sigmaT * (1 - viewCos)
  return (
    (sigmaS * phase * sunIrradiance * Math.exp(-sigmaT * height) * numerator) /
    denominator
  )
}

/**
 * A medium that is a homogeneous slab along one axis, for the analytic case
 * The slab runs from z = 0 to z = height, and the sun is at the zenith
 */
export function createHomogeneousMedium(options) {
  const { sigmaS, sigmaT, height } = options
  if (
    ![sigmaS, sigmaT, height].every(Number.isFinite) ||
    sigmaS < 0 ||
    sigmaT < sigmaS ||
    height <= 0
  )
    throw new Error('Invalid homogeneous medium coefficients or height')
  const extinctionAt = () => sigmaT
  const densityAt = () => ({
    extinction: sigmaT,
    scattering: sigmaS,
    densitySum: 1
  })
  const intervals = (origin, direction) => {
    // The ray enters the slab at z = 0 and leaves at z = height
    const dz = direction[2]
    if (dz === 0) {
      if (origin[2] > 0 && origin[2] < height)
        throw new Error('Infinite horizontal slab paths need a bounded fixture')
      return []
    }
    const t0 = (0 - origin[2]) / dz
    const t1 = (height - origin[2]) / dz
    const start = Math.max(0, Math.min(t0, t1))
    const end = Math.max(t0, t1)
    if (end <= start) return []
    return [[start, end]]
  }
  return { extinctionAt, densityAt, intervals }
}
