import { Data3DTexture, DepthTexture, OrthographicCamera } from 'three'
import { texture, context as tslContext, vec4 } from 'three/tsl'
import {
  PerspectiveCamera,
  WebGPUBackend,
  type NodeBuilder,
  type NodeMaterial
} from 'three/webgpu'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import { STBNLoader } from '@takram/three-geospatial'

import { compileWGSL, normalizeWGSL } from '../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../test/helpers/log'
import { clouds, type CloudsPassNode } from './CloudsPassNode'

beforeEach(() => {
  setCurrentSpec('CloudsPassNode_sceneDepth')
  vi.spyOn(STBNLoader.prototype, 'loadAsync').mockResolvedValue(
    new Data3DTexture()
  )
  vi.spyOn(
    WebGPUBackend.prototype as unknown as { hasFeature: () => boolean },
    'hasFeature'
  ).mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function compileMarch(pass: CloudsPassNode) {
  compileWGSL(pass.composite(vec4(0)))
  const { material } = pass as unknown as { material: NodeMaterial }
  const atmosphere = new AtmosphereContext()
  ;(atmosphere as unknown as { camera: PerspectiveCamera }).camera =
    new PerspectiveCamera()
  return compileWGSL(material.fragmentNode!, {
    renderTarget: pass.layerRT,
    contextNode: tslContext({ getAtmosphere: () => atmosphere })
  })
}

test('depth replacements change the compiled march bindings in both directions', () => {
  const first = texture(new DepthTexture(1, 1))
  const second = texture(new DepthTexture(1, 1))
  const pass = clouds({ sceneDepth: first })
  const originalPass = pass
  pass.camera = new PerspectiveCamera()
  const reset = vi.spyOn(pass.cloudsContext, 'resetHistory')
  const initial = compileMarch(pass)
  expect(initial.boundTextures()).toContain(first.value)
  expect(initial.boundTextures()).not.toContain(second.value)

  const rows = []
  for (const depth of [second, null, first]) {
    const before = pass.customCacheKey()
    pass.sceneDepth = depth
    expect(pass.customCacheKey()).not.toBe(before)
    expect(pass).toBe(originalPass)
    const compiled = compileMarch(pass)
    const bound = compiled.boundTextures()
    expect(bound.includes(first.value)).toBe(depth === first)
    expect(bound.includes(second.value)).toBe(depth === second)
    rows.push({
      depth: depth === null ? 'null' : depth === first ? 'first' : 'second',
      firstBound: bound.includes(first.value),
      secondBound: bound.includes(second.value)
    })
  }
  expect(reset).toHaveBeenCalledTimes(3)
  log('compiled-depth-bindings', rows)
  pass.dispose()
  first.value.dispose()
  second.value.dispose()
})

test('the live composite invalidates its pipeline for non-null depth replacements', () => {
  const first = texture(new DepthTexture(1, 1))
  const second = texture(new DepthTexture(1, 1))
  const pass = clouds({ sceneDepth: first })
  pass.cloudsContext.enabled = false
  const composite = pass.composite(vec4(0))
  const material = { needsUpdate: false }
  const renderPipeline = { needsUpdate: false }
  const builder = { material, context: { renderPipeline } } as NodeBuilder
  composite.setup(builder)
  const graphVersion = pass.cloudsContext.graphVersion
  pass.sceneDepth = second
  composite.updateBefore({} as never)
  expect(pass.cloudsContext.graphVersion).toBe(graphVersion)
  expect(material.needsUpdate).toBe(true)
  expect(renderPipeline.needsUpdate).toBe(true)

  composite.setup(builder)
  material.needsUpdate = false
  renderPipeline.needsUpdate = false
  const reset = vi.spyOn(pass.cloudsContext, 'resetHistory')
  const version = pass.version
  const cacheKey = pass.customCacheKey()
  pass.sceneDepth = second
  composite.updateBefore({} as never)
  expect(reset).not.toHaveBeenCalled()
  expect(pass.version).toBe(version)
  expect(pass.customCacheKey()).toBe(cacheKey)
  expect(material.needsUpdate).toBe(false)
  expect(renderPipeline.needsUpdate).toBe(false)
  log('live-depth-invalidation', { changed: true, unchanged: false })
  pass.dispose()
  first.value.dispose()
  second.value.dispose()
})

test('replacing the scene camera rebuilds depth decoding for its projection', () => {
  const depth = texture(new DepthTexture(1, 1))
  const pass = clouds({ sceneDepth: depth })
  const perspective = new PerspectiveCamera()
  pass.camera = perspective
  const first = normalizeWGSL(compileMarch(pass).fragment)
  const firstKey = pass.customCacheKey()
  pass.camera = new OrthographicCamera()
  expect(pass.customCacheKey()).not.toBe(firstKey)
  const second = normalizeWGSL(compileMarch(pass).fragment)
  expect(second).not.toBe(first)
  pass.camera = perspective
  expect(normalizeWGSL(compileMarch(pass).fragment)).toBe(first)
  const reset = vi.spyOn(pass.cloudsContext, 'resetHistory')
  const version = pass.version
  pass.camera = perspective
  expect(pass.version).toBe(version)
  expect(reset).not.toHaveBeenCalled()
  log('camera-input-rebinding', {
    projectionRebuilt: true,
    sameCameraNoop: true
  })
  pass.dispose()
  depth.value.dispose()
})
