// Fixed density masks and linear RGB errors, with no radiance fit
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { encodePng } from '../lighting-reference/textures.mjs'
import { MANIFEST } from './fixtures.mjs'

const root = resolve(process.argv[2] ?? 'test-results/lighting-study')
const output = resolve(
  process.argv[3] ?? 'test-results/lighting-study/results.json'
)
const cases = ['cumulus-320', 'deck-320-v2', 'broken-320']
const json = path => JSON.parse(readFileSync(path))
const hash = path =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
const read = (folder, name) => {
  const bytes = readFileSync(resolve(folder, `${name}.bin`))
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
}
const scalarRGB = values =>
  Float32Array.from(
    { length: values.length * 3 },
    (_, i) => values[Math.floor(i / 3)]
  )
const layerRGB = values =>
  Float32Array.from(
    { length: (values.length / 4) * 3 },
    (_, i) => values[Math.floor(i / 3) * 4 + (i % 3)]
  )
const add = (a, b) => a.map((value, i) => value + b[i])
const average = (a, b) => a.map((value, i) => (value + b[i]) / 2)

function metric(a, b, mask, inside = opacity => opacity > 0.001) {
  if (a.length !== b.length || a.length !== mask.length * 3)
    throw new Error('Mismatched images')
  let error = 0,
    energy = 0,
    candidate = 0,
    pixels = 0
  for (let p = 0; p < mask.length; p++) {
    if (!inside(mask[p])) continue
    pixels++
    for (let c = 0; c < 3; c++) {
      const i = p * 3 + c
      if (
        !Number.isFinite(a[i]) ||
        !Number.isFinite(b[i]) ||
        a[i] < 0 ||
        b[i] < 0
      )
        throw new Error('Invalid radiance')
      error += Math.abs(a[i] - b[i])
      energy += b[i]
      candidate += a[i]
    }
  }
  if (!pixels || !energy) throw new Error('No measurable cloud signal')
  return { pixels, relativeL1: error / energy, energyRatio: candidate / energy }
}

const panels = []
const results = cases.map(name => {
  const folder = resolve(root, name)
  const state = json(resolve(folder, 'state.json'))
  if (state.width !== 320 || state.height !== 180)
    throw new Error('Wrong decision resolution')
  const provenance = json(resolve(folder, 'provenance.json'))
  if (
    provenance.buildHash !== provenance.servedHash ||
    provenance.errors.length
  )
    throw new Error('Invalid GPU provenance')
  const fixture = json(resolve(folder, 'fixture.json'))
  if (hash(resolve(folder, 'fixture.bin')) !== fixture.hash)
    throw new Error('Fixture changed')
  const mask = read(folder, 'reference-4096-7-128-opacity')
  const references = [2048, 4096].map(samples => {
    const bounces = samples === 2048 ? 64 : 128
    return [7, 987654321].map(seed => {
      const label = `reference-${samples}-${seed}-${bounces}`
      const receipt = json(resolve(folder, `${label}.json`))
      if (
        receipt.sources == null ||
        receipt.fixtureHash !== fixture.hash ||
        receipt.truncated ||
        receipt.fittedRadianceScale != null
      )
        throw new Error('Unqualified reference')
      return {
        receipt,
        sun: scalarRGB(read(folder, `${label}-total`)),
        sky: read(folder, `${label}-skyRGB`),
        singleSky: read(folder, `${label}-skySingleRGB`)
      }
    })
  })
  const sun = average(references[1][0].sun, references[1][1].sun)
  const sky = average(references[1][0].sky, references[1][1].sky)
  const singleSky = average(
    references[1][0].singleSky,
    references[1][1].singleSky
  )
  const layer = arm => layerRGB(read(folder, arm))
  const alpha = read(folder, 'single')
  let maxOpacityDifference = 0
  for (const arm of [
    'baseline',
    'diffusion',
    'sky',
    'directional-sky',
    'cached-sky',
    'combined',
    'zero'
  ]) {
    const values = read(folder, arm)
    for (let i = 3; i < values.length; i += 4)
      maxOpacityDifference = Math.max(
        maxOpacityDifference,
        Math.abs(values[i] - alpha[i])
      )
  }
  if (maxOpacityDifference !== 0) throw new Error('Lighting changed opacity')
  const baseline = add(layer('baseline'), layer('sky'))
  const combined = layer('combined')
  const total = add(sun, sky)
  panels.push([baseline, total, combined])
  const noise = Object.fromEntries(
    ['sun', 'sky'].map(channel => [
      channel,
      {
        seeds2048: metric(
          references[0][0][channel],
          references[0][1][channel],
          mask
        ),
        seeds4096: metric(
          references[1][0][channel],
          references[1][1][channel],
          mask
        ),
        doubling: metric(
          average(references[0][0][channel], references[0][1][channel]),
          average(references[1][0][channel], references[1][1][channel]),
          mask
        )
      }
    ])
  )
  const result = {
    name,
    fixture: { ...fixture, numerics: fixture.numerics },
    provenance: {
      ...provenance,
      servedRoot: 'isolated worktree, package self-link verified'
    },
    references: references.flat().map(reference => reference.receipt),
    noise,
    sun: {
      baseline: metric(layer('baseline'), sun, mask),
      diffusion: metric(layer('diffusion'), sun, mask)
    },
    sky: {
      baseline: metric(layer('sky'), sky, mask),
      directional: metric(layer('directional-sky'), sky, mask),
      cached: metric(layer('cached-sky'), sky, mask),
      cachedVsSingle: metric(layer('cached-sky'), singleSky, mask)
    },
    combined: {
      baseline: metric(baseline, total, mask),
      candidate: metric(combined, total, mask),
      linearity: metric(
        combined,
        add(layer('diffusion'), layer('cached-sky')),
        mask
      )
    },
    regions: Object.fromEntries(
      [
        ['edge', value => value > 0.001 && value < 0.25],
        ['interior', value => value > 0.75]
      ].map(([region, select]) => [
        region,
        {
          baseline: metric(baseline, total, mask, select),
          candidate: metric(combined, total, mask, select)
        }
      ])
    ),
    controls: {
      maxOpacityDifference,
      zeroMaximum: layer('zero').reduce((a, b) => Math.max(a, b), 0),
      emptyMaximum: read(folder, 'empty').reduce((a, b) => Math.max(a, b), 0)
    }
  }
  if (result.controls.zeroMaximum !== 0 || result.controls.emptyMaximum !== 0)
    throw new Error('Negative control failed')
  return result
})
const main = resolve(root, cases[0])
const refined = resolve(root, 'cumulus-refined')
const refinementMask = read(main, 'reference-4096-7-128-opacity')
const refinement = Object.fromEntries(
  ['baseline', 'diffusion', 'sky', 'cached-sky', 'combined'].map(arm => [
    arm,
    metric(
      layerRGB(read(refined, arm)),
      layerRGB(read(main, arm)),
      refinementMask
    )
  ])
)
const lifecycle = json(resolve(root, 'deck-320-v2/lifecycle.json'))
if (
  lifecycle.cycles.length !== 5 ||
  lifecycle.cycles.some(
    c =>
      c.after.textures !== lifecycle.baseline.textures ||
      c.after.bytes !== lifecycle.baseline.bytes ||
      c.disposals.some(n => n !== 1)
  )
)
  throw new Error('Resource failure')
