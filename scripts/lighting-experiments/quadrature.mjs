// Equal-solid-angle diagnostic rules, not a production sky-light sampler
export function sphereDirections(count) {
  if (!Number.isInteger(count) || count < 1 || count > 65536) {
    throw new Error('Direction count must be an integer from 1 to 65536')
  }
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: count }, (_, i) => {
    const z = 1 - (2 * (i + 0.5)) / count
    const radius = Math.sqrt(1 - z * z)
    return [
      radius * Math.cos(i * goldenAngle),
      radius * Math.sin(i * goldenAngle),
      z
    ]
  })
}

export function candidateDirections() {
  const axes = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ]
  const corners = Array.from({ length: 8 }, (_, i) =>
    [i & 1, (i >> 1) & 1, (i >> 2) & 1].map(bit => (2 * bit - 1) / Math.sqrt(3))
  )
  return { axes6: axes, corners8: corners }
}

export function integrateUniformSky(directions, view, phase) {
  if (directions.length === 0)
    throw new Error('Cannot integrate zero directions')
  let sum = 0
  for (const direction of directions) {
    const cosine = direction.reduce(
      (dot, component, axis) => dot + component * view[axis],
      0
    )
    const value = phase(Math.min(1, Math.max(-1, cosine)))
    if (!Number.isFinite(value) || value < 0)
      throw new Error('Invalid phase value')
    sum += value
  }
  return (sum * 4 * Math.PI) / directions.length
}

// A normalized phase under uniform unit radiance must integrate to one
export function uniformSkyAudit(directions, views, phase, tolerance) {
  if (views.length === 0) throw new Error('Cannot audit zero views')
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw new Error('Invalid tolerance')
  const values = views.map(view => integrateUniformSky(directions, view, phase))
  const maximumError = Math.max(...values.map(value => Math.abs(value - 1)))
  return {
    directions: directions.length,
    views: views.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    maximumError,
    tolerance,
    passed: maximumError <= tolerance
  }
}

// Integrate phase over nearest-direction cells instead of sampling it at centers
// The dense rule only computes weights, while incident radiance uses the cache sites
export function integrateCellSky(directions, dense, view, phase, radiance) {
  if (directions.length === 0 || dense.length === 0)
    throw new Error('Cannot integrate zero directions')
  const values = directions.map(radiance)
  if (values.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('Invalid incident radiance')
  let sum = 0
  for (const sample of dense) {
    const nearest = nearestDirection(directions, sample)
    const cosine = sample.reduce((dot, value, i) => dot + value * view[i], 0)
    const weight = phase(Math.min(1, Math.max(-1, cosine)))
    if (!Number.isFinite(weight) || weight < 0)
      throw new Error('Invalid phase value')
    sum += weight * values[nearest]
  }
  return (sum * 4 * Math.PI) / dense.length
}

function nearestDirection(directions, sample) {
  let best = -Infinity
  let nearest = 0
  for (let i = 0; i < directions.length; i++) {
    const dot = directions[i].reduce(
      (sum, value, axis) => sum + value * sample[axis],
      0
    )
    if (dot > best) {
      best = dot
      nearest = i
    }
  }
  return nearest
}
