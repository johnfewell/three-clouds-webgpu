// Keyframed camera paths for film shots. A pose is a pure function of shot
// time, so a frame-locked recording renders the same frame for the same t

export interface PathKey {
  // Seconds into the shot
  t: number
  // Metres in the shot frame: forward, up, right
  p: readonly [number, number, number]
  // Degrees clockwise from the shot frame's forward axis
  heading: number
  // Degrees above the horizon
  pitch: number
  roll?: number
  // Vertical field of view in degrees
  fov?: number
}

export interface CameraSample {
  p: [number, number, number]
  heading: number
  pitch: number
  roll: number
  fov: number
}

export interface PathOptions {
  // Zero velocity at the first key, so a shot can open on a held frame
  easeIn?: boolean
  // Zero velocity at the last key
  easeOut?: boolean
}

const DEFAULT_FOV = 55

function channel(key: PathKey, index: number): number {
  switch (index) {
    case 0:
      return key.p[0]
    case 1:
      return key.p[1]
    case 2:
      return key.p[2]
    case 3:
      return key.heading
    case 4:
      return key.pitch
    case 5:
      return key.roll ?? 0
    default:
      return key.fov ?? DEFAULT_FOV
  }
}

function secant(keys: readonly PathKey[], i: number, c: number): number {
  const a = keys[i]
  const b = keys[i + 1]
  return (channel(b, c) - channel(a, c)) / (b.t - a.t)
}

// Monotone (Fritsch-Carlson) tangent, so a slow segment next to a fast one
// never overshoots its keys: a camera easing off the water stays above it
function tangent(
  keys: readonly PathKey[],
  i: number,
  c: number,
  options: PathOptions
): number {
  const last = keys.length - 1
  if (i === 0) return options.easeIn !== false ? 0 : secant(keys, 0, c)
  if (i === last) {
    return options.easeOut === true ? 0 : secant(keys, last - 1, c)
  }
  const left = secant(keys, i - 1, c)
  const right = secant(keys, i, c)
  if (left === 0 || right === 0 || Math.sign(left) !== Math.sign(right)) {
    return 0
  }
  const a = keys[i - 1]
  const b = keys[i + 1]
  const central = (channel(b, c) - channel(a, c)) / (b.t - a.t)
  const limit = 3 * Math.min(Math.abs(left), Math.abs(right))
  return Math.sign(central) * Math.min(Math.abs(central), limit)
}

export function samplePath(
  keys: readonly PathKey[],
  t: number,
  options: PathOptions = {}
): CameraSample {
  if (keys.length === 0) throw new Error('film: a path needs at least one key')
  const first = keys[0]
  const lastKey = keys[keys.length - 1]
  const time = Math.min(Math.max(t, first.t), lastKey.t)
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].t < time) ++i
  const a = keys[i]
  const b = keys[Math.min(i + 1, keys.length - 1)]
  const span = b.t - a.t
  const values: number[] = []
  for (let c = 0; c < 7; ++c) {
    if (span <= 0) {
      values.push(channel(a, c))
      continue
    }
    const s = (time - a.t) / span
    const s2 = s * s
    const s3 = s2 * s
    const m0 = tangent(keys, i, c, options) * span
    const m1 =
      tangent(keys, Math.min(i + 1, keys.length - 1), c, options) * span
    values.push(
      (2 * s3 - 3 * s2 + 1) * channel(a, c) +
        (s3 - 2 * s2 + s) * m0 +
        (-2 * s3 + 3 * s2) * channel(b, c) +
        (s3 - s2) * m1
    )
  }
  return {
    p: [values[0], values[1], values[2]],
    heading: values[3],
    pitch: values[4],
    roll: values[5],
    fov: values[6]
  }
}
