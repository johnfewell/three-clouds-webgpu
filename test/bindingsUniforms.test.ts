// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// Bindings CPU allocation & texture-uniform sharing
import { Data3DTexture, DataTexture, RGBAFormat, UnsignedByteType } from 'three'
import { float, int, texture as tslTexture, vec2 } from 'three/tsl'
import type { TextureNode } from 'three/webgpu'
import { describe, expect, it } from 'vitest'

import { CloudsContext } from '../src/CloudsContext'
import { CloudsPassNode } from '../src/CloudsPassNode'
import {
  createParameterUniforms,
  updateParameterUniforms
} from '../src/parameterUniforms'

describe('Bindings & Texture Uniform Sharing', () => {
  it('shares base node matrix and flipY uniforms across derived TextureNodes (three.js r187, upstream pull 34552)', () => {
    const rawTex = new DataTexture(
      new Uint8Array(16),
      2,
      2,
      RGBAFormat,
      UnsignedByteType
    )
    const baseNode = tslTexture(rawTex)
    expect(baseNode.getBase()).toBe(baseNode)

    // Derived sample, level, and bias nodes
    const uvSampleNode = baseNode.sample(vec2(0.5, 0.5))
    const levelNode = baseNode.level(int(0))
    const biasNode = baseNode.bias(float(0.5))

    expect(uvSampleNode.getBase()).toBe(baseNode)
    expect(levelNode.getBase()).toBe(baseNode)
    expect(biasNode.getBase()).toBe(baseNode)

    // Verify nested derivations point to the root base node
    const nestedLevel = uvSampleNode.level(int(0))
    expect(nestedLevel.getBase()).toBe(baseNode)
  })

  it('allows disabling 3D texture matrix updates to avoid UV-transform uniform overhead', () => {
    const tex3d = new Data3DTexture(new Uint8Array(64), 4, 4, 4)
    tex3d.matrixAutoUpdate = false
    expect(tex3d.matrixAutoUpdate).toBe(false)
    const node3d = tslTexture(tex3d)
    expect(node3d.getBase()).toBe(node3d)
  })

  it('retains stable TextureNode instances in ParameterUniforms across frames', () => {
    const ctx = new CloudsContext()
    const paramU = createParameterUniforms(ctx)

    const initialShapeNode = paramU.shapeTexture
    const initialDetailNode = paramU.shapeDetailTexture
    const initialWeatherNode = paramU.localWeatherTexture
    const initialTurbulenceNode = paramU.turbulenceTexture

    // Simulate multi-frame uniform updates
    for (let frame = 1; frame <= 10; frame++) {
      ctx.frame = frame
      updateParameterUniforms(paramU, ctx)

      // Node identities must remain strictly stable
      expect(paramU.shapeTexture).toBe(initialShapeNode)
      expect(paramU.shapeDetailTexture).toBe(initialDetailNode)
      expect(paramU.localWeatherTexture).toBe(initialWeatherNode)
      expect(paramU.turbulenceTexture).toBe(initialTurbulenceNode)
    }
  })

  it('updates TextureNode.value on history swap without allocating new TextureNodes', () => {
    const pass = new CloudsPassNode({ sceneDepth: null })
    const anyPass = pass as unknown as {
      ensureResolveTargets: (ctx: CloudsContext) => void
      buildResolveGraph: (ctx: CloudsContext, paramU: unknown) => void
      swapResolveBuffers: () => void
      _historyTexNode: TextureNode | null
      resolveRT: { textures: { id: number }[] }
      historyRT: { textures: { id: number }[] }
      cloudsContext: CloudsContext
      _parameterUniforms: unknown
    }

    // Initialize resolve graph
    anyPass.ensureResolveTargets(anyPass.cloudsContext)
    const paramU = createParameterUniforms(anyPass.cloudsContext)
    anyPass.buildResolveGraph(anyPass.cloudsContext, paramU)

    const historyNode = anyPass._historyTexNode
    expect(historyNode).toBeDefined()
    expect(historyNode).not.toBeNull()

    const initialTexId = (historyNode!.value as { id: number }).id
    const initialHistoryNodeRef = historyNode

    // Swap resolve buffers
    anyPass.swapResolveBuffers()

    // Node reference is preserved, only .value was swapped to the new ping-pong texture
    expect(anyPass._historyTexNode).toBe(initialHistoryNodeRef)
    const swappedTexId = (anyPass._historyTexNode!.value as { id: number }).id
    expect(swappedTexId).not.toBe(initialTexId)

    // Second swap returns to initial texture ID
    anyPass.swapResolveBuffers()
    expect((anyPass._historyTexNode!.value as { id: number }).id).toBe(
      initialTexId
    )
    expect(anyPass._historyTexNode).toBe(initialHistoryNodeRef)
  })

  interface SimulatedBinding {
    texture: { id: number; version: number }
    generation: number
  }

  function simulateBindingsUpdate(
    bindings: SimulatedBinding[],
    prevGenerations: number[],
    cacheKeyIds: number[]
  ): { updated: boolean; cacheKey: string; version: number } {
    let needsBindingsUpdate = false
    let cacheKeyLength = 0
    let version = 0

    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i]!
      if (b.generation !== prevGenerations[i]) {
        b.generation = prevGenerations[i]!
        needsBindingsUpdate = true
      }
      cacheKeyIds[cacheKeyLength++] = b.texture.id
      version += b.texture.version
    }

    if (needsBindingsUpdate) {
      cacheKeyIds.length = cacheKeyLength
      const cacheKey = cacheKeyIds.join(',')
      return { updated: true, cacheKey, version }
    }
    return { updated: false, cacheKey: '', version }
  }

  it('quantifies bind-group update behavior on warm unchanged vs swapped frames', () => {
    // Model Bindings._update logic from Three.js r187
    let stringAllocations = 0
    let bindingUpdates = 0
    const _cacheKeyIds: number[] = []

    function runFrame(bindings: SimulatedBinding[], prevGenerations: number[]) {
      const res = simulateBindingsUpdate(
        bindings,
        prevGenerations,
        _cacheKeyIds
      )
      if (res.updated) {
        bindingUpdates++
        stringAllocations++
      }
      return res
    }

    const staticBindings = [
      { texture: { id: 10, version: 1 }, generation: 1 },
      { texture: { id: 11, version: 1 }, generation: 1 },
      { texture: { id: 12, version: 1 }, generation: 1 }
    ]

    // Warm unchanged frame (Primary Ray March)
    const resUnchanged = runFrame(staticBindings, [1, 1, 1])
    expect(resUnchanged.updated).toBe(false)
    expect(bindingUpdates).toBe(0)
    expect(stringAllocations).toBe(0)

    // Swapped frame (Ping-pong history swap alters generation)
    const resSwapped = runFrame(staticBindings, [1, 2, 1])
    expect(resSwapped.updated).toBe(true)
    expect(resSwapped.cacheKey).toBe('10,11,12')
    expect(bindingUpdates).toBe(1)
    expect(stringAllocations).toBe(1)
  })
})
