// CPU reference for the 4D periodic Perlin noise behind the procedural
// texture generators. Cite:
// reference/clouds/src/shaders/perlin.glsl, itself GLM's gtc/noise.inl:
// https://github.com/g-truc/glm/blob/master/glm/gtc/noise.inl
// Written from the GLSL, so the shader is checked against something else

export type Vec4 = readonly [number, number, number, number]

const map4 = (v: Vec4, f: (n: number) => number): Vec4 => [
  f(v[0]),
  f(v[1]),
  f(v[2]),
  f(v[3])
]

const zip4 = (a: Vec4, b: Vec4, f: (x: number, y: number) => number): Vec4 => [
  f(a[0], b[0]),
  f(a[1], b[1]),
  f(a[2], b[2]),
  f(a[3], b[3])
]

/** GLSL `mod`: floored, so the result carries the sign of the divisor */
export const glslMod = (x: number, y: number): number =>
  x - y * Math.floor(x / y)

/** GLSL `fract`: always in [0, 1), including for negative inputs */
export const glslFract = (x: number): number => x - Math.floor(x)

/** GLSL `step(edge, x)`, argument order as in the spec */
export const glslStep = (edge: number, x: number): number => (x < edge ? 0 : 1)

const mod289 = (v: Vec4): Vec4 =>
  map4(v, x => x - Math.floor(x * (1 / 289)) * 289)

const permute = (v: Vec4): Vec4 => mod289(map4(v, x => (x * 34 + 1) * x))

const taylorInvSqrt = (v: Vec4): Vec4 =>
  map4(v, r => 1.79284291400159 - 0.85373472095314 * r)

const fade = (v: Vec4): Vec4 =>
  map4(v, x => x * x * x * (x * (x * 6 - 15) + 10))

const dot4 = (a: Vec4, b: Vec4): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * One of the four gradient sets. The GLSL repeats this block verbatim for
 * ixy00/01/10/11 and only the permuted index vector varies, so it is factored
 * here rather than transcribed four times.
 *
 * Returns the four gradients packed as columns: gx/gy/gz/gw each hold one
 * component of four different gradients
 */
function gradients(ixy: Vec4): { gx: Vec4; gy: Vec4; gz: Vec4; gw: Vec4 } {
  const gxRaw = map4(ixy, x => x / 7)
  const gyRaw = map4(gxRaw, x => Math.floor(x) / 7)
  const gzRaw = map4(gyRaw, x => Math.floor(x) / 6)

  let gx = map4(gxRaw, x => glslFract(x) - 0.5)
  let gy = map4(gyRaw, x => glslFract(x) - 0.5)
  const gz = map4(gzRaw, x => glslFract(x) - 0.5)

  const gw = [0, 1, 2, 3].map(
    i => 0.75 - Math.abs(gx[i]!) - Math.abs(gy[i]!) - Math.abs(gz[i]!)
  ) as unknown as Vec4

  // `sw` marks the gradients that fell outside the tetrahedron. The two
  // corrections below reflect them back in
  const sw = map4(gw, x => glslStep(x, 0))
  gx = zip4(gx, sw, (g, s) => g - s * (glslStep(0, g) - 0.5))
  gy = zip4(gy, sw, (g, s) => g - s * (glslStep(0, g) - 0.5))

  return { gx, gy, gz, gw }
}

/**
 * Classic Perlin noise, periodic in `rep`.
 *
 * `perlin(p, rep) === perlin(p + rep, rep)` for every component, which is what
 * makes the generated textures tile. Returns roughly [-1, 1] (the GLSL's
 * trailing 2.2 scale), and exactly 0 at integer lattice points.
 */
