// Arms 4-7 (pre-registered 2026-09-01 21:15Z): a
// probe-local transcription of the port's tileable noise and localWeather,
// OUTSIDE the package (instrument, not subject). Mirrors src/textures node for
// node, and arm 5 checks it against the package's real target or discards the
// receipt. The argmin variant adds only arm 7's bookkeeping
import { float, Fn, mix, select, sin, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// The neighbourhood is walked x outer, y, z inner, as in the reference loop
// and the port's unrolled loop. Arm 7 reports the winning cell as this index
export const CELL_INDEX = (x: number, y: number, z: number): number =>
  (x + 1) * 9 + (y + 1) * 3 + (z + 1)

// GLSL `mod` floors, WGSL `%` truncates. Same construction as the port.
export const glslMod = (x: Node<'vec3'>, y: Node<'float'>): Node<'vec3'> =>
  x.sub(y.mul(x.div(y).floor()))

// Arm 8: the sine hash's argument in three association orders: T1 as the
// reference and port write it, T2/T3 as a fast-math compiler might reorder. The
// WGSL keeps the parentheses, and whether the backend honours them is measured
export const HASH_SCALE = 43758.5453
export const HASH_SHIFT = 1.951
export function hashOrders(q: Node<'vec3'>): {
  t1: Node<'float'>
  t2: Node<'float'>
  t3: Node<'float'>
} {
  const x = q.x
  const y57 = q.y.mul(57)
  const z113 = q.z.mul(113)
  return {
    t1: sin(x.add(y57).add(z113).add(HASH_SHIFT)).mul(HASH_SCALE).fract(),
    t2: sin(x.add(y57).add(z113.add(HASH_SHIFT)))
      .mul(HASH_SCALE)
      .fract(),
    t3: sin(x.add(y57.add(z113.add(HASH_SHIFT))))
      .mul(HASH_SCALE)
      .fract()
  }
}

export const probeHash = /*#__PURE__*/ Fn(([n]: [Node<'float'>]) =>
  sin(n.add(1.951)).mul(43758.5453).fract()
)

export const probeValueNoise = /*#__PURE__*/ Fn(([x]: [Node<'vec3'>]) => {
  const p = x.floor()
  const f0 = x.fract()
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)))

  const n = p.x.add(p.y.mul(57)).add(p.z.mul(113))
  const h = (offset: number): Node<'float'> => probeHash(n.add(offset))

  return mix(
    mix(mix(h(0), h(1), f.x), mix(h(57), h(58), f.x), f.y),
    mix(mix(h(113), h(114), f.x), mix(h(170), h(171), f.x), f.y),
    f.z
  )
})

export const probeWorley = /*#__PURE__*/ Fn(
  ([p, cellCount]: [Node<'vec3'>, Node<'float'>]) => {
    const cell = p.mul(cellCount)
    const base = cell.floor()

    let d: Node<'float'> = float(1e10)
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const tp = base.add(vec3(x, y, z))
          const jitter = probeValueNoise(glslMod(tp, cellCount))
          const delta = cell.sub(tp).sub(jitter)
          d = d.min(delta.dot(delta))
        }
      }
    }
    return d.clamp(0, 1)
  }
)

// Arm 7: the same march, also reporting WHICH cell won (CELL_INDEX, `y`) and
// its jitter (`z`). The value path (`x`) stays a running min as in probeWorley,
// so "x equals probeWorley" checks the bookkeeping, not a rewrite
export const probeWorleyArgmin = /*#__PURE__*/ Fn(
  ([p, cellCount]: [Node<'vec3'>, Node<'float'>]) => {
    const cell = p.mul(cellCount)
    const base = cell.floor()

    let d: Node<'float'> = float(1e10)
    let index: Node<'float'> = float(-1)
    let winningJitter: Node<'float'> = float(0)
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const tp = base.add(vec3(x, y, z))
          const jitter = probeValueNoise(glslMod(tp, cellCount))
          const delta = cell.sub(tp).sub(jitter)
          const dist = delta.dot(delta)
          const better = dist.lessThan(d)
          index = select(better, float(CELL_INDEX(x, y, z)), index)
          winningJitter = select(better, jitter, winningJitter)
          d = d.min(dist)
        }
      }
    }
    return vec4(d.clamp(0, 1), index, winningJitter, 0)
  }
)

