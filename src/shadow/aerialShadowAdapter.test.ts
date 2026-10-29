import { DepthTexture, PerspectiveCamera, Texture } from 'three'
import { float, texture, context as tslContext, vec2, vec3 } from 'three/tsl'
import { WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, describe, expect, it } from 'vitest'

import {
  AerialPerspectiveNode,
  AtmosphereContext
} from '@takram/three-atmosphere/webgpu'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import {
  aerialPerspectiveWithCloudShadow,
  assertAerialShadowInputs
} from './aerialShadowAdapter'

// The compile stub has no device; hasFeature() would deref null. Restored
// after the file so no other suite inherits the patch
const backendPrototype = WebGPUBackend.prototype as unknown as {
  hasFeature: () => boolean
}
const originalHasFeature = backendPrototype.hasFeature
backendPrototype.hasFeature = () => false
afterAll(() => {
  backendPrototype.hasFeature = originalHasFeature
})

describe('aerialShadowAdapter routes both inputs to AerialPerspectiveNode', () => {
  it('sets shadowNode and lightingMaskNode on the plain node', () => {
    const shadow = float(0.5)
    const mask = float(0)
    const node = aerialPerspectiveWithCloudShadow(
      null as unknown as Node<'vec4'>,
      null as unknown as Node<'float'>,
      null,
      shadow,
      undefined,
      mask
    )
    log('adapter-inputs', {
      nodeClass: node.constructor.name,
      shadowSet: node.shadowNode === shadow,
      maskSet: node.lightingMaskNode === mask
    })
    expect(node.constructor).toBe(AerialPerspectiveNode)
    expect(node.shadowNode).toBe(shadow)
    expect(node.lightingMaskNode).toBe(mask)
  })

  it('leaves both inputs null for callers that pass neither', () => {
    const node = aerialPerspectiveWithCloudShadow(
      null as unknown as Node<'vec4'>,
      null as unknown as Node<'float'>,
      null,
      null
    )
    expect(node.constructor).toBe(AerialPerspectiveNode)
    expect(node.shadowNode).toBeNull()
    expect(node.lightingMaskNode).toBeNull()
  })
})

describe('assertAerialShadowInputs', () => {
  it('fires on an object lacking the hook inputs, as the npm build is', () => {
    expect(() => assertAerialShadowInputs({})).toThrow(
      /no shadowNode \/ lightingMaskNode input/
    )
    expect(() => assertAerialShadowInputs({ shadowNode: null })).toThrow()
  })

  it('passes an object with both inputs and the fork build node', () => {
    expect(() =>
      assertAerialShadowInputs({ shadowNode: null, lightingMaskNode: null })
    ).not.toThrow()
    const node = aerialPerspectiveWithCloudShadow(
      null as unknown as Node<'vec4'>,
      null as unknown as Node<'float'>,
      null,
      null
    )
    expect(() => assertAerialShadowInputs(node)).not.toThrow()
  })
})

function compileAerial(opts: {
  shadow: number | null
  mask: number | null
  lighting: boolean
  prepare?: (node: AerialPerspectiveNode) => void
}): string {
  const ctx = new AtmosphereContext()
  ;(ctx as never as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => ctx,
    getClouds: () => ({})
  }) as never
  const node = aerialPerspectiveWithCloudShadow(
    texture(new Texture()),
    texture(new DepthTexture(4, 4)),
    vec2(0, 0),
    opts.shadow == null ? null : float(opts.shadow),
    texture(new Texture()),
    opts.mask == null ? null : float(opts.mask)
  )
  node.lighting = opts.lighting
  opts.prepare?.(node)
  return compileWGSL(node as never, { contextNode }).fragment
}

const count = (text: string, pattern: RegExp): number =>
  text.match(new RegExp(pattern.source, 'g'))?.length ?? 0