export function perlinReference(position: Vec4, rep: Vec4): number {
  const floored = map4(position, Math.floor)
  const Pi0 = zip4(floored, rep, glslMod)
  const Pi1 = zip4(
    map4(Pi0, x => x + 1),
    rep,
    glslMod
  )
  const Pf0 = map4(position, glslFract)
  const Pf1 = map4(Pf0, x => x - 1)

  const ix: Vec4 = [Pi0[0], Pi1[0], Pi0[0], Pi1[0]]
  const iy: Vec4 = [Pi0[1], Pi0[1], Pi1[1], Pi1[1]]
  const iz0: Vec4 = [Pi0[2], Pi0[2], Pi0[2], Pi0[2]]
  const iz1: Vec4 = [Pi1[2], Pi1[2], Pi1[2], Pi1[2]]
  const iw0: Vec4 = [Pi0[3], Pi0[3], Pi0[3], Pi0[3]]
  const iw1: Vec4 = [Pi1[3], Pi1[3], Pi1[3], Pi1[3]]

  const ixy = permute(zip4(permute(ix), iy, (a, b) => a + b))
  const ixy0 = permute(zip4(ixy, iz0, (a, b) => a + b))
  const ixy1 = permute(zip4(ixy, iz1, (a, b) => a + b))

  const g00 = gradients(permute(zip4(ixy0, iw0, (a, b) => a + b)))
  const g01 = gradients(permute(zip4(ixy0, iw1, (a, b) => a + b)))
  const g10 = gradients(permute(zip4(ixy1, iw0, (a, b) => a + b)))
  const g11 = gradients(permute(zip4(ixy1, iw1, (a, b) => a + b)))

  const pick = (
    g: { gx: Vec4; gy: Vec4; gz: Vec4; gw: Vec4 },
    i: 0 | 1 | 2 | 3
  ): Vec4 => [g.gx[i], g.gy[i], g.gz[i], g.gw[i]]

  // Sixteen hypercube corners. The naming is the GLSL's: bit order is x,y,z,w.
  let g0000 = pick(g00, 0)
  let g1000 = pick(g00, 1)
  let g0100 = pick(g00, 2)
  let g1100 = pick(g00, 3)
  let g0010 = pick(g10, 0)
  let g1010 = pick(g10, 1)
  let g0110 = pick(g10, 2)
  let g1110 = pick(g10, 3)
  let g0001 = pick(g01, 0)
  let g1001 = pick(g01, 1)
  let g0101 = pick(g01, 2)
  let g1101 = pick(g01, 3)
  let g0011 = pick(g11, 0)
  let g1011 = pick(g11, 1)
  let g0111 = pick(g11, 2)
  let g1111 = pick(g11, 3)

  const scale = (v: Vec4, s: number): Vec4 => map4(v, x => x * s)

  // ORDER matters: the GLSL normalises (0000, 0100, 1000, 1100), y and z
  // swapped relative to the naming, and the multiplies follow it. Writing
  // x,y,z,w pairs each gradient with another's normalisation factor
  const n00 = taylorInvSqrt([
    dot4(g0000, g0000),
    dot4(g0100, g0100),
    dot4(g1000, g1000),
    dot4(g1100, g1100)
  ])
  g0000 = scale(g0000, n00[0])
  g0100 = scale(g0100, n00[1])
  g1000 = scale(g1000, n00[2])
  g1100 = scale(g1100, n00[3])

  const n01 = taylorInvSqrt([
    dot4(g0001, g0001),
    dot4(g0101, g0101),
    dot4(g1001, g1001),
    dot4(g1101, g1101)
  ])
  g0001 = scale(g0001, n01[0])
  g0101 = scale(g0101, n01[1])
  g1001 = scale(g1001, n01[2])
  g1101 = scale(g1101, n01[3])

  const n10 = taylorInvSqrt([
    dot4(g0010, g0010),
    dot4(g0110, g0110),
    dot4(g1010, g1010),
    dot4(g1110, g1110)
  ])
  g0010 = scale(g0010, n10[0])
  g0110 = scale(g0110, n10[1])
  g1010 = scale(g1010, n10[2])
  g1110 = scale(g1110, n10[3])

  const n11 = taylorInvSqrt([
    dot4(g0011, g0011),
    dot4(g0111, g0111),
    dot4(g1011, g1011),
    dot4(g1111, g1111)
  ])
  g0011 = scale(g0011, n11[0])
  g0111 = scale(g0111, n11[1])
  g1011 = scale(g1011, n11[2])
  g1111 = scale(g1111, n11[3])

  const P = (x: 0 | 1, y: 0 | 1, z: 0 | 1, w: 0 | 1): Vec4 => [
    x ? Pf1[0] : Pf0[0],
    y ? Pf1[1] : Pf0[1],
    z ? Pf1[2] : Pf0[2],
    w ? Pf1[3] : Pf0[3]
  ]

  const n0000 = dot4(g0000, Pf0)
  const n1000 = dot4(g1000, P(1, 0, 0, 0))
  const n0100 = dot4(g0100, P(0, 1, 0, 0))
  const n1100 = dot4(g1100, P(1, 1, 0, 0))
  const n0010 = dot4(g0010, P(0, 0, 1, 0))
  const n1010 = dot4(g1010, P(1, 0, 1, 0))
  const n0110 = dot4(g0110, P(0, 1, 1, 0))
  const n1110 = dot4(g1110, P(1, 1, 1, 0))
  const n0001 = dot4(g0001, P(0, 0, 0, 1))
  const n1001 = dot4(g1001, P(1, 0, 0, 1))
  const n0101 = dot4(g0101, P(0, 1, 0, 1))
  const n1101 = dot4(g1101, P(1, 1, 0, 1))
  const n0011 = dot4(g0011, P(0, 0, 1, 1))
  const n1011 = dot4(g1011, P(1, 0, 1, 1))
  const n0111 = dot4(g0111, P(0, 1, 1, 1))
  const n1111 = dot4(g1111, Pf1)

  const f = fade(Pf0)
  const n0w: Vec4 = [
    mix(n0000, n0001, f[3]),
    mix(n1000, n1001, f[3]),
    mix(n0100, n0101, f[3]),
    mix(n1100, n1101, f[3])
  ]
  const n1w: Vec4 = [
    mix(n0010, n0011, f[3]),
    mix(n1010, n1011, f[3]),
    mix(n0110, n0111, f[3]),
    mix(n1110, n1111, f[3])
  ]
  const nzw: Vec4 = [
    mix(n0w[0], n1w[0], f[2]),
    mix(n0w[1], n1w[1], f[2]),
    mix(n0w[2], n1w[2], f[2]),
    mix(n0w[3], n1w[3], f[2])
  ]
  const nyzw0 = mix(nzw[0], nzw[2], f[1])
  const nyzw1 = mix(nzw[1], nzw[3], f[1])

  return 2.2 * mix(nyzw0, nyzw1, f[0])
}
