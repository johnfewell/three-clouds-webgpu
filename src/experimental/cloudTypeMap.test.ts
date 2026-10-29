// the regional cloud-type morph. Three properties carry the task:
// the blend is a convex combination an author can reason about, the map
// carries one scalar per location (docs/design/cloud-types.md 3.4), and the
// default is inert, so enabling the flag without authoring anything changes
// nothing

import { Vector2, type Vector4 } from 'three'
import { uniform } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { normalizeWGSL } from '../../test/helpers/compileWGSL'
import { expectClose, table } from '../../test/helpers/cpuTwin'
import {
  compileDensity,
  compileDensityWGSL
} from '../../test/helpers/densityGraph'
import { log, setCurrentSpec } from '../../test/helpers/log'
import {
  blendCloudTypeParameter,
  CLOUD_TYPE_PARAMS,
  CLOUD_TYPE_TENT_SCOPES,
  cloudTypeAnchors,
  cloudTypeArchetypes,
  CloudTypes,
  cloudTypeTentNames,
  cpuBlendCloudTypeParameter,
  cpuCloudTypeTentWeights,
  createCloudTypeMap,
  type CloudTypeArchetype
} from './cloudTypeMap'

// The samplers are handed uniform nodes, not raw vectors, so the tests hand
// them uniform nodes too: a Vector2 would compile but would not be the thing
// production passes
const uv = () => uniform(new Vector2(1, 1))
const origin = () => uniform(new Vector2(0, 0))

/** Sum of the absolute lane values of one anchor's delta vec4 */
const laneMagnitude = (node: { value: Vector4 }) =>
  node.value.toArray().reduce((a, b) => a + Math.abs(b), 0)

describe('the morph axis', () => {
  setCurrentSpec('cloudTypeMap')

  it('runs stratiform at 0 to cumuliform at 1', () => {
    // The contract in docs/design/cloud-types.md 3.4. If the ends moved, every
    // sibling task blending against this scalar would silently change meaning
    expect(cloudTypeAnchors.map(a => a.at)).toEqual([0, 0.5, 1])
    expect(cloudTypeAnchors[0].name).toBe('stratiform')
    expect(cloudTypeAnchors[2].name).toBe('cumuliform')
  })

  it('names three vocabularies, each distinct in the parameters it moves', () => {
    const signatures = cloudTypeAnchors.map(anchor =>
      CLOUD_TYPE_PARAMS.map(p => anchor.archetype[p]?.join('/') ?? '-').join(
        '|'
      )
    )
    log('anchor signatures', [
      { field: 'anchors', expected: 3, actual: cloudTypeAnchors.length },
      {
        field: 'distinct signatures',
        expected: 3,
        actual: new Set(signatures).size
      }
    ])
    expect(new Set(signatures).size).toBe(3)
  })

  it('moves cumuliform and stratiform in opposite directions', () => {
    // The whole point of the axis: two anchors must disagree in OPPOSITE
    // directions, or a region blend is a relabelling rather than a change
    const cumulus = cloudTypeAnchors[2].archetype
    const stratus = cloudTypeAnchors[0].archetype
    const rows = [
      {
        field: 'shapeAmount',
        delta: cumulus.shapeAmount![0] - stratus.shapeAmount![0]
      },
      {
        field: 'shapeDetailAmount',
        delta: cumulus.shapeDetailAmount![0] - stratus.shapeDetailAmount![0]
      },
      {
        field: 'shapeAlteringBias',
        delta: cumulus.shapeAlteringBias![0] - stratus.shapeAlteringBias![0]
      },
      {
        field: 'densityScale',
        delta: cumulus.densityScale![0] - stratus.densityScale![0]
      }
    ]
    log('cumuliform minus stratiform', rows)
    expect(rows[0]!.delta).toBeGreaterThan(0)
    expect(rows[1]!.delta).toBeGreaterThan(0)
    expect(rows[2]!.delta).toBeLessThan(0)
    expect(rows[3]!.delta).toBeGreaterThan(0)
  })

  it('keeps every lane of every anchor inside its parameter range', () => {
    // shapeDetailAmount drives pow(detail, 6): a lane below -1 raised to an
    // even power is fine but a lane below 0 is not what the author asked for
    const rows = cloudTypeAnchors.map(anchor => ({
      anchor: anchor.name,
      minDetail: Math.min(
        ...(anchor.archetype.shapeDetailAmount ?? [0, 0, 0, 0])
      )
    }))
    log('detail amount lanes', rows)
    for (const row of rows) expect(row.minDetail).toBeGreaterThan(-1)
  })
})

