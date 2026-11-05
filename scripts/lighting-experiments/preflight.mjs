// Read an explicit reference checkout without modifying or publishing its code
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  candidateDirections,
  integrateCellSky,
  sphereDirections,
  uniformSkyAudit
} from './quadrature.mjs'

const [root, output] = process.argv.slice(2)
if (!root || !output)
  throw new Error('Usage: node preflight.mjs REFERENCE_ROOT OUTPUT_JSON')
const files = ['medium.mjs']
const paths = files.map(file =>
  resolve(root, 'scripts/lighting-reference', file)
)
const hash = path =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
const before = paths.map(hash)
const instrumentPaths = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL('./quadrature.mjs', import.meta.url))
]
const instrumentBefore = instrumentPaths.map(hash)
const {
  createHomogeneousMedium,
  analyticHomogeneousSingleScatter,
  traceInScatteredRadiance,
  scenePhase
} = await import(pathToFileURL(paths[0]).href)
const scene = {
  scatterAnisotropy1: 0.7,
  scatterAnisotropy2: -0.2,
  scatterAnisotropyMix: 0.5,
  stepSize: 2,
  shadowStepSize: 2
}
const rules = candidateDirections()
const views = [...rules.axes6, ...rules.corners8, ...sphereDirections(64)]
const quadrature = {}
for (const [name, directions] of Object.entries({
  ...rules,
  dense8192: sphereDirections(8192)
})) {
  quadrature[name] = uniformSkyAudit(
    directions,
    views,
    cosine => scenePhase(cosine, scene),
    0.02
  )
}
const cellQuadrature = {}
for (const [name, directions] of Object.entries(rules)) {
  const dense = sphereDirections(8192)
  const rows = views.map(view => {
    const phase = cosine => scenePhase(cosine, scene)
    const uniform = integrateCellSky(directions, dense, view, phase, () => 1)
    const linear = integrateCellSky(
      directions,
      dense,
      view,
      phase,
      d => 2 + d[2]
    )
    const expectedLinear = 2 + 0.25 * view[2]
    return {
      uniformError: Math.abs(uniform - 1),
      linearRelativeError: Math.abs(linear - expectedLinear) / expectedLinear
    }
  })
  cellQuadrature[name] = {
    views: views.length,
    weightIntegrationDirections: dense.length,
    maximumUniformError: Math.max(...rows.map(row => row.uniformError)),
    maximumLinearRelativeError: Math.max(
      ...rows.map(row => row.linearRelativeError)
    ),
    qualification:
      'Uniform and smooth linear sky only; no cloud occlusion or GPU validation'
  }
}
const sky = []
for (const samples of [100000, 200000]) {
  for (const seed of [7, 987654321]) {
    for (const maxBounces of [32, 64]) {
      const expected = 1 - Math.exp(-0.5)
      const measured = traceInScatteredRadiance({
        origin: [0, 0, 0],
        direction: [0, 0, 1],
        sunDirection: [0, 0, 1],
        medium: createHomogeneousMedium({
          sigmaS: 0.005,
          sigmaT: 0.005,
          height: 100
        }),
        scene,
        samples,
        seed,
        maxBounces,
        skyRadiance: () => [1, 0.5, 0.25]
      })
      const absoluteError = Math.abs(measured.sky[0] - expected)
      sky.push({
        samples,
        seed,
        maxBounces,
        expected,
        measured: measured.sky,
        single: measured.skySingle,
        truncatedSamples: measured.truncatedSamples,
        absoluteError,
        passed: absoluteError < 0.006 && measured.truncatedSamples === 0
      })
    }
  }
}
const slab = []
for (const viewCos of [0.5, 0.8, 1]) {
  for (const seed of [7, 987654321]) {
    const medium = createHomogeneousMedium({
      sigmaS: 0.01,
      sigmaT: 0.02,
      height: 100
    })
    const expected = analyticHomogeneousSingleScatter({
      sigmaS: 0.01,
      sigmaT: 0.02,
      height: 100,
      viewCos,
      phaseAt: scenePhase(viewCos, scene)
    })
    const measured = traceInScatteredRadiance({
      origin: [0, 0, 0],
      direction: [Math.sqrt(1 - viewCos ** 2), 0, viewCos],
      medium,
      sunDirection: [0, 0, 1],
      scene,
      samples: 200000,
      seed,
      maxBounces: 0
    })
    const relativeError = Math.abs(measured.single - expected) / expected
    slab.push({
      viewCos,
      seed,
      samples: 200000,
      expected,
      measured: measured.single,
      relativeError,
      passed: Number.isFinite(relativeError) && relativeError < 0.01
    })
  }
}
if (
  paths.some((path, i) => hash(path) !== before[i]) ||
  instrumentPaths.some((path, i) => hash(path) !== instrumentBefore[i])
)
  throw new Error('Reference source changed during preflight')
const report = {
  schemaVersion: 2,
  instrumentSource: Object.fromEntries(
    ['preflight.mjs', 'quadrature.mjs'].map((file, i) => [
      file,
      instrumentBefore[i]
    ])
  ),
  fixtures: {
    sunSlab: {
      sigmaS: 0.01,
      sigmaT: 0.02,
      height: 100,
      sunDirection: [0, 0, 1],
      maxBounces: 0,
      stepSize: 2,
      shadowStepSize: 2
    },
    conservativeSkySlab: {
      sigmaS: 0.005,
      sigmaT: 0.005,
      height: 100,
      skyRadiance: [1, 0.5, 0.25],
      direction: [0, 0, 1],
      stepSize: 2,
      shadowStepSize: 2
    },
    smoothSky:
      'L(direction) = 2 + direction.z; analytic phase convolution = 2 + 0.25 * view.z',
    skyAbsoluteTolerance: 0.006,
    singleScatterRelativeTolerance: 0.01
  },
  referenceSource: Object.fromEntries(
    files.map((file, i) => [file, before[i]])
  ),
  phase: {
    g1: scene.scatterAnisotropy1,
    g2: scene.scatterAnisotropy2,
    mix: scene.scatterAnisotropyMix
  },
  quadrature,
  cellQuadrature,
  slab,
  sky,
  scope: 'CPU analytic preflight only; no GPU fidelity or timing qualification',
  qualified: false
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(report, null, 2))
if (
  slab.some(row => !row.passed) ||
  sky.some(row => !row.passed) ||
  !quadrature.dense8192.passed
)
  process.exitCode = 1
