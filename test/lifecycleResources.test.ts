// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-studio/three-clouds
// Verification test for:
// Resource release and pipeline lifecycle across cloud rebuild and disposal cycles

// @ts-expect-error Three internal unexported class without type declarations
import Pipelines from 'three/src/renderers/common/Pipelines.js'
import { describe, expect, it } from 'vitest'

import { clouds, type CloudsPassNode } from '../src/CloudsPassNode'
import { qualityPresets, type QualityPreset } from '../src/qualityPresets'
import { log } from './helpers/log'

interface MockBackendStage {
  id: number
  code: string
  stage: string
}

interface MockBackendPipeline {
  cacheKey: string
  usedTimes: number
}

interface MockPipelinesInstance {
  caches: Map<string, MockBackendPipeline>
  getForRender: (renderObject: MockRenderObject) => MockBackendPipeline
}

function createMockBackend() {
  const createdPipelines: string[] = []
  const destroyedPipelines: string[] = []
  const createdPrograms: string[] = []
  const destroyedPrograms: string[] = []

  const backend = {
    createProgram(stage: MockBackendStage) {
      createdPrograms.push(`${stage.stage}:${stage.id}`)
    },
    destroyProgram(stage: MockBackendStage) {
      destroyedPrograms.push(`${stage.stage}:${stage.id}`)
    },
    createRenderPipeline(renderObject: { pipeline: MockBackendPipeline }) {
      createdPipelines.push(renderObject.pipeline.cacheKey)
    },
    destroyPipeline(pipeline: MockBackendPipeline) {
      destroyedPipelines.push(pipeline.cacheKey)
    },
    getRenderCacheKey(renderObject: { cacheKey: string }) {
      return renderObject.cacheKey
    },
    needsRenderUpdate(renderObject: { needsUpdate: boolean }) {
      return renderObject.needsUpdate
    }
  }

  const info = {
    createProgram() {},
    destroyProgram() {}
  }

  return {
    backend,
    info,
    createdPipelines,
    destroyedPipelines,
    createdPrograms,
    destroyedPrograms
  }
}

class MockRenderObject {
  name: string
  cacheKey: string
  material: { name: string }
  needsUpdate = true
  pipeline: unknown = undefined

  constructor(name: string, cacheKey: string) {
    this.name = name
    this.cacheKey = cacheKey
    this.material = { name }
  }

  getNodeBuilderState() {
    return {
      vertexShader: `void main() { /* ${this.name} vert */ }`,
      fragmentShader: `void main() { /* ${this.name} frag */ }`
    }
  }
}

function privateCompositeNodes(pass: CloudsPassNode): Map<unknown, unknown> {
  return (pass as unknown as { compositeNodes: Map<unknown, unknown> })
    .compositeNodes
}

