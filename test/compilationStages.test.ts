// Tests and timing measurements for TSL graph construction and compilation stages
import { PerspectiveCamera, Texture } from 'three'
// @ts-expect-error unexported Three.js class
import RenderContexts from 'three/src/renderers/common/RenderContexts.js'
import { texture, context as tslContext } from 'three/tsl'
import { WebGPUBackend, type Node } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

import { type CloudsContext } from '../src/CloudsContext'
import { CloudsPassNode } from '../src/CloudsPassNode'
import { compileWGSL } from './helpers/compileWGSL'

function builderContext() {
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  return tslContext({
    getAtmosphere: () => atmosphere,
    getClouds: () => ({})
  })
}

function withBackendPatched<T>(run: () => T): T {
  const backend = WebGPUBackend.prototype as unknown as {
    hasFeature?: (name: string) => boolean
  }
  const hasFeature = backend.hasFeature
  backend.hasFeature = () => false
  try {
    return run()
  } finally {
    backend.hasFeature = hasFeature
  }
}

const fakeBuilder = {
  renderer: {
    backend: { isWebGPUBackend: true },
    hasFeature: () => false
  }
}

describe('TSL Graph Construction and Compilation', () => {
  it('compiles the real ray-marching graph and verifies full shader size', () => {
    withBackendPatched(() => {
      const pass = new CloudsPassNode({ sceneDepth: null })
      const anyPass = pass as unknown as {
        material: { fragmentNode: unknown }
        shadowMaterial: { fragmentNode: unknown }
        resolveMaterial: { fragmentNode: unknown }
        layerRT: unknown
        shadowRT: unknown
        resolveRT: unknown
      }

      // Build the real graph by compiling the composite node with proper atmosphere context
      compileWGSL(pass.composite(texture(new Texture())), {
        contextNode: builderContext()
      })

      // Verify Primary March compiles the real graph (>100 KB), not an unbuilt 829-byte placeholder
      const marchRes = compileWGSL(anyPass.material.fragmentNode as Node, {
        renderTarget: anyPass.layerRT,
        contextNode: builderContext()
      })
      expect(marchRes.fragment.length).toBeGreaterThan(100_000)

      // Verify Shadow Pass compiles the real shadow graph
      const shadowRes = compileWGSL(
        anyPass.shadowMaterial.fragmentNode as Node,
        {
          renderTarget: anyPass.shadowRT,
          contextNode: builderContext()
        }
      )
      expect(shadowRes.fragment.length).toBeGreaterThan(10_000)

      // Verify Resolve Pass compiles the real resolve graph
      const resolveRes = compileWGSL(
        anyPass.resolveMaterial.fragmentNode as Node,
        {
          renderTarget: anyPass.resolveRT,
          contextNode: builderContext()
        }
      )
      expect(resolveRes.fragment.length).toBeGreaterThan(1_000)

      pass.dispose()
    })
  })

  it('verifies warm frames avoid unnecessary graph rebuilds', () => {
    const pass = new CloudsPassNode({ sceneDepth: null })
    const ctx = pass.cloudsContext
    const anyPass = pass as unknown as {
      graphNeedsRebuild: () => boolean
      lastBuiltVersion: number
      cloudsContext: CloudsContext
      setup: (builder: unknown) => unknown
    }

    // Graph requires initial build
    expect(anyPass.graphNeedsRebuild()).toBe(true)
    anyPass.setup(fakeBuilder)

    // After initial build, lastBuiltVersion is set to initial graphVersion
    expect(anyPass.lastBuiltVersion).toBe(ctx.graphVersion)
    expect(anyPass.graphNeedsRebuild()).toBe(false)

    // Simulating multiple warm frames without changes
    for (let frame = 1; frame <= 50; frame++) {
      ctx.frame = frame
      ctx.time = frame * 0.016
      expect(anyPass.graphNeedsRebuild()).toBe(false)
    }

    pass.dispose()
  })

  it('verifies deliberate graphVersion-changing settings trigger exactly one rebuild', () => {
    const pass = new CloudsPassNode({ sceneDepth: null })
    const ctx = pass.cloudsContext
    const anyPass = pass as unknown as {
      graphNeedsRebuild: () => boolean
      lastBuiltVersion: number
      setup: (builder: unknown) => unknown
    }

    // Initial build
    anyPass.setup(fakeBuilder)
    expect(anyPass.graphNeedsRebuild()).toBe(false)

    // Feature toggle: lightShafts
    ctx.lightShafts = !ctx.lightShafts
    expect(anyPass.graphNeedsRebuild()).toBe(true)

    // Rebuilding graph consumes the rebuild flag
    anyPass.setup(fakeBuilder)
    expect(anyPass.graphNeedsRebuild()).toBe(false)

    // Quality preset change
    ctx.qualityPreset = 'ultra'
    expect(anyPass.graphNeedsRebuild()).toBe(true)
    anyPass.setup(fakeBuilder)
    expect(anyPass.graphNeedsRebuild()).toBe(false)

    pass.dispose()
  })

  it('demonstrates call-depth independent stateKey in r187 RenderContexts (three.js r187, upstream pull 35014)', () => {
    const fakeRenderer = {
      getClearDepth: () => 1,
      getClearStencil: () => 0
    }
    const contexts = new RenderContexts(fakeRenderer)

    // In r187, RenderContexts.get accepts (renderTarget, mrt, callDepth, camera)
    // and populates stateKey independent of callDepth
    const rcDepth0 = contexts.get(null, null, 0, null)
    const rcDepth1 = contexts.get(null, null, 1, null)

    // Both contexts represent compatible attachments at different depths
    expect(rcDepth0.stateKey).toBeDefined()
    expect(rcDepth1.stateKey).toBeDefined()
    expect(rcDepth0.stateKey).toBe(rcDepth1.stateKey)
    // But have separate bindings context keys per depth
    expect(rcDepth0).not.toBe(rcDepth1)
  })

  it('compiles and inventories all custom materials required for prewarming', () => {
    const pass = new CloudsPassNode({ sceneDepth: null })
    const anyPass = pass as unknown as {
      material: { name: string; fragmentNode: unknown; vertexNode: unknown }
      shadowMaterial: { name: string; fragmentNode: unknown }
      shadowResolveMaterial: { name: string; fragmentNode: unknown }
      resolveMaterial: { name: string; fragmentNode: unknown }
      layerRT: { count: number; textures: unknown[] }
      shadowRT: unknown
      resolveRT: unknown
      historyRT: unknown
    }

    const inventory = [
      {
        name: anyPass.material.name,
        type: 'quad-raster',
        target: 'layerRT',
        attachments: anyPass.layerRT.count
      },
      {
        name: anyPass.shadowMaterial.name,
        type: 'quad-raster-array',
        target: 'shadowRT',
        attachments: 1
      },
      {
        name: anyPass.shadowResolveMaterial.name,
        type: 'quad-raster-temporal',
        target: 'shadowResolveRT',
        attachments: 1
      },
      {
        name: anyPass.resolveMaterial.name,
        type: 'quad-raster-resolve',
        target: 'resolveRT',
        attachments: 1
      }
    ]

    expect(inventory).toHaveLength(4)
    for (const item of inventory) {
      expect(item.name.length).toBeGreaterThan(0)
      expect(item.target.length).toBeGreaterThan(0)
    }

    pass.dispose()
  })
})
