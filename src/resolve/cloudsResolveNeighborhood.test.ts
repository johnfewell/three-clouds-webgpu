import { createHash } from 'node:crypto'
import {
  DataArrayTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  RenderTarget,
  RGBAFormat,
  Vector2
} from 'three'
import { float, mrt, texture, uniform } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { buildShadowCascadeResolve } from '../shadow/shadowResolve'
import {
  buildCloudsResolve,
  buildTemporalAntialiasing,
  buildTemporalUpscale
} from './cloudsResolve'
import { varianceClippingCPU } from './varianceClipping'

type Offset = [number, number]
type Color = [number, number, number, number]
interface Moments {
  first: string
  second: string
  offsets: Offset[]
}

function createTexture() {
  const value = new DataTexture(
    new Uint16Array(4 * 4 * 4),
    4,
    4,
    RGBAFormat,
    HalfFloatType
  )
  value.minFilter = value.magFilter = LinearFilter
  return value
}

function compileCloud(upscale: boolean, shadow: boolean, standalone = false) {
  const deps = {
    colorBuffer: createTexture(),
    depthVelocityBuffer: createTexture(),
    colorHistoryNode: texture(createTexture()),
    resolveWidth: uniform(16),
    resolveHeight: uniform(16),
    frame: uniform(0),
    varianceGamma: uniform(2),
    temporalAlpha: uniform(0.1)
  }
  if (standalone) {
    return compileWGSL(
      upscale ? buildTemporalUpscale(deps) : buildTemporalAntialiasing(deps)
    ).fragment
  }
  const out = buildCloudsResolve(
    deps,
    shadow
      ? {
          shadowLengthBuffer: createTexture(),
          shadowLengthHistoryNode: texture(createTexture())
        }
      : null,
    upscale
  )
  const target = new RenderTarget(16, 16, { count: shadow ? 2 : 1 })
  target.textures[0]!.name = 'output'
  if (shadow) target.textures[1]!.name = 'shadowLength'
  const node =
    out.shadowLength == null
      ? out.color
      : mrt({ output: out.color, shadowLength: out.shadowLength })
  return compileWGSL(node, { renderTarget: target }).fragment
}

// Select reads that feed BOTH moments, excluding the closest-depth search
function momentGroups(wgsl: string, upscale: boolean): Moments[] {
  const groups = new Map<string, Moments>()
  const lines = wgsl.split('\n').map(line => line.replace(/\s+/g, ''))
  const aliases = new Map<string, string>()
  for (const line of lines) {
    const alias = /^let(\w+)=(.*);$/.exec(line)
    if (alias != null) aliases.set(alias[1]!, alias[2]!)
  }
  for (let i = 0; i < lines.length; i++) {
    const read = /^(\w+)=texture(?:Load|SampleLevel)\((.*);$/.exec(lines[i]!)
    if (read == null) continue
    const value = read[1]!
    const first = new RegExp(`^(\\w+)=\\(\\1\\+${value}\\);$`).exec(
      lines[i + 1] ?? ''
    )
    if (first == null) continue
    const second = new RegExp(
      `^(\\w+)=\\(\\1\\+\\(${value}\\*${value}\\)\\);$`
    ).exec(lines[i + 2] ?? '')
    expect(second, 'neighbor must contribute to both moments').not.toBeNull()
    const coordinate = read[2]!.replace(
      /^(\w+),(\w+),/,
      (_, input: string, coord: string) =>
        `${input},${aliases.get(coord) ?? coord},`
    )
    const offset = upscale
      ? /vec2<f32>\((-?[\d.]+),(-?[\d.]+)\)/.exec(coordinate)
      : /\.x\+(-?\d+)\),\([^,]*\.y\+(-?\d+)\)/.exec(coordinate)
    expect(offset, `cannot identify neighbor offset: ${read[0]}`).not.toBeNull()
    const key = first[1]!
    const group = groups.get(key) ?? {
      first: key,
      second: second![1]!,
      offsets: []
    }
    group.offsets.push([Number(offset![1]), Number(offset![2])])
    groups.set(key, group)
  }
  expect(groups.size, 'no clipping moments measured').toBeGreaterThan(0)
  return [...groups.values()]
}