describe('cpuCloudTypeTentWeights', () => {
  it('sums to one across the axis', () => {
    // A partition of unity is what makes the blend a convex combination: with
    // weights summing to 2 a region would get twice the delta it asked for
    const rows = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(morph => {
      const w = cpuCloudTypeTentWeights(morph)
      return {
        morph,
        expected: 1,
        actual: w[0] + w[1] + w[2],
        dominant: cloudTypeAnchors[w.indexOf(Math.max(...w))]!.name
      }
    })
    log('tent weights', rows)
    for (const row of rows)
      expectClose(row.actual, row.expected, { abs: 1e-12, label: 'weight sum' })
    expect(rows[0]!.dominant).toBe('stratiform')
    expect(rows.at(-1)!.dominant).toBe('cumuliform')
  })

  it('pins each anchor at its own position', () => {
    const at = (morph: number): number =>
      cpuCloudTypeTentWeights(morph).indexOf(1) === -1
        ? -1
        : cpuCloudTypeTentWeights(morph).indexOf(1)
    expect(at(0)).toBe(0)
    expect(at(0.5)).toBe(1)
    expect(at(1)).toBe(2)
    // Between two anchors both are partial, which is what makes a transition
    // zone read as a third thing rather than as the nearer neighbour
    const between = cpuCloudTypeTentWeights(0.25)
    expectClose(between, [0.5, 0.5, 0], { abs: 1e-12, label: 'midpoint' })
  })

  it('mirrors about the middle anchor', () => {
    // 0.2 leans stratiform, 0.8 leans cumuliform, by the same amount
    expectClose(
      cpuCloudTypeTentWeights(0.2),
      [...cpuCloudTypeTentWeights(0.8)].reverse(),
      {
        abs: 1e-12,
        label: 'mirror'
      }
    )
  })
})

describe('cpuBlendCloudTypeParameter', () => {
  it('adds each anchor weight times that anchor deltas, per lane', () => {
    // morph 0.25 weights are [0.5, 0.5, 0]: half stratiform, half
    // stratocumuliform. 1 + 0.5*(-0.42) + 0.5*(0.12) = 0.85
    const actual = cpuBlendCloudTypeParameter(
      [1, 1, 1, 1],
      0.25,
      'shapeAmount',
      cloudTypeArchetypes
    )
    expectClose(actual, [0.85, 0.85, 0.85, 0.85], {
      abs: 1e-9,
      label: 'halfway blend'
    })
    table('cloud type blend at morph 0.25', [
      { field: 'base', expected: 1, actual: 1 },
      { field: 'weighted sum', expected: -0.15, actual: actual[0] - 1 }
    ])
  })

  it('is the base look at the two axis ends', () => {
    // morph 0 means pure stratiform, so the blend is exactly that anchor's
    // deltas and nothing else
    const low = cpuBlendCloudTypeParameter(
      [1, 1, 1, 1],
      0,
      'shapeAmount',
      cloudTypeArchetypes
    )
    const high = cpuBlendCloudTypeParameter(
      [1, 1, 1, 1],
      1,
      'shapeAmount',
      cloudTypeArchetypes
    )
    expectClose(low, [0.58, 0.58, 0.58, 0.58], { abs: 1e-9, label: 'morph 0' })
    expectClose(high, [1.45, 1.45, 1.45, 1.45], { abs: 1e-9, label: 'morph 1' })
  })

  it('mixes lanes independently', () => {
    // morph 1 selects the last anchor alone, so only that one's lanes count
    const anchors: CloudTypeArchetype[] = [
      {},
      {},
      { shapeAmount: [0.4, -0.4, 0, 0] }
    ]
    const actual = cpuBlendCloudTypeParameter(
      [1, 1, 1, 1],
      1,
      'shapeAmount',
      anchors
    )
    expectClose(actual, [1.4, 0.6, 1, 1], {
      abs: 1e-9,
      label: 'per-lane deltas'
    })
  })

  it('is the base look when an anchor omits the parameter', () => {
    const actual = cpuBlendCloudTypeParameter([1, 1, 1, 1], 1, 'expTerm', [
      {},
      {},
      { expTerm: [0.25, 0.25, 0.25, 0.25] }
    ])
    expectClose(actual, [1.25, 1.25, 1.25, 1.25], {
      abs: 1e-9,
      label: 'omitted'
    })
  })
})

