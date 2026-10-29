// The screen pass programs with experimental.staticMode on and off
//
// staticMode alters host-side frame dispatch rather than shader generation
// The five screen pass WGSL programs must compile byte-identically

import { createHash } from 'node:crypto'
import { Data3DTexture, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { PerspectiveCamera, WebGPUBackend, type Node } from 'three/webgpu'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'

interface Compiled {
  composite: string
  march: string
  shadow: string
  shadowResolve: string
  resolve: string
}

function stubContextNode() {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  return tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({}) as never
  })
}

function compile(staticMode: boolean): Compiled {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  pass.cloudsContext.experimental = { staticMode }

  const contextNode = stubContextNode()
  const dst = texture(new Texture())
  const out: Compiled = {
    composite: normalizeWGSL(
      compileWGSL(pass.composite(dst), { contextNode }).fragment
    ),
    march: '',
    shadow: '',
    shadowResolve: '',
    resolve: ''
  }

  const anyPass = pass as unknown as {
    material: { fragmentNode: Node | null }
    shadowMaterial: { fragmentNode: Node | null }
    shadowResolveMaterial: { fragmentNode: Node | null }
    resolveMaterial: { fragmentNode: Node | null }
    shadowRT: unknown
    resolveRT: unknown
  }

  const stage = (material: Node | null, renderTarget: unknown): string =>
    material == null
      ? ''
      : normalizeWGSL(
          compileWGSL(material, { renderTarget, contextNode }).fragment
        )

  out.march = stage(anyPass.material.fragmentNode, pass.layerRT)
  out.shadow = stage(anyPass.shadowMaterial.fragmentNode, anyPass.shadowRT)
  out.shadowResolve = stage(
    anyPass.shadowResolveMaterial.fragmentNode,
    anyPass.shadowRT
  )
  out.resolve = stage(anyPass.resolveMaterial.fragmentNode, anyPass.resolveRT)
  pass.dispose()
  return out
}

let originalHasFeature: (() => boolean) | undefined

beforeAll(() => {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  originalHasFeature = backend.hasFeature
  backend.hasFeature = () => false
  vi.spyOn(STBNLoader.prototype, 'loadAsync').mockResolvedValue(
    new Data3DTexture()
  )
})

afterAll(() => {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  backend.hasFeature = originalHasFeature ?? (() => false)
  vi.restoreAllMocks()
})

function digest(stages: Compiled): string {
  return createHash('sha256')
    .update(
      (Object.keys(stages) as Array<keyof Compiled>)
        .map(k => `${k} ${stages[k]}`)
        .join('')
    )
    .digest('hex')
    .slice(0, 16)
}

function screenStages(stages: Compiled): string {
  return [
    stages.composite,
    stages.march,
    stages.shadow,
    stages.shadowResolve,
    stages.resolve
  ].join('')
}

describe('static mode leaves screen pass WGSL programs byte-identical', () => {
  it('compiles every pass program identically with staticMode on and off', () => {
    const off = compile(false)
    const on = compile(true)
    log('static-mode-screen-digest', {
      screenOff: digest(off),
      screenOn: digest(on),
      marchBytes: on.march.length
    })
    expect(off.march.length).toBeGreaterThan(1000)
    expect(screenStages(on)).toBe(screenStages(off))
  })

  it('rejects a screen pass when WGSL differs', () => {
    const off = compile(false)
    const on = compile(true)
    const broken = { ...on, march: on.march.replace('fn ', 'fn x') }
    expect(screenStages(broken)).not.toBe(screenStages(off))
  })
})
