// Path-trace the exact voxel field and camera captured from the production march
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { traceInScatteredRadiance } from '../lighting-reference/medium.mjs'
import { rayForPixel } from '../lighting-reference/reference.mjs'
import { encodePng } from '../lighting-reference/textures.mjs'
import { boxInterval, MANIFEST, voxelMedium } from './fixtures.mjs'

const folder = resolve(process.argv[2])
const samples = Number(process.argv[3] ?? 128)
const seed = Number(process.argv[4] ?? 7)
const maxBounces = Number(process.argv[5] ?? 32)
const state = JSON.parse(readFileSync(resolve(folder, 'state.json')))
const fixture = JSON.parse(readFileSync(resolve(folder, 'fixture.json')))
const bytes = readFileSync(resolve(folder, 'fixture.bin'))
fixture.data = new Uint16Array(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
)
const medium = voxelMedium(
  fixture,
  state.scatteringCoefficient,
  state.absorptionCoefficient
)
const sunGpuBytes = readFileSync(resolve(folder, 'single.bin'))
const sunGpu = new Float32Array(
  sunGpuBytes.buffer.slice(
    sunGpuBytes.byteOffset,
    sunGpuBytes.byteOffset + sunGpuBytes.byteLength
  )
)
const upperSky = fixture.lighting?.upperSky ?? [1, 0.5, 0.25]
const lowerSky = fixture.lighting?.lowerSky ?? upperSky
const skyRadiance = direction => (direction[1] >= 0 ? upperSky : lowerSky)
const size = state.width * state.height
const single = new Float32Array(size),
  total = new Float32Array(size)
const skyResult = new Float32Array(size),
  skySingle = new Float32Array(size)
const skyRGB = new Float32Array(size * 3),
  skySingleRGB = new Float32Array(size * 3)
const opacity = new Float32Array(size)
let truncated = 0,
  pixels = 0,
  l1 = 0,
  energy = 0,
  opacityError = 0,
  skyError = 0
const started = Date.now()
for (let y = 0; y < state.height; y++) {
  for (let x = 0; x < state.width; x++) {
    const i = y * state.width + x
    const ray = rayForPixel(state, x, y)
    const interval = boxInterval(
      ray.origin,
      ray.direction,
      fixture.minimum,
      fixture.maximum
    )
    if (!interval) continue
    // Independent deterministic transmittance supplies the fixed density mask
    const steps = Math.ceil((interval[1] - interval[0]) / 5)
    const step = (interval[1] - interval[0]) / steps
    let opticalDepth = 0
    for (let k = 0; k < steps; k++) {
      const distance = interval[0] + (k + 0.5) * step
      opticalDepth +=
        medium.extinctionAt(
          ray.origin.map(
            (value, axis) => value + ray.direction[axis] * distance
          )
        ) * step
    }
    opacity[i] = 1 - Math.exp(-opticalDepth)
    opacityError += Math.abs(opacity[i] - sunGpu[i * 4 + 3])
    if (opacity[i] < 0.001) continue
    pixels++
    const traced = traceInScatteredRadiance({
      ...ray,
      medium,
      sunDirection: state.sunDirection,
      scene: {
        stepSize: 10,
        shadowStepSize: 10,
        scatterAnisotropy1: state.phase[0],
        scatterAnisotropy2: state.phase[1],
        scatterAnisotropyMix: state.phase[2]
      },
      samples,
      seed: (seed + Math.imul(i, 2654435761)) >>> 0,
      maxBounces,
      skyRadiance
    })
    single[i] = traced.single
    total[i] = traced.total
    skyResult[i] = traced.sky[0]
    skySingle[i] = traced.skySingle[0]
    skyRGB.set(traced.sky, i * 3)
    skySingleRGB.set(traced.skySingle, i * 3)
    truncated += traced.truncatedSamples
    energy += traced.single
    l1 += Math.abs(traced.single - sunGpu[i * 4])
    skyError += Math.abs(traced.sky[0] - opacity[i])
  }
  if (y % 16 === 0)
    console.log(
      JSON.stringify({
        row: y,
        height: state.height,
        elapsedSeconds: (Date.now() - started) / 1000,
        pixels
      })
    )
  if (Date.now() - started > MANIFEST.reference.maxSeconds * 1000)
    throw new Error('Reference wall-clock budget exhausted')
}
if (!pixels || energy <= 0)
  throw new Error('Reference has no measurable cloud signal')
const label = `reference-${samples}-${seed}-${maxBounces}`
for (const [name, values] of Object.entries({
  single,
  total,
  sky: skyResult,
  skySingle,
  skyRGB,
  skySingleRGB,
  opacity
}))
  writeFileSync(
    resolve(folder, `${label}-${name}.bin`),
    new Uint8Array(values.buffer)
  )
const png = new Uint8Array(size * 4)
for (let i = 0; i < size; i++) {
  const value = Math.round(255 * (1 - Math.exp(-total[i] * 4)) ** (1 / 2.2))
  png.set([value, value, value, 255], i * 4)
}
writeFileSync(
  resolve(folder, `${label}.png`),
  encodePng(state.width, state.height, png)
)
const report = {
  sources: Object.fromEntries(
    [
      './referenceStudy.mjs',
      './fixtures.mjs',
      '../lighting-reference/medium.mjs',
      '../lighting-reference/reference.mjs'
    ].map(path => [
      path,
      createHash('sha256')
        .update(readFileSync(new URL(path, import.meta.url)))
        .digest('hex')
    ])
  ),
  samples,
  seed,
  maxBounces,
  pixels,
  tracedPaths: pixels * samples,
  truncated,
  elapsedSeconds: (Date.now() - started) / 1000,
  opacityMeanAbsoluteError: opacityError / size,
  singleRelativeL1: l1 / energy,
  uniformSkyMeanAbsoluteError:
    fixture.lighting?.skyMode === 'hemispheres' ? null : skyError / pixels,
  medium:
    'Exact trilinear half-float fixture; delta tracking with maximum-voxel majorant',
  sunEstimator:
    'Next-event estimation with bounded ratio-tracked transmittance',
  skyEstimator:
    'Phase-distributed escaping paths over the full sphere; mixture PDF equals phase',
  fixtureHash: fixture.hash,
  fittedRadianceScale: null
}
writeFileSync(resolve(folder, `${label}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