const highResolution = json(resolve(root, 'cumulus-720/provenance.json'))
if (
  highResolution.errors.length ||
  highResolution.buildHash !== highResolution.servedHash
)
  throw new Error('Invalid 720p capture')
const build = json(resolve('build/package-provenance.json'))
const currentBuildHash = hash(resolve('build/shared.js'))
if (results.some(result => result.provenance.buildHash !== currentBuildHash))
  throw new Error('Current build differs from measured source snapshot')
const record = {
  sourceSnapshot: {
    group: build.groups.src,
    files: Object.fromEntries(
      Object.entries(build.content.files).filter(([path]) =>
        path.startsWith('src/')
      )
    ),
    checks: build.checks
  },
  decision: 'retain baseline; reject these S, D and S+D prototypes',
  manifest: MANIFEST,
  actualReferenceBudget: {
    samples: [2048, 4096],
    seeds: [7, 987654321],
    bounces: [64, 128],
    tracking: 'delta/ratio, no spatial step bias',
    opacityStepMetres: 5
  },
  results,
  refinement,
  lifecycle,
  highResolution: {
    ...highResolution,
    servedRoot: 'isolated worktree, package self-link verified'
  },
  decisionScope:
    'Fail-fast rejection on required cumulus fixture, corroborated by deck and broken fixtures; remaining matrix and dynamic/performance promotion gates not run',
  timing: 'UNQUIET; no GPU timing claim'
}
writeFileSync(output, JSON.stringify(record, null, 2) + '\n')
const pixels = new Uint8Array(960 * 540 * 4)
for (let row = 0; row < 3; row++)
  for (let column = 0; column < 3; column++)
    for (let y = 0; y < 180; y++)
      for (let x = 0; x < 320; x++) {
        const index = ((row * 180 + y) * 960 + column * 320 + x) * 4
        for (let c = 0; c < 3; c++)
          pixels[index + c] = Math.round(
            255 *
              (1 - Math.exp(-panels[row][column][(y * 320 + x) * 3 + c] * 2)) **
                (1 / 2.2)
          )
        pixels[index + 3] = 255
      }
writeFileSync(resolve(root, 'comparison.png'), encodePng(960, 540, pixels))
console.log(
  JSON.stringify(
    {
      output,
      cases: results.map(r => ({
        name: r.name,
        sun: r.sun,
        sky: r.sky,
        combined: r.combined,
        noise: r.noise
      })),
      refinement
    },
    null,
    2
  )
)