// Arm 10: the march plus ONE named cell's jitter as the march computed it
// (`y`), beside that cell's jitter from a standalone call (`z`). `x` value, `w`
// winning cell index
export const probeWorleyCellJitter = /*#__PURE__*/ Fn(
  ([p, cellCount, named]: [Node<'vec3'>, Node<'float'>, Node<'vec3'>]) => {
    const cell = p.mul(cellCount)
    const base = cell.floor()

    let d: Node<'float'> = float(1e10)
    let index: Node<'float'> = float(-1)
    let namedJitter: Node<'float'> = float(-1)
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const tp = base.add(vec3(x, y, z))
          const jitter = probeValueNoise(glslMod(tp, cellCount))
          const delta = cell.sub(tp).sub(jitter)
          const dist = delta.dot(delta)
          const better = dist.lessThan(d)
          index = select(better, float(CELL_INDEX(x, y, z)), index)
          // The named cell is identified by its offset, matched at graph time
          const isNamed = vec3(x, y, z).equal(named).all()
          namedJitter = select(isNamed, jitter, namedJitter)
          d = d.min(dist)
        }
      }
    }
    const standalone = probeValueNoise(glslMod(base.add(named), cellCount))
    return vec4(d.clamp(0, 1), namedJitter, standalone, index)
  }
)

// localWeather's Worley fbm, as the port writes it: a JS-unrolled octave sum
// over `1 - worley` with fp64-baked amplitudes emitted as literals
export function probeWorleyFbm(
  point: Node<'vec3'>,
  frequency: number,
  amplitude: number,
  lacunarity: number,
  gain: number,
  octaveCount: number
): Node<'float'> {
  let noise: Node<'float'> = float(0)
  let f = frequency
  let a = amplitude
  for (let i = 0; i < octaveCount; i++) {
    noise = noise.add(
      float(1)
        .sub(probeWorley(point, float(f)))
        .mul(a)
    )
    f *= lacunarity
    a *= gain
  }
  return noise
}

// The two composition calls, with the reference's literal parameters
// (localWeather.frag:32-58): mid on point + 0.5 from frequency 8, low on point
// from frequency 16, both amplitude 0.4, lacunarity 2, gain 0.95, 4 octaves
export const MID_FBM = {
  frequency: 8,
  amplitude: 0.4,
  lacunarity: 2,
  gain: 0.95,
  octaves: 4
} as const
export const LOW_FBM = {
  frequency: 16,
  amplitude: 0.4,
  lacunarity: 2,
  gain: 0.95,
  octaves: 4
} as const

// Side A's twin for arm 7, spliced AFTER the package's shader prelude so
// `noise` and `mod` are the package's own. Its control: `.x` equals the
// prelude's getWorleyNoise bit-exactly on every texel
export const REFERENCE_WORLEY_ARGMIN_GLSL = `
vec4 probeWorleyArgmin(const vec3 p, const float cellCount) {
  vec3 cell = p * cellCount;
  float d = 1.0e10;
  float index = -1.0;
  float winningJitter = 0.0;
  for (int x = -1; x <= 1; ++x) {
    for (int y = -1; y <= 1; ++y) {
      for (int z = -1; z <= 1; ++z) {
        vec3 tp = floor(cell) + vec3(x, y, z);
        float jitter = noise(mod(tp, cellCount / 1.0));
        tp = cell - tp - jitter;
        float dist = dot(tp, tp);
        if (dist < d) {
          index = float((x + 1) * 9 + (y + 1) * 3 + (z + 1));
          winningJitter = jitter;
        }
        d = min(d, dist);
      }
    }
  }
  return vec4(clamp(d, 0.0, 1.0), index, winningJitter, 0.0);
}
`

// Side A's twin for arm 10: the reference march with the named cell's in-loop
// jitter captured beside a standalone noise() of the same cell
export const REFERENCE_WORLEY_CELL_JITTER_GLSL = `
vec4 probeWorleyCellJitter(const vec3 p, const float cellCount, const vec3 named) {
  vec3 cell = p * cellCount;
  float d = 1.0e10;
  float index = -1.0;
  float namedJitter = -1.0;
  for (int x = -1; x <= 1; ++x) {
    for (int y = -1; y <= 1; ++y) {
      for (int z = -1; z <= 1; ++z) {
        vec3 tp = floor(cell) + vec3(x, y, z);
        float jitter = noise(mod(tp, cellCount / 1.0));
        tp = cell - tp - jitter;
        float dist = dot(tp, tp);
        if (dist < d) {
          index = float((x + 1) * 9 + (y + 1) * 3 + (z + 1));
        }
        if (all(equal(vec3(x, y, z), named))) {
          namedJitter = jitter;
        }
        d = min(d, dist);
      }
    }
  }
  float standalone = noise(mod(floor(cell) + named, cellCount / 1.0));
  return vec4(clamp(d, 0.0, 1.0), namedJitter, standalone, index);
}
`
