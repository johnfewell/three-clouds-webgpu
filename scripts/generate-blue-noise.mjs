// Offline generator for the default jitter volume (ADR-009)
// `node scripts/generate-blue-noise.mjs` rewrites src/textures/blueNoiseRankMap.ts
// `--candidates <dir>` also writes every candidate volume and its statistics

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WIDTH = 128
export const HEIGHT = 128
export const DEPTH = 64
export const SEED = 0x5eed2026

// Golden ratio conjugate, the per-slice threshold offset of candidate (a)
const PHI = 0.6180339887498949

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussianTable(sigma, radius) {
  const table = new Float64Array(radius + 1)
  for (let d = 0; d <= radius; d++) {
    table[d] = Math.exp(-(d * d) / (2 * sigma * sigma))
  }
  return table
}

// Min/max segment trees over the cells, so each void-and-cluster step finds
// its cell in O(log n). Ties resolve to the lowest index, keeping it
// deterministic
class Trees {
  constructor(size) {
    this.size = size
    this.maxOnes = new Float64Array(2 * size)
    this.minZeros = new Float64Array(2 * size)
  }

  build(bits, energy) {
    const { size, maxOnes, minZeros } = this
    for (let i = 0; i < size; i++) {
      maxOnes[size + i] = bits[i] ? energy[i] : -Infinity
      minZeros[size + i] = bits[i] ? Infinity : energy[i]
    }
    for (let n = size - 1; n >= 1; n--) {
      maxOnes[n] = Math.max(maxOnes[2 * n], maxOnes[2 * n + 1])
      minZeros[n] = Math.min(minZeros[2 * n], minZeros[2 * n + 1])
    }
  }

  set(i, bit, value) {
    const { maxOnes, minZeros } = this
    let n = this.size + i
    maxOnes[n] = bit ? value : -Infinity
    minZeros[n] = bit ? Infinity : value
    for (n >>= 1; n >= 1; n >>= 1) {
      maxOnes[n] = Math.max(maxOnes[2 * n], maxOnes[2 * n + 1])
      minZeros[n] = Math.min(minZeros[2 * n], minZeros[2 * n + 1])
    }
  }

  tightestCluster() {
    const { size, maxOnes } = this
    let n = 1
    while (n < size)
      n = maxOnes[2 * n] >= maxOnes[2 * n + 1] ? 2 * n : 2 * n + 1
    return n - size
  }

  largestVoid() {
    const { size, minZeros } = this
    let n = 1
    while (n < size) {
      n = minZeros[2 * n] <= minZeros[2 * n + 1] ? 2 * n : 2 * n + 1
    }
    return n - size
  }
}

