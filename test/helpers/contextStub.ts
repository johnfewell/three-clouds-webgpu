import { context as tslContext } from 'three/tsl'
import { PerspectiveCamera, Scene, type Node } from 'three/webgpu'
import { vi } from 'vitest'

// @takram/three-atmosphere/webgpu cannot be imported in Node (struct layout
// API mismatch with three 0.185.1), so these minimal stubs satisfy the
// getAtmosphere/getClouds lookups during compileWGSL

export class AtmosphereContextStub {
  parametersNode = null
  dispose() {}
}

export class CloudsContextStub {
  dispose() {}
}

export interface ContextStubResult {
  atmosphereContext: AtmosphereContextStub
  cloudsContext: CloudsContextStub
  contextNode: Node
}

export function createContextStub(): ContextStubResult {
  const atmosphereContext = new AtmosphereContextStub()
  const cloudsContext = new CloudsContextStub()
  const contextNode = tslContext({
    getAtmosphere: () => atmosphereContext,
    getClouds: () => cloudsContext
  })
  return { atmosphereContext, cloudsContext, contextNode }
}

export function createScene() {
  return new Scene()
}

export function createCamera(
  fov = 75,
  aspect = 800 / 600,
  near = 0.1,
  far = 1000
) {
  return new PerspectiveCamera(fov, aspect, near, far)
}

export interface RendererSpies {
  setRenderTarget: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
}

export function rendererStub(): RendererSpies {
  return {
    setRenderTarget: vi.fn(),
    render: vi.fn()
  }
}

export function frameStub(frameId: number, camera?: PerspectiveCamera) {
  return {
    frameId,
    camera: camera ?? createCamera(),
    deltaTime: 1 / 60,
    time: frameId / 60
  }
}