describe('CloudTypes', () => {
  it('packs all-zero deltas until a map is authored', () => {
    // The flag alone is not enough. Without a map the weights are all zero, so
    // a context that flips the flag renders the base look rather than a pure
    // stratiform sky. Two opt-ins: the flag picks the path, the map the look
    const types = new CloudTypes()
    const rows = []
    for (const param of CLOUD_TYPE_PARAMS) {
      const nodes = types.blendNodes(uv(), origin()).deltas[param]
      for (const node of nodes) {
        rows.push({ field: param, expected: 0, actual: laneMagnitude(node) })
      }
    }
    expect(rows).toHaveLength(CLOUD_TYPE_PARAMS.length * 3)
    for (const row of rows) expect(row.actual).toBe(0)
  })

  it('packs the anchor table into the delta uniforms', () => {
    const types = new CloudTypes(createCloudTypeMap({ size: 16, cells: 2 }))
    const { deltas } = types.blendNodes(uv(), origin())
    const cumulative = deltas.shapeAmount.at(-1)!.value.toArray()
    const strato = deltas.shapeAmount[0].value.toArray()
    log('packed deltas', [
      { field: 'stratiform shapeAmount', expected: -0.42, actual: strato[0] },
      { field: 'cumuliform shapeAmount', expected: 0.45, actual: cumulative[0] }
    ])
    expect(strato).toEqual([-0.42, -0.42, -0.42, -0.42])
    expect(cumulative).toEqual([0.45, 0.45, 0.45, 0.45])
  })

  it('swaps the map texture without minting a new node', () => {
    // A texture captured at build time would leave the graph on the old map: a
    // sampled render target is a TextureNode whose .value follows the swap
    const types = new CloudTypes(createCloudTypeMap({ size: 8, cells: 2 }))
    const blend = types.blendNodes(uv(), origin())
    const built = compileDensity({ cloudTypes: blend })
    const replacement = createCloudTypeMap({ size: 8, cells: 3, seed: 9 })
    types.setMap(replacement)
    log('map swap', [
      {
        field: 'built graph binds the replacement',
        expected: true,
        actual: built.boundTextures().includes(replacement)
      },
      {
        field: 'blend nodes unchanged',
        expected: true,
        actual: types.blendNodes(uv(), origin()) === blend
      }
    ])
    expect(types.blendNodes(uv(), origin())).toBe(blend)
    expect(built.boundTextures()).toContain(replacement)
  })

  it('caches its blend nodes so the primary and shadow graphs share one sample', () => {
    const types = new CloudTypes()
    const nodes = types.blendNodes(uv(), origin())
    expect(types.blendNodes(uv(), origin())).toBe(nodes)
  })
})

function mapData(size = 128, cells?: number, seed?: number) {
  const tex = createCloudTypeMap({
    size,
    ...(cells != null && { cells }),
    ...(seed != null && { seed })
  })
  return { size: tex.image.width, data: tex.image.data as Uint8Array }
}

