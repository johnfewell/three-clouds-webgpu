import { Vector2 } from 'three'
import { clouds } from 'three-clouds-webgpu'
import { float, vec4 } from 'three/tsl'
import { RenderPipeline } from 'three/webgpu'

import type { ParityProbe } from '../../e2e/parityProbe'

export async function measureShadowPlaceholderLifecycle(probe: ParityProbe) {
  const side = probe.sideBHandle
  if (side == null) throw new Error('Lifecycle probe requires side B')
  const { renderer, camera, cloudsContext: source } = side
  const providers = renderer.contextNode.value as Record<string, unknown>
  const originalProvider = providers.getClouds
  const originalSize = renderer.getSize(new Vector2())
  const baseline = renderer.info.memory.textures
  const cycles = []
  const nextFrame = () =>
    new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  try {
    for (let cycle = 0; cycle < 5; cycle++) {
      const pass = clouds({ sceneDepth: null })
      pass.camera = camera
      const ctx = pass.cloudsContext
      ctx.qualityPreset = 'low'
      ctx.shadow.mapSize.set(16, 16)
      ctx.worldToECEFMatrix.copy(source.worldToECEFMatrix)
      ctx.sunDirection.copy(source.sunDirection)
      providers.getClouds = () => ctx
      const descriptor = pass.cloudShadow
      const placeholder = descriptor.map
      let disposals = 0
      placeholder.addEventListener('dispose', () => disposals++)
      placeholder.needsUpdate = true
      const consumer = new RenderPipeline(
        renderer,
        descriptor.mapNode.depth(float(0))
      )
      const graph = new RenderPipeline(renderer, pass.composite(vec4(0)))
      let uploaded = false
      let replaced = false
      try {
        await nextFrame()
        consumer.render()
        uploaded = renderer.info.memory.textures > baseline
        for (const size of [32, 48]) {
          renderer.setSize(size, size, false)
          pass.resetHistory()
          await nextFrame()
          graph.render()
        }
        replaced = descriptor.map !== placeholder
      } finally {
        consumer.dispose()
        graph.dispose()
        pass.dispose()
        ctx.dispose()
        providers.getClouds = originalProvider
      }
      cycles.push({
        uploaded,
        replaced,
        disposals,
        textures: renderer.info.memory.textures
      })
    }
    return { baseline, cycles, errors: [...probe.errors] }
  } finally {
    providers.getClouds = originalProvider
    renderer.setSize(originalSize.x, originalSize.y, false)
  }
}