function expectDenominators(wgsl: string, group: Moments, total: number) {
  const compact = wgsl.replace(/\s+/g, '')
  for (const moment of [group.first, group.second]) {
    expect(compact).toContain(`${moment}/vec4<f32>(${total}.0)`)
  }
}

const CROSS: Offset[] = [
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]
const DIAGONALS: Offset[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1]
]

describe('cloud resolve reference neighborhood', () => {
  setCurrentSpec('cloudsResolveNeighborhood')

  for (const upscale of [false, true]) {
    for (const shadow of [false, true]) {
      it(`production upscale=${upscale} shadowLength=${shadow} uses cross N5`, () => {
        const wgsl = compileCloud(upscale, shadow)
        const groups = momentGroups(wgsl, upscale)
        expect(groups).toHaveLength(shadow ? 2 : 1)
        log('production-neighborhood', {
          upscale,
          shadow,
          expected: JSON.stringify(CROSS),
          actual: JSON.stringify(groups)
        })
        for (const group of groups) {
          expect(group.offsets).toEqual(CROSS)
          expectDenominators(wgsl, group, 5)
        }
        expect(wgsl).not.toMatch(/\btextureSample\(/)
      })
    }
    it(`standalone upscale=${upscale} uses cross N5`, () => {
      const wgsl = compileCloud(upscale, false, true)
      const groups = momentGroups(wgsl, upscale)
      expect(groups).toHaveLength(1)
      log('standalone-neighborhood', {
        upscale,
        expected: JSON.stringify(CROSS),
        actual: JSON.stringify(groups)
      })
      expect(groups[0]!.offsets).toEqual(CROSS)
      expectDenominators(wgsl, groups[0]!, 5)
    })
  }

  it('diagonal-only extremes cannot widen the compiled cloud clipping box', () => {
    const group = momentGroups(compileCloud(false, false), false)[0]!
    const current: Color = [0.2, 0.2, 0.2, 1]
    const history: Color = [0.8, 0.8, 0.8, 1]
    const sample = ([x, y]: Offset): Color =>
      x !== 0 && y !== 0 ? [1, 1, 1, 1] : [...current]
    const actual = varianceClippingCPU(
      current,
      group.offsets.map(sample),
      history,
      1
    )
    const withDiagonals = varianceClippingCPU(
      current,
      [...CROSS, ...DIAGONALS].map(sample),
      history,
      1
    )
    log('diagonal-extremes', { expected: 0.2000001, actual, withDiagonals })
    expect(actual[0]).toBeCloseTo(0.2000001, 6)
    expect(withDiagonals[0]).toBeCloseTo(0.8, 6)
  })

  it('shadow atlas retains eight neighbors, N9 and its array layer', () => {
    const atlas = new DataArrayTexture(null, 4, 4, 3)
    atlas.type = HalfFloatType
    atlas.minFilter = atlas.magFilter = LinearFilter
    const { fragment } = compileWGSL(
      buildShadowCascadeResolve({
        odBuffer: atlas,
        velocityBuffer: atlas,
        historyBuffer: atlas,
        texelSize: uniform(new Vector2(0.25, 0.25)),
        varianceGamma: uniform(1),
        temporalAlpha: uniform(0.01),
        resolution: uniform(new Vector2(4, 4)),
        cascadeIndex: float(2)
      })
    )
    const groups = momentGroups(fragment, false)
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    log('atlas-neighborhood', {
      expectedNeighbors: 8,
      normalizedSha256: createHash('sha256')
        .update(normalizeWGSL(fragment))
        .digest('hex'),
      actual: JSON.stringify(group)
    })
    expect(group.offsets).toEqual([
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
      ...CROSS
    ])
    expectDenominators(fragment, group, 9)
    expect(fragment).toContain('texture_2d_array<f32>')
    expect(fragment).toMatch(/vec3<i32>\( [^\n]+, i32\( 2\.0 \) \)/)
    expect(
      fragment.match(/textureLoad\([^\n]+, \w+\.z, u32\( 0\.0 \)/g)
    ).toHaveLength(8)
  })
})