describe('createCloudTypeMap', () => {
  it('is deterministic per seed and different across seeds', () => {
    const a = mapData(16, 2, 1)
    const b = mapData(16, 2, 1)
    const c = mapData(16, 2, 2)
    const same = a.data.every((v, i) => v === b.data[i])
    const differs = a.data.some((v, i) => v !== c.data[i])
    log('map determinism', [
      { field: 'same seed identical', expected: true, actual: same },
      { field: 'other seed differs', expected: true, actual: differs }
    ])
    expect(same).toBe(true)
    expect(differs).toBe(true)
  })

  it('spans the whole axis, so the whole sky is not one cloud type', () => {
    // Rank equalisation is what buys this. Without it a smoothed random field
    // clusters near 0.5 and most regions would land on the middle vocabulary
    const { data } = mapData()
    const hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < data.length; i += 4) {
      hist[Math.min(9, Math.floor((data[i]! / 256) * 10))] =
        hist[Math.min(9, Math.floor((data[i]! / 256) * 10))]! + 1
    }
    const total = data.length / 4
    const rows = hist.map((count, bin) => ({
      bin,
      expected: 0.1,
      actual: count / total
    }))
    log('morph histogram, tenths', rows)
    for (const row of rows) expect(row.actual).toBeGreaterThan(0.06)
  })

  it('leaves green, blue and alpha free for the other variety tasks', () => {
    // Only red carries the §3.4 scalar. A sibling that needs a second signal
    // must be able to take a channel without a merge conflict
    const { data } = mapData()
    let nonzero = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 1]! !== 0 || data[i + 2]! !== 0 || data[i + 3]! !== 0) {
        nonzero += 1
      }
    }
    log('reserved channels', [
      { field: 'texels using g, b or a', expected: 0, actual: nonzero }
    ])
    expect(nonzero).toBe(0)
  })

  it('feathers its region boundaries', () => {
    // The march reads the scalar at one sample per step, so a hard step would
    // be a visible seam in the sky rather than an air mass edge
    const size = 128
    const { data } = mapData(size)
    let worst = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        worst = Math.max(
          worst,
          Math.abs(
            data[(y * size + x) * 4]! - data[(y * size + ((x + 1) % size)) * 4]!
          )
        )
      }
    }
    log('worst neighbour step, 0-255', [
      { field: 'hard threshold would give', expected: 255, actual: worst },
      { field: 'budget', expected: '<=20', actual: worst }
    ])
    expect(worst).toBeLessThanOrEqual(20)
  })

  it('has no seam where the texture wraps', () => {
    // cube-sphere uv repeats every 1.0 and the weather texture tiles over it,
    // so a discontinuity at the texel edge would tile into visible bands
    const size = 128
    const { data } = mapData(size)
    const steps: number[] = []
    for (let y = 0; y < size; y++) {
      steps.push(
        Math.abs(data[y * size * 4]! - data[(y * size + size - 1) * 4]!)
      )
    }
    const worst = Math.max(...steps)
    log('wrap seam step, 0-255', [
      { field: 'seam worst', expected: '<=20', actual: worst }
    ])
    expect(worst).toBeLessThanOrEqual(20)
  })
})

