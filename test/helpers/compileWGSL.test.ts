import { Data3DTexture, NearestFilter } from 'three'
import { Break, float, Fn, Loop, remapClamp, texture3D, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import {
  compileWGSL,
  expectWGSL,
  findStructByMembers,
  jsClassNamesInWgsl,
  normalizeWGSL,
  WGSLStructNotFoundError
} from './compileWGSL'
import { createContextStub } from './contextStub'
import { setCurrentSpec } from './log'

describe('compileWGSL', () => {
  setCurrentSpec('compileWGSL')

  it('compiles the probe graph with Loop/Break, 3D texture, remapClamp', () => {
    const data = new Uint8Array(4 * 4 * 4 * 4)
    const tex3d = new Data3DTexture(data, 4, 4, 4)
    tex3d.minFilter = NearestFilter
    tex3d.magFilter = NearestFilter

    const probeGraph = Fn(() => {
      const acc = vec3(0).toVar()
      Loop(10, () => {
        const uv = vec3(remapClamp(acc.x, 0, 10, 0, 1), 0.5, 0.5)
        const sample = texture3D(tex3d, uv)
        acc.addAssign(sample.rgb.div(vec3(2, 2, 2)))
        Break()
      })
      return acc
    })

    const t0 = performance.now()
    const result = compileWGSL(probeGraph())
    const dt = performance.now() - t0
    console.log(`compileWGSL probe: ${dt.toFixed(1)} ms`)

    expect(result.fragment).toBeTruthy()
    expect(result.vertex).toBeTruthy()
    expectWGSL(result.fragment).toContain('break;')
    expectWGSL(result.fragment).toContain('/ vec3<f32>( 2.0, 2.0, 2.0 )')
    expectWGSL(result.fragment).toContain('clamp(')

    console.log('Fragment WGSL excerpt:', result.fragment.slice(0, 600))
  })

  it('normaliser makes two builds of the same graph equal', () => {
    const makeGraph = () =>
      Fn(() => float(42).mul(float(2)).clamp(0.0, 100.0))()

    const a = compileWGSL(makeGraph())
    const b = compileWGSL(makeGraph())

    expect(normalizeWGSL(a.fragment)).toBe(normalizeWGSL(b.fragment))
    expect(normalizeWGSL(a.vertex)).toBe(normalizeWGSL(b.vertex))
  })

  it('accepts a contextNode from createContextStub', () => {
    const { contextNode } = createContextStub()
    const trivialGraph = Fn(() => float(1.0))()
    const result = compileWGSL(trivialGraph, { contextNode })
    expect(result.fragment).toBeTruthy()
  })
})

// A compileWGSL build that types a node as a JS class is a green stub and a
// black canvas, so the pattern has to be both narrow enough to leave main's own
// output alone and wide enough to catch the shape three produces
describe('jsClassNamesInWgsl', () => {
  setCurrentSpec('js-class-names')

  // The observed emitted shape. A struct member whose value three could not type
  // at build time, so it wrote the constructor name
  it('names a class used as a declared type', () => {
    const wgsl = `
struct DirectionalSkySamples {
  toward : VaryingNode,
  away : VaryingNode
}
`
    // Deduped: two members of the same class are one finding
    expect(jsClassNamesInWgsl(wgsl)).toEqual(['VaryingNode'])
  })

  it('names the three classes anywhere, not only in a type position', () => {
    // A leak can reach a cast or an argument, where there is no colon to find
    const wgsl = `
var nodeVar3 = UniformNode_2;
let t = TextureNode_4;
`
    expect(jsClassNamesInWgsl(wgsl).sort()).toEqual([
      'TextureNode',
      'UniformNode'
    ])
  })

  // The false positives the pattern has to leave alone. three stamps its own
  // revision and names generated structs from a per-build counter, and a
  // lowercase variable is not a type
  it('leaves the identifiers three generates itself', () => {
    const wgsl = `
// Three.js r185 - Node System
struct NodeBuffer_21507 {
  nodeVar12 : f32,
  nodeVar3 : vec3<f32>,
}
@group(0) @binding(0) var<uniform> nodeUniform_7 : CloudsFragmentOutput;
`
    expect(jsClassNamesInWgsl(wgsl)).toEqual([])
    // And the normaliser still folds those counters, which is what the digests
    // depend on
    expect(normalizeWGSL(wgsl)).toContain('NodeBufferN')
  })

  it('finds nothing in a struct that three typed properly', () => {
    const wgsl = `
struct DirectionalSkySamples {
  toward : vec3<f32>,
  away : vec3<f32>,
}
`
    expect(jsClassNamesInWgsl(wgsl)).toEqual([])
  })
})

describe('findStructByMembers', () => {
  setCurrentSpec('findStructByMembers')

  const wgsl = [
    'struct StructType0 {',
    '\tnear : vec4<f32>,',
    '\tfar : vec4<f32>',
    '};',
    'struct StructType1 {',
    '\tnear : vec4<f32>,',
    '\tfar : vec4<f32>,',
    '\tground : bool',
    '};'
  ].join('\n')

  it('returns the struct whose members match exactly, in order', () => {
    expect(
      findStructByMembers(wgsl, { near: 'vec4<f32>', far: 'vec4<f32>' })
    ).toBe('StructType0')
    expect(
      findStructByMembers(wgsl, {
        near: 'vec4<f32>',
        far: 'vec4<f32>',
        ground: 'bool'
      })
    ).toBe('StructType1')
  })

  it('throws a WGSLStructNotFoundError naming the members on a miss', () => {
    const find = (): string =>
      findStructByMembers(wgsl, { near: 'vec2<f32>', far: 'vec2<f32>' })
    expect(find).toThrow(WGSLStructNotFoundError)
    expect(find).toThrow('{ near: vec2<f32>, far: vec2<f32> }')
  })
})
