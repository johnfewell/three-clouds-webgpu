import { assertWebGPUSupported, inspectCloudsSetup } from 'three-clouds-webgpu'
import { WebGPURenderer } from 'three/webgpu'

import type { ParityProbe } from '../../e2e/parityProbe'

export function inspectLiveCloudSetup(probe: ParityProbe) {
  const side = probe.sideBHandle
  if (side == null) throw new Error('Cloud diagnostics require side B')
  const inspect = () =>
    inspectCloudsSetup({
      renderer: side.renderer,
      pass: side.cloudsPass,
      atmosphere: side.atmosphereContext,
      depthMode: 'scene'
    })
  assertWebGPUSupported(side.renderer)
  const initial = inspect()
  const sun = side.cloudsContext.sunDirection.clone()
  const providers = side.renderer.contextNode.value as Record<string, unknown>
  const getClouds = providers.getClouds
  let invalid
  try {
    side.cloudsContext.sunDirection.set(0, 0, 0)
    providers.getClouds = () => null
    invalid = inspect()
  } finally {
    side.cloudsContext.sunDirection.copy(sun)
    providers.getClouds = getClouds
  }
  const restored = inspect()
  const uninitialized = new WebGPURenderer({
    canvas: document.createElement('canvas')
  })
  let preInitError: string | null = null
  try {
    assertWebGPUSupported(uninitialized)
  } catch (error) {
    preInitError = error instanceof Error ? error.message : String(error)
  }
  return {
    initial,
    invalid,
    restored,
    preInit: {
      initialized: uninitialized.initialized,
      backendPresent: uninitialized.backend != null,
      error: preInitError
    },
    errors: [...probe.errors]
  }
}