// Marker constants make each input traceable in the emitted code, so these
// read the shader the GPU would run, not this file's prose
describe('the hook reaches the shader (stage=emission)', () => {
  const SHADOW = /\.direct \* vec3<f32>\( 0\.3125 \)/
  const SHADOWED_INDIRECT = /\.indirect \* vec3<f32>\( 0\.3125 \)/
  const MASK = /mix\(.*clamp\( 0\.4375, 0\.0, 1\.0 \)/

  it('multiplies the direct term by shadowNode once, and never the indirect', () => {
    const shadowed = compileAerial({
      shadow: 0.3125,
      mask: null,
      lighting: true
    })
    const plain = compileAerial({ shadow: null, mask: null, lighting: true })
    const table = {
      shadowedDirect: count(shadowed, SHADOW),
      shadowedIndirect: count(shadowed, SHADOWED_INDIRECT),
      plainDirect: count(plain, SHADOW)
    }
    log('hook-shadow-emission', table)
    expect(table).toEqual({
      shadowedDirect: 1,
      shadowedIndirect: 0,
      plainDirect: 0
    })
  })

  it('blends by the clamped lighting mask only when lighting is on', () => {
    const lit = compileAerial({ shadow: null, mask: 0.4375, lighting: true })
    const unlit = compileAerial({ shadow: null, mask: 0.4375, lighting: false })
    const plain = compileAerial({ shadow: null, mask: null, lighting: true })
    const table = {
      lit: count(lit, MASK),
      unlit: count(unlit, MASK),
      plain: count(plain, MASK)
    }
    log('hook-mask-emission', table)
    expect(table).toEqual({ lit: 1, unlit: 0, plain: 0 })
  })
})

// A marker sky node in place of the default makes the sky branch's writes
// traceable in the generated code
const MARKER = /(\w+) = vec3<f32>\( 0\.1234, 0\.5678, 0\.9012 \);/
const markSky = (node: AerialPerspectiveNode): void => {
  ;(node as unknown as { skyNode: unknown }).skyNode = vec3(
    0.1234,
    0.5678,
    0.9012
  )
}

// The input sample and its .toVar() copy, in emission order
function sampleAndCopy(fragment: string): {
  sample: string | undefined
  copy: string | undefined
} {
  const sample = /(\w+) = textureSample\(/.exec(fragment)?.[1]
  const copy =
    sample == null
      ? undefined
      : new RegExp(`(\\w+) = ${sample};`).exec(fragment)?.[1]
  return { sample, copy }
}

// Emission stage: the sky branch must write the returned variable (upstream's
// `x.rgb.assign(this.skyNode)`), not the input sample, which kept the
// background's sky. Checked on the generated code, so prose cannot satisfy it
describe('sky branch writes the returned variable (stage=emission)', () => {
  it('the marker sky lands on the luminance copy, not on the input sample', () => {
    const fragment = compileAerial({
      shadow: 1,
      mask: null,
      lighting: true,
      prepare: markSky
    })
    const markerVar = MARKER.exec(fragment)?.[1]
    expect(markerVar, 'the marker sky node is emitted').toBeDefined()
    const target = new RegExp(`(\\w+)\\.x = ${markerVar}\\[ 0 \\];`).exec(
      fragment
    )?.[1]
    expect(target, 'the marker is written into a variable').toBeDefined()

    const { sample, copy } = sampleAndCopy(fragment)
    expect(sample).toBeDefined()
    expect(copy, 'luminance = colorNode.toVar() is emitted').toBeDefined()
    expect(target, 'the sky must not overwrite the input sample').not.toBe(
      sample
    )
    expect(target, 'the sky goes into the returned luminance').toBe(copy)
  })
})

// Emission stage: consumers clear the background because the aerial node
// paints the sky, so a default skyNode must overwrite all three colour channels
// on every adapter path, or the clear shows through as a black sky
describe('sky pixels never show the raw scene colour (stage=emission)', () => {
  for (const shadowed of [false, true]) {
    it(`${shadowed ? 'cloud-shadowed' : 'plain'} aerial node: default sky, rgb fully replaced`, () => {
      let defaultSky = false
      let nodeClass = ''
      const fragment = compileAerial({
        shadow: shadowed ? 1 : null,
        mask: null,
        lighting: true,
        prepare: node => {
          // The default's existence is recorded before the marker replaces it
          defaultSky = node.skyNode != null
          nodeClass = node.constructor.name
          markSky(node)
        }
      })
      const marker = MARKER.exec(fragment)?.[1]
      const { copy } = sampleAndCopy(fragment)
      const written = ['x', 'y', 'z'].filter(
        (c, i) =>
          copy != null &&
          marker != null &&
          fragment.includes(`${copy}.${c} = ${marker}[ ${i} ];`)
      )
      log(`f3t2-sky-${shadowed ? 'shadowed' : 'plain'}`, {
        nodeClass,
        defaultSky,
        channelsFromSky: written.join('') || 'none',
        expected: 'xyz'
      })
      expect(defaultSky, 'the aerial node has its own sky by default').toBe(
        true
      )
      expect(written, 'sky replaces r, g and b of the returned value').toEqual([
        'x',
        'y',
        'z'
      ])
    })
  }
})