// Void and cluster (Ulichney 1993) on a width x height x depth torus. The
// energy is a spatial Gaussian within a slice plus a temporal Gaussian along a
// pixel, the separate kernel of Wolfe et al. 2022. depth 1 is plain 2D
export function voidAndCluster({
  width,
  height,
  depth = 1,
  sigmaXY,
  sigmaT = 0,
  seed,
  initialFraction = 0.1
}) {
  const area = width * height
  const size = area * depth
  const radiusXY = Math.min(Math.ceil(4 * sigmaXY), (width >> 1) - 1)
  const radiusT = depth > 1 ? Math.min(Math.ceil(4 * sigmaT), depth >> 1) : 0
  const gXY = gaussianTable(sigmaXY, radiusXY)
  const gT = gaussianTable(sigmaT || 1, radiusT)
  const bits = new Uint8Array(size)
  const energy = new Float64Array(size)
  const trees = new Trees(size)
  let tracking = false

  const bump = (j, amount) => {
    energy[j] += amount
    if (tracking) trees.set(j, bits[j], energy[j])
  }
  const splat = (i, sign) => {
    const t = Math.floor(i / area)
    const p = i - t * area
    const y = Math.floor(p / width)
    const x = p - y * width
    for (let dy = -radiusXY; dy <= radiusXY; dy++) {
      const row = t * area + ((y + dy + height) % height) * width
      const wy = gXY[Math.abs(dy)]
      for (let dx = -radiusXY; dx <= radiusXY; dx++) {
        bump(row + ((x + dx + width) % width), sign * wy * gXY[Math.abs(dx)])
      }
    }
    for (let dt = 1; dt <= radiusT; dt++) {
      bump(((t + dt) % depth) * area + p, sign * gT[dt])
      if (dt !== depth - dt) {
        bump(((t - dt + depth) % depth) * area + p, sign * gT[dt])
      }
    }
  }
  const setBit = (i, bit) => {
    bits[i] = bit
    if (tracking) trees.set(i, bit, energy[i])
    splat(i, bit ? 1 : -1)
  }

  const random = mulberry32(seed)
  const initialCount = Math.round(size * initialFraction)
  for (let placed = 0; placed < initialCount;) {
    const i = Math.floor(random() * size)
    if (bits[i]) continue
    setBit(i, 1)
    placed++
  }
  trees.build(bits, energy)
  tracking = true

  // Phase 1: move the tightest cluster into the largest void until stable
  for (let iteration = 0; iteration < size; iteration++) {
    const cluster = trees.tightestCluster()
    setBit(cluster, 0)
    const hole = trees.largestVoid()
    setBit(hole, 1)
    if (hole === cluster) break
  }
  const relaxedBits = bits.slice()
  const relaxedEnergy = energy.slice()

  const rank = new Uint32Array(size)
  // Phase 2: remove clusters, ranking downwards from the initial count
  for (let r = initialCount - 1; r >= 0; r--) {
    const cluster = trees.tightestCluster()
    rank[cluster] = r
    setBit(cluster, 0)
  }
  bits.set(relaxedBits)
  energy.set(relaxedEnergy)
  trees.build(bits, energy)
  // Phase 3: fill voids, ranking upwards to the last cell
  for (let r = initialCount; r < size; r++) {
    const hole = trees.largestVoid()
    rank[hole] = r
    setBit(hole, 1)
  }
  return rank
}

// The 2D rank map of candidate (a), quantized to 8 bits: each value 0..255
// holds 64 pixels. This is the constant the library embeds
export function generateRankMap(seed = SEED) {
  const rank = voidAndCluster({
    width: WIDTH,
    height: HEIGHT,
    sigmaXY: 1.5,
    seed
  })
  const map = new Uint8Array(WIDTH * HEIGHT)
  const shift = Math.log2((WIDTH * HEIGHT) / 256)
  for (let i = 0; i < map.length; i++) map[i] = rank[i] >>> shift
  return map
}

// Per-slice offset of (map + k * phi) mod 1 in 8-bit steps. The library
// mirrors this in createJitterTexture
export function goldenOffsets(depth = DEPTH) {
  const offsets = new Uint8Array(depth)
  for (let k = 0; k < depth; k++) {
    offsets[k] = Math.floor(0.5 + ((k * PHI) % 1) * 256) & 0xff
  }
  return offsets
}

export function goldenVolume(map, depth = DEPTH) {
  const offsets = goldenOffsets(depth)
  const volume = new Uint8Array(map.length * depth)
  for (let k = 0; k < depth; k++) {
    for (let p = 0; p < map.length; p++) {
      volume[k * map.length + p] = (map[p] + offsets[k]) & 0xff
    }
  }
  return volume
}

// Candidate (b): a 3D void and cluster, then each slice is histogram-equalized
// by its own rank order so every frame is a uniform 2D mask
export function spatiotemporalVolume(seed = SEED) {
  const area = WIDTH * HEIGHT
  const rank = voidAndCluster({
    width: WIDTH,
    height: HEIGHT,
    depth: DEPTH,
    sigmaXY: 1.9,
    sigmaT: 1.9,
    seed
  })
  const volume = new Uint8Array(area * DEPTH)
  const order = new Uint32Array(area)
  const shift = Math.log2(area / 256)
  for (let k = 0; k < DEPTH; k++) {
    for (let p = 0; p < area; p++) order[p] = p
    const slice = rank.subarray(k * area, (k + 1) * area)
    order.sort((a, b) => slice[a] - slice[b])
    for (let r = 0; r < area; r++) volume[k * area + order[r]] = r >>> shift
  }
  return volume
}