describe('compiled WGSL', () => {
  it('names every anchor of every modulated parameter when the map is on', () => {
    // The weight names are in here too: a blend that dropped an anchor would
    // still compile and still name the deltas it kept, and the tent weights
    // are what give the sum-to-one property
    const types = new CloudTypes(createCloudTypeMap({ size: 16, cells: 2 }))
    const wgsl = normalizeWGSL(
      compileDensityWGSL({
        cloudTypes: types.blendNodes(uv(), origin())
      })
    )
    const expected = [
      ...CLOUD_TYPE_PARAMS.flatMap(param =>
        cloudTypeAnchors.map(anchor => `cloudType_${param}_${anchor.name}`)
      ),
      // Both scopes, because the march shader carries the weather sampler and
      // the media sampler and each builds its own set
      ...CLOUD_TYPE_TENT_SCOPES.flatMap(scope => cloudTypeTentNames(scope))
    ]
    const missing = expected.filter(name => !wgsl.includes(name))
    log('blend identifiers in WGSL', [
      {
        field: 'expected',
        expected: expected.length,
        actual: expected.length - missing.length
      },
      { field: 'missing', expected: 0, actual: missing.join(',') || 'none' }
    ])
    expect(missing).toEqual([])
  })

  it('pairs each anchor with its own tent weight', () => {
    // The names alone do not prove the pairing. A blend that multiplied the
    // cumuliform deltas by the middle weight would still name all three, so
    // only the expression says which multiplies which
    const types = new CloudTypes(createCloudTypeMap({ size: 16, cells: 2 }))
    const wgsl = compileDensityWGSL({
      cloudTypes: types.blendNodes(uv(), origin())
    })
    // The coverage threshold's height skew is the weather sampler's, the other
    // seven are the media sampler's, and each sampler names its own weights
    // Getting this map wrong is the same failure as unwiring the sampler
    const scope: Partial<Record<(typeof CLOUD_TYPE_PARAMS)[number], string>> = {
      shapeAlteringBias: 'weather'
    }
    const rows = CLOUD_TYPE_PARAMS.flatMap(param =>
      cloudTypeAnchors.map((anchor, index) => {
        const w = `cloudTypeW${index}_${scope[param] ?? 'media'}`
        // TSL splats the scalar weight into a vec4 before the multiply
        const product = `vec4<f32>( ${w} ) * object.cloudType_${param}_${anchor.name}`
        return {
          pair: `${param}/${anchor.name}`,
          expected: true,
          actual: wgsl.includes(product)
        }
      })
    )
    log('weight-anchor products', [
      {
        field: 'expected',
        expected: rows.length,
        actual: rows.filter(r => r.actual).length
      },
      {
        field: 'missing',
        expected: 0,
        actual:
          rows
            .filter(r => !r.actual)
            .map(r => r.pair)
            .join(',') || 'none'
      }
    ])
    expect(rows.filter(r => !r.actual)).toEqual([])
  })

  it('computes the same tents in the shader as the CPU twin', () => {
    // The CPU twin is what the numbers in the docs and the tests are reasoned
    // about. If the shader's tents drifted from it, every CPU assertion would
    // still pass while the GPU blended something else
    const types = new CloudTypes(createCloudTypeMap({ size: 16, cells: 2 }))
    const wgsl = compileDensityWGSL({
      cloudTypes: types.blendNodes(uv(), origin())
    })
    const patterns = [
      /cloudTypeW0_\w+ = clamp\( \( - (\w+) \), 0\.0, 1\.0 \)/,
      /cloudTypeW1_\w+ = clamp\( \( 1\.0 - abs\( (\w+) \) \), 0\.0, 1\.0 \)/,
      /cloudTypeW2_\w+ = clamp\( (\w+), 0\.0, 1\.0 \)/
    ]
    const operands = patterns.map(pattern => wgsl.match(pattern)?.[1])
    log('tent operands, one morph for all three', [
      {
        field: 'expected',
        expected: 'same operand',
        actual: [...new Set(operands)].join(',') || 'none'
      }
    ])
    for (const operand of operands) expect(operand).toBeDefined()
    expect(new Set(operands).size).toBe(1)
  })

  it('leaves the graph free of any cloud-type code when off', () => {
    const wgsl = normalizeWGSL(compileDensityWGSL())
    const found = wgsl.match(/cloudType\w*/g) ?? []
    log('cloud-type identifiers with the map off', [
      { field: 'found', expected: 0, actual: found.length }
    ])
    expect(found).toEqual([])
  })

  it('reads the map at an explicit mip level', () => {
    // An implicit-LOD sample inside the march loop returns zeros on Dawn and
    // the feature reads as switched off rather than wrong
    const types = new CloudTypes(createCloudTypeMap({ size: 16, cells: 2 }))
    const wgsl = compileDensityWGSL({
      cloudTypes: types.blendNodes(uv(), origin())
    })
    const samples = [...wgsl.matchAll(/textureSampleLevel\([^;]*?\)/g)].map(
      m => m[0]
    )
    log('texture samples in the map-on graph', [
      { field: 'samples', expected: '>0', actual: samples.length }
    ])
    expect(samples.length).toBeGreaterThan(0)
  })
})

describe('blendCloudTypeParameter', () => {
  it('returns one vec4 node so it composes into the samplers', () => {
    // A Fn that returned a JS object would read undefined at the call site,
    // and a pure helper is inlined rather than emitted as a WGSL function
    const types = new CloudTypes(createCloudTypeMap({ size: 8, cells: 2 }))
    const { deltas } = types.blendNodes(uv(), origin())
    expect(typeof blendCloudTypeParameter).toBe('function')
    expect(deltas.shapeAmount).toHaveLength(3)
  })
})
