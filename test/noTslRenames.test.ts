import { Data3DTexture, PerspectiveCamera, Texture } from 'three'
import { texture, context as tslContext } from 'three/tsl'
import { WebGPUBackend, type Node } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { clouds } from '../src/CloudsPassNode'
import { createCloudTypeMap } from '../src/experimental/cloudTypeMap'
import { compileWGSL } from './helpers/compileWGSL'
import { isTslRenameNotice } from './helpers/consoleFilters'

function atmosphereContext(): Node {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({})
  })
  if (contextNode == null) throw new Error('tslContext returned null')
  return contextNode
}

function withoutDevice<T>(run: () => T): T {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature: () => boolean
  }
  const original = backend.hasFeature
  backend.hasFeature = () => false
  const stbnLoad = vi
    .spyOn(STBNLoader.prototype, 'loadAsync')
    .mockResolvedValue(new Data3DTexture())
  try {
    return run()
  } finally {
    backend.hasFeature = original
    stbnLoad.mockRestore()
  }
}

function compileFullTestGraph(contextNode: Node): void {
  const pass = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  for (const layer of ctx.cloudLayers) {
    if (layer.height > 0) layer.densityProfile.expTerm = 1
    if (layer.weatherExponent === 1) layer.weatherExponent = 1.5
  }
  ctx.cloudTypes.setMap(createCloudTypeMap({ size: 32, cells: 2 }))
  ctx.experimental = { cloudTypeMap: true, convectiveProfile: true }

  compileWGSL(pass.composite(texture(new Texture())), { contextNode })

  const anyPass = pass as unknown as {
    material: { fragmentNode: Node }
    shadowMaterial: { fragmentNode: Node }
    layerRT: unknown
    shadowRT: unknown
  }

  compileWGSL(anyPass.material.fragmentNode, {
    renderTarget: pass.layerRT,
    contextNode
  })

  compileWGSL(anyPass.shadowMaterial.fragmentNode, {
    renderTarget: anyPass.shadowRT,
    contextNode
  })
}

describe('no duplicate TSL declaration renames', () => {
  it('compiles default, march, shadow and cloudTypeMap graphs without rename notices', () => {
    withoutDevice(() => {
      const notices: string[] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        const msg = args.map(a => String(a)).join(' ')
        if (isTslRenameNotice(msg)) notices.push(msg)
        origWarn(...args)
      }

      try {
        compileFullTestGraph(atmosphereContext())
      } finally {
        console.warn = origWarn
      }

      expect(notices).toEqual([])
    })
  })
})