// Candidate (c), after the FAST method (Donnelly et al. 2024), our own code:
// greedy in-slice swaps minimizing a separate loss, a Gaussian sigma 1 per
// slice plus an exponential alpha 0.1 along a pixel (the TAA history weight)
export function filterAdaptedVolume(seed = SEED, passes = 16) {
  const area = WIDTH * HEIGHT
  const size = area * DEPTH
  const random = mulberry32(seed)
  const bytes = new Uint8Array(size)
  const perm = new Uint32Array(area)
  for (let k = 0; k < DEPTH; k++) {
    for (let p = 0; p < area; p++) perm[p] = p
    for (let p = area - 1; p > 0; p--) {
      const q = Math.floor(random() * (p + 1))
      const swap = perm[p]
      perm[p] = perm[q]
      perm[q] = swap
    }
    for (let p = 0; p < area; p++) bytes[k * area + perm[p]] = p >>> 6
  }
  const value = b => (b + 0.5) / 256 - 0.5
  const r = 3
  const g1 = gaussianTable(1, r)
  let gSum = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) gSum += g1[Math.abs(dy)] * g1[Math.abs(dx)]
  }
  const alpha = 0.1
  const e = new Float64Array(DEPTH)
  for (let d = 0; d < DEPTH; d++) e[d] = alpha * (1 - alpha) ** d
  const fS = new Float64Array(size)
  const fT = new Float64Array(size)
  const cell = (t, x, y) =>
    t * area + ((y + HEIGHT) % HEIGHT) * WIDTH + ((x + WIDTH) % WIDTH)
  const splatS = (i, amount) => {
    const t = Math.floor(i / area)
    const p = i - t * area
    const y = Math.floor(p / WIDTH)
    const x = p - y * WIDTH
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        fS[cell(t, x + dx, y + dy)] +=
          (amount * g1[Math.abs(dy)] * g1[Math.abs(dx)]) / gSum
      }
    }
  }
  const splatT = (i, amount) => {
    const t = Math.floor(i / area)
    const p = i - t * area
    for (let d = 0; d < DEPTH; d++) {
      fT[((t + d) % DEPTH) * area + p] += amount * e[d]
    }
  }
  for (let i = 0; i < size; i++) {
    splatS(i, value(bytes[i]))
    splatT(i, value(bytes[i]))
  }
  let lossS = 0
  let lossT = 0
  for (let i = 0; i < size; i++) {
    lossS += fS[i] * fS[i]
    lossT += fT[i] * fT[i]
  }
  const weightT = lossS / lossT

  // Loss change if cells i and j (same slice) change by di and -di
  const deltaLoss = (i, j, di) => {
    const t = Math.floor(i / area)
    const pi = i - t * area
    const pj = j - t * area
    const yi = Math.floor(pi / WIDTH)
    const xi = pi - yi * WIDTH
    const yj = Math.floor(pj / WIDTH)
    const xj = pj - yj * WIDTH
    let delta = 0
    const wrap = (a, n) => (((a % n) + n + n / 2) % n) - n / 2
    const ox = wrap(xj - xi, WIDTH)
    const oy = wrap(yj - yi, HEIGHT)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const k = cell(t, xi + dx, yi + dy)
        let d = (di * g1[Math.abs(dy)] * g1[Math.abs(dx)]) / gSum
        const jx = dx - ox
        const jy = dy - oy
        if (Math.abs(jx) <= r && Math.abs(jy) <= r) {
          d -= (di * g1[Math.abs(jy)] * g1[Math.abs(jx)]) / gSum
        }
        delta += 2 * fS[k] * d + d * d
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const ix = dx + ox
        const iy = dy + oy
        if (Math.abs(ix) <= r && Math.abs(iy) <= r) continue
        const k = cell(t, xj + dx, yj + dy)
        const d = (-di * g1[Math.abs(dy)] * g1[Math.abs(dx)]) / gSum
        delta += 2 * fS[k] * d + d * d
      }
    }
    for (let d = 0; d < DEPTH; d++) {
      const s = ((t + d) % DEPTH) * area
      const a = di * e[d]
      delta += weightT * (2 * fT[s + pi] * a + a * a)
      delta += weightT * (-2 * fT[s + pj] * a + a * a)
    }
    return delta
  }

  const reach = 8
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < size; i++) {
      const t = Math.floor(i / area)
      const p = i - t * area
      const y = Math.floor(p / WIDTH)
      const x = p - y * WIDTH
      const jx = x + Math.floor(random() * (2 * reach + 1)) - reach
      const jy = y + Math.floor(random() * (2 * reach + 1)) - reach
      const j = cell(t, jx, jy)
      const di = value(bytes[j]) - value(bytes[i])
      if (j === i || di === 0 || deltaLoss(i, j, di) >= 0) continue
      splatS(i, di)
      splatS(j, -di)
      splatT(i, di)
      splatT(j, -di)
      const swap = bytes[i]
      bytes[i] = bytes[j]
      bytes[j] = swap
    }
  }
  return bytes
}