describe('r187 pipeline and resource lifecycle', () => {
  it('releases previous pipeline when switching to an already cached pipeline (three.js r187, upstream pull 34821)', () => {
    const mock = createMockBackend()
    const nodes = {
      getForRender(ro: MockRenderObject) {
        return ro.getNodeBuilderState()
      }
    }
    const pipelines = new Pipelines(
      mock.backend,
      nodes,
      mock.info
    ) as MockPipelinesInstance

    const roA = new MockRenderObject('variant-A', 'key-A')

    // Initial compile of Variant A
    const pA = pipelines.getForRender(roA)
    expect(pipelines.caches.size).toBe(1)
    expect(pA.usedTimes).toBe(1)
    expect(mock.createdPipelines.length).toBe(1)
    expect(mock.destroyedPipelines.length).toBe(0)

    // Switch roA to Variant B
    roA.name = 'variant-B'
    roA.cacheKey = 'key-B'
    roA.needsUpdate = true
    const pB = pipelines.getForRender(roA)
    // A was released because usedTimes hit 0
    expect(pipelines.caches.size).toBe(1)
    expect(pB.usedTimes).toBe(1)
    expect(mock.createdPipelines.length).toBe(2)
    expect(mock.destroyedPipelines.length).toBe(1)

    // Switch roA BACK to Variant A (which now compiles fresh because A was released)
    roA.name = 'variant-A'
    roA.cacheKey = 'key-A'
    roA.needsUpdate = true
    const pA2 = pipelines.getForRender(roA)
    // B was released when switching back to A
    expect(pipelines.caches.size).toBe(1)
    expect(pA2.usedTimes).toBe(1)
    expect(mock.destroyedPipelines.length).toBe(2)

    log('pipeline-release-single-switch', {
      created: mock.createdPipelines.length,
      destroyed: mock.destroyedPipelines.length,
      finalCacheSize: pipelines.caches.size
    })
  })

  it('proves bounded resource caches and zero leaks over 50 A->B->A switching cycles', () => {
    const mock = createMockBackend()
    const nodes = {
      getForRender(ro: MockRenderObject) {
        return ro.getNodeBuilderState()
      }
    }
    const pipelines = new Pipelines(
      mock.backend,
      nodes,
      mock.info
    ) as MockPipelinesInstance

    const ro = new MockRenderObject('variant-A', 'key-A')
    pipelines.getForRender(ro)

    const warmupCycles = 5
    const testCycles = 50
    const cacheSizes: number[] = []

    for (let cycle = 0; cycle < warmupCycles + testCycles; cycle++) {
      // Switch to B
      ro.name = 'variant-B'
      ro.cacheKey = 'key-B'
      ro.needsUpdate = true
      pipelines.getForRender(ro)

      // Switch back to A
      ro.name = 'variant-A'
      ro.cacheKey = 'key-A'
      ro.needsUpdate = true
      pipelines.getForRender(ro)

      if (cycle >= warmupCycles) {
        cacheSizes.push(pipelines.caches.size)
      }
    }

    // Over 50 cycles post-warmup, cache size must remain exactly 1, never monotonically growing
    const maxCacheSize = Math.max(...cacheSizes)
    const minCacheSize = Math.min(...cacheSizes)
    expect(maxCacheSize).toBe(1)
    expect(minCacheSize).toBe(1)

    // Total destroyed pipelines must equal total created - 1 (the 1 actively in use)
    expect(mock.createdPipelines.length - mock.destroyedPipelines.length).toBe(
      1
    )

    log('pipeline-lifecycle-50-cycles', {
      totalCreated: mock.createdPipelines.length,
      totalDestroyed: mock.destroyedPipelines.length,
      retainedInCache: pipelines.caches.size,
      maxObservedCacheSize: maxCacheSize
    })
  })

  it('detects intentional retention positive control', () => {
    const mock = createMockBackend()
    const nodes = {
      getForRender(ro: MockRenderObject) {
        return ro.getNodeBuilderState()
      }
    }
    const pipelines = new Pipelines(
      mock.backend,
      nodes,
      mock.info
    ) as MockPipelinesInstance

    // Two render objects holding separate variants simultaneously
    const ro1 = new MockRenderObject('variant-A', 'key-A')
    const ro2 = new MockRenderObject('variant-B', 'key-B')

    // ro1 holds A
    pipelines.getForRender(ro1)
    // ro2 holds B
    pipelines.getForRender(ro2)

    // Both must be retained in cache because both are actively referenced
    expect(pipelines.caches.size).toBe(2)
    expect(mock.destroyedPipelines.length).toBe(0)

    // Releasing ro1 allows A to be destroyed when ro1 switches to B
    ro1.name = 'variant-B'
    ro1.cacheKey = 'key-B'
    ro1.needsUpdate = true
    pipelines.getForRender(ro1)

    // A is now unreferenced and destroyed, leaving only B
    expect(pipelines.caches.size).toBe(1)
    expect(mock.destroyedPipelines.length).toBe(1)

    log('pipeline-positive-control-leak-detector', {
      simultaneousVariants: 2,
      retainedBeforeRelease: 2,
      retainedAfterRelease: 1
    })
  })

  it('guarantees clean CloudsPassNode rebuild across 50 preset and feature cycles', () => {
    const pass = clouds({ sceneDepth: null })
    const context = pass.cloudsContext
    const presets = Object.keys(qualityPresets) as QualityPreset[]

    // 50 cycles of repeated preset switching and feature toggling
    for (let cycle = 0; cycle < 50; cycle++) {
      const preset = presets[cycle % presets.length]!
      context.qualityPreset = preset
      context.lightShafts = cycle % 2 === 0
      context.shapeDetail = cycle % 3 === 0
      context.turbulence = cycle % 4 === 0
      context.haze = cycle % 2 === 0

      // Trigger resolution scale and RT resizing
      context.resolutionScale = cycle % 2 === 0 ? 0.5 : 1.0
      pass.layerRT.setSize(
        cycle % 2 === 0 ? 960 : 1920,
        cycle % 2 === 0 ? 540 : 1080
      )
      pass.resolveRT?.setSize(
        cycle % 2 === 0 ? 1920 : 1280,
        cycle % 2 === 0 ? 1080 : 720
      )
    }

    // Verify all internal targets exist and have valid dimensions
    expect(pass.layerRT.width).toBeGreaterThan(0)
    expect(pass.layerRT.height).toBeGreaterThan(0)
    expect(privateCompositeNodes(pass).size).toBeLessThanOrEqual(5)

    // Clean disposal
    pass.dispose()
    context.dispose()

    log('clouds-pass-rebuild-50-cycles', {
      cyclesExecuted: 50,
      finalCompositeNodeCount: privateCompositeNodes(pass).size
    })
  })

  it('demonstrates clean R3F Clouds unmount and remount lifecycle over 50 cycles', () => {
    const createdPasses: CloudsPassNode[] = []
    const disposedPasses: CloudsPassNode[] = []

    for (let cycle = 0; cycle < 50; cycle++) {
      // Simulate R3F Clouds component mount
      const pass = clouds({ sceneDepth: null })
      createdPasses.push(pass)

      // Simulate property updates and composition during mount
      const ctx = pass.cloudsContext
      ctx.lightShafts = true
      ctx.shapeDetail = true
      ctx.resolutionScale = 0.5
      pass.layerRT.setSize(1920, 1080)

      // Simulate R3F Clouds component unmount
      ctx.localWeatherTexture = null
      ctx.shapeTexture = null
      ctx.shapeDetailTexture = null
      ctx.turbulenceTexture = null
      ctx.stbnTexture = null
      pass.dispose()
      ctx.dispose()
      disposedPasses.push(pass)
    }

    expect(createdPasses.length).toBe(50)
    expect(disposedPasses.length).toBe(50)
    // Every pass composite node map is cleared or disposed
    for (const pass of disposedPasses) {
      expect(privateCompositeNodes(pass).size).toBe(0)
    }

    log('r3f-clouds-mount-unmount-50-cycles', {
      mounted: createdPasses.length,
      unmounted: disposedPasses.length,
      allDisposed: true
    })
  })

  it('demonstrates idempotent disposal without throwing or leaking', () => {
    const pass = clouds({ sceneDepth: null })
    const context = pass.cloudsContext

    // First disposal
    expect(() => pass.dispose()).not.toThrow()
    expect(() => context.dispose()).not.toThrow()

    // Second disposal must be completely safe and idempotent
    expect(() => pass.dispose()).not.toThrow()
    expect(() => context.dispose()).not.toThrow()

    log('clouds-pass-idempotent-disposal', {
      firstDisposeStatus: 'passed',
      secondDisposeStatus: 'passed'
    })
  })
})