export function lowbias32Volume() {
  const volume = new Uint8Array(WIDTH * HEIGHT * DEPTH)
  for (let i = 0; i < volume.length; i++) {
    let x = (i + 0x9e3779b9) | 0
    x ^= x >>> 16
    x = Math.imul(x, 0x21f0aaad)
    x ^= x >>> 15
    x = Math.imul(x, 0x735a2d97)
    x ^= x >>> 15
    volume[i] = (x >>> 0) & 0xff
  }
  return volume
}

// The two statistics of ~/code/dispatch/jitter-metrics.mjs, unchanged: the
// variance of an 8x8 toroidal box blur per slice, and the variance of each
// pixel's mean over the slices
export function jitterStatistics(bytes) {
  const area = WIDTH * HEIGHT
  const depth = bytes.length / area
  const variance = a => {
    let m = 0
    for (const x of a) m += x
    m /= a.length
    let s = 0
    for (const x of a) s += (x - m) ** 2
    return s / a.length
  }
  const blurVariances = []
  const out = new Float64Array(area)
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        let s = 0
        for (let dy = 0; dy < 8; dy++) {
          for (let dx = 0; dx < 8; dx++) {
            const q = ((y + dy) % HEIGHT) * WIDTH + ((x + dx) % WIDTH)
            s += bytes[z * area + q] / 255
          }
        }
        out[y * WIDTH + x] = s / 64
      }
    }
    blurVariances.push(variance(out))
  }
  const means = new Float64Array(area)
  for (let p = 0; p < area; p++) {
    let s = 0
    for (let z = 0; z < depth; z++) s += bytes[z * area + p] / 255
    means[p] = s / depth
  }
  return {
    blurVarianceMin: Math.min(...blurVariances),
    blurVarianceMax: Math.max(...blurVariances),
    pixelMeanVariance: variance(means)
  }
}

export function rankMapModule(map) {
  const base64 = Buffer.from(map).toString('base64')
  return [
    '// Generated by scripts/generate-blue-noise.mjs, do not edit',
    `// A ${WIDTH}x${HEIGHT} void-and-cluster rank map, 8 bits, seed 0x${SEED.toString(16)}`,
    '',
    `export const BLUE_NOISE_RANK_MAP_BASE64 =\n  '${base64}'`,
    ''
  ].join('\n')
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RANK_MAP_MODULE_PATH = join(
  root,
  'src/textures/blueNoiseRankMap.ts'
)

function writeCandidate(dir, name, bytes) {
  const stats = jitterStatistics(bytes)
  writeFileSync(join(dir, `${name}.bin`), bytes)
  writeFileSync(
    join(dir, `${name}.stats.json`),
    JSON.stringify({ name, ...stats }, null, 2) + '\n'
  )
  console.log(name, stats)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const map = generateRankMap()
  writeFileSync(RANK_MAP_MODULE_PATH, rankMapModule(map))
  console.log('wrote', RANK_MAP_MODULE_PATH)
  const index = process.argv.indexOf('--candidates')
  if (index !== -1) {
    const dir = process.argv[index + 1]
    if (dir == null) throw new Error('--candidates needs a directory')
    mkdirSync(dir, { recursive: true })
    writeCandidate(dir, 'hash', lowbias32Volume())
    writeCandidate(dir, 'a-vac-golden', goldenVolume(map))
    if (!process.argv.includes('--skip-3d')) {
      writeCandidate(dir, 'b-stbn-vac', spatiotemporalVolume())
    }
  }
}
