import { DepthTexture, PerspectiveCamera } from 'three'
import { texture, vec2, vec4 } from 'three/tsl'
import type { NodeBuilder, NodeFrame } from 'three/webgpu'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { compileWGSL, normalizeWGSL } from '../../test/helpers/compileWGSL'
import { log, setCurrentSpec } from '../../test/helpers/log'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'

const passes: CloudsPassNode[] = []

beforeEach(() => setCurrentSpec('compositeNodes'))
afterEach(() => {
  for (const pass of passes.splice(0)) pass.dispose()
  vi.restoreAllMocks()
})

function fixture() {
  const pass = clouds({ sceneDepth: null })
  pass.cloudsContext.enabled = false
  passes.push(pass)
  const material = { needsUpdate: false }
  const renderPipeline = { needsUpdate: false }
  const builder = { material, context: { renderPipeline } } as NodeBuilder
  return { pass, material, renderPipeline, builder }
}

test('asset readiness invalidates consumers and history without changing enabled intent', () => {
  const { pass, material, renderPipeline, builder } = fixture()
  const reset = vi.spyOn(pass.cloudsContext, 'resetHistory')
  const composite = pass.composite(vec4(0))
  composite.setup(builder)
  let previousKey = pass.customCacheKey()
  let previousVersion = pass.inputVersion
  for (const ready of [false, true]) {
    pass.setAssetsReady(ready)
    expect(pass.inputVersion).toBe(previousVersion + 1)
    expect(pass.customCacheKey()).not.toBe(previousKey)
    expect(pass.cloudsContext.enabled).toBe(false)
    expect(pass.renderingEnabled).toBe(false)
    composite.updateBefore({} as NodeFrame)
    expect(material.needsUpdate).toBe(true)
    expect(renderPipeline.needsUpdate).toBe(true)
    composite.setup(builder)
    material.needsUpdate = false
    renderPipeline.needsUpdate = false
    previousKey = pass.customCacheKey()
    previousVersion = pass.inputVersion
    pass.setAssetsReady(ready)
    expect(pass.inputVersion).toBe(previousVersion)
    composite.updateBefore({} as NodeFrame)
    expect(material.needsUpdate).toBe(false)
    expect(renderPipeline.needsUpdate).toBe(false)
  }
  expect(reset).toHaveBeenCalledTimes(2)
  pass.cloudsContext.enabled = true
  expect(pass.renderingEnabled).toBe(true)
  log('asset-gate-invalidation', {
    transitions: 2,
    repeatedInvalidations: 0,
    callerIntentPreserved: true
  })
})

test.each(['assets', 'enabled'] as const)(
  '%s gate compiles transparent outputs and no shadow length without building the pass',
  gate => {
    const { pass } = fixture()
    pass.cloudsContext.enabled = gate === 'assets'
    pass.cloudsContext.lightShafts = true
    pass.setAssetsReady(gate !== 'assets')
    const build = vi.spyOn(pass, 'build')
    const destination = vec4(0.1, 0.2, 0.3, 1)
    for (const [actual, expected] of [
      [pass.composite(destination), destination],
      [pass.layerNode, vec4(0)],
      [pass.depthVelocityNode, vec4(0)],
      [pass.cloudShadowLength, vec2(0)]
    ] as const) {
      expect(normalizeWGSL(compileWGSL(actual).fragment)).toBe(
        normalizeWGSL(compileWGSL(expected).fragment)
      )
    }
    expect(build).not.toHaveBeenCalled()
    expect(pass.cloudsContext.enabled).toBe(gate === 'assets')
    expect(pass.cloudsContext.resolvedStbnTexture).toBeNull()
    log('asset-gated-emission', {
      gate,
      outputs: 4,
      builds: 0,
      jitterAllocated: false
    })
  }
)

test.each(['assets', 'enabled'] as const)(
  '%s gating preserves output identity and enabled WGSL on reenable',
  gate => {
    const { pass } = fixture()
    pass.cloudsContext.enabled = true
    const outputs = [
      pass.layerNode,
      pass.depthVelocityNode,
      pass.composite(vec4(0.4))
    ]
    const before = outputs.map(node =>
      normalizeWGSL(compileWGSL(node).fragment)
    )
    if (gate === 'assets') pass.setAssetsReady(false)
    else pass.cloudsContext.enabled = false
    const gated = outputs.map(node => normalizeWGSL(compileWGSL(node).fragment))
    for (const [index, code] of gated.entries())
      expect(code).not.toBe(before[index])
    if (gate === 'assets') pass.setAssetsReady(true)
    else pass.cloudsContext.enabled = true
    expect(pass.layerNode).toBe(outputs[0])
    expect(pass.depthVelocityNode).toBe(outputs[1])
    expect(
      outputs.map(node => normalizeWGSL(compileWGSL(node).fragment))
    ).toEqual(before)
    pass.cloudsContext.dispose()
    log('asset-gated-reenable', {
      gate,
      sameOutputs: true,
      sameEnabledWGSL: true
    })
  }
)

test('unready assets skip procedural and cloud rendering and expose an all-lit shadow atlas', () => {
  const { pass } = fixture()
  pass.camera = new PerspectiveCamera()
  pass.cloudsContext.enabled = true
  pass.setAssetsReady(false)
  const procedural = vi.spyOn(pass.cloudsContext, 'renderProceduralTextures')
  const descriptor = pass.cloudShadow
  const previousAtlas = descriptor.map
  const renderer = {
    initialized: true,
    backend: { isWebGPUBackend: true },
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    compute: vi.fn()
  }
  pass.updateBefore({ renderer } as never)
  pass.prepareShadow(renderer as never)
  expect(procedural).not.toHaveBeenCalled()
  expect(renderer.setRenderTarget).not.toHaveBeenCalled()
  expect(renderer.render).not.toHaveBeenCalled()
  expect(renderer.compute).not.toHaveBeenCalled()
  expect(descriptor.map).not.toBe(previousAtlas)
  expect(descriptor.mapNode.value).toBe(descriptor.map)
  expect(
    Array.from(descriptor.map.image.data as Uint16Array).every(
      value => value === 0
    )
  ).toBe(true)
  expect(pass.cloudsContext.enabled).toBe(true)
  previousAtlas.dispose()
  log('asset-gated-render', { renders: 0, computes: 0, allLit: true })
})

test('per-frame invalidation checks input revisions without hashing graph flags', () => {
  const { pass, material, renderPipeline, builder } = fixture()
  const composite = pass.composite(vec4(0))
  composite.setup(builder)
  const hash = vi.spyOn(pass, 'customCacheKey')
  const depth = texture(new DepthTexture(1, 1))
  for (const change of [
    () => {
      pass.sceneDepth = depth
    },
    () => {
      pass.camera = new PerspectiveCamera()
    }
  ]) {
    change()
    composite.updateBefore({} as NodeFrame)
    expect(material.needsUpdate).toBe(true)
    expect(renderPipeline.needsUpdate).toBe(true)
    composite.setup(builder)
    material.needsUpdate = false
    renderPipeline.needsUpdate = false
    composite.updateBefore({} as NodeFrame)
    expect(material.needsUpdate).toBe(false)
    expect(renderPipeline.needsUpdate).toBe(false)
  }
  expect(hash).not.toHaveBeenCalled()
  log('composite input invalidation', {
    cameraAndDepthInvalidated: true,
    perFrameGraphHashes: hash.mock.calls.length
  })
  depth.value.dispose()
})

test('distinct destinations get distinct cached compositions', () => {
  const { pass, builder } = fixture()
  const firstDestination = vec4(0.1, 0.2, 0.3, 1)
  const secondDestination = vec4(0.8, 0.7, 0.6, 1)
  const first = pass.composite(firstDestination)
  const second = pass.composite(secondDestination)
  expect(pass.composite(firstDestination)).toBe(first)
  expect(pass.composite(secondDestination)).toBe(second)
  expect(second).not.toBe(first)
  expect(first.setup(builder)).toBe(firstDestination)
  expect(second.setup(builder)).toBe(secondDestination)
  log('composite destinations', { reusedSame: true, distinctDifferent: true })
})

test('disposing a composition releases only its cache entry and consumers', () => {
  const { pass, material, renderPipeline, builder } = fixture()
  const firstDestination = vec4(0)
  const secondDestination = vec4(1)
  const first = pass.composite(firstDestination)
  const second = pass.composite(secondDestination)
  const released = vi.fn()
  first.addEventListener('dispose', released)
  first.setup(builder)
  first.dispose()
  first.dispose()
  expect(released).toHaveBeenCalledTimes(1)
  expect(pass.hasComposite).toBe(true)
  expect(pass.composite(secondDestination)).toBe(second)
  const replacement = pass.composite(firstDestination)
  expect(replacement).not.toBe(first)
  expect(replacement.setup(builder)).toBe(firstDestination)
  pass.cloudsContext.enabled = true
  first.updateBefore({} as NodeFrame)
  expect(material.needsUpdate).toBe(false)
  expect(renderPipeline.needsUpdate).toBe(false)
  second.dispose()
  replacement.dispose()
  expect(pass.hasComposite).toBe(false)
  log('composite disposal', {
    released: released.mock.calls.length,
    cacheEmpty: true
  })
})

test('pass disposal releases every composition without disposing destinations', () => {
  const { pass } = fixture()
  const firstDestination = vec4(0)
  const secondDestination = vec4(1)
  const destinationDisposals = [firstDestination, secondDestination].map(
    destination => vi.spyOn(destination, 'dispose')
  )
  const releases = [firstDestination, secondDestination].map(destination => {
    const release = vi.fn()
    pass.composite(destination).addEventListener('dispose', release)
    return release
  })
  pass.dispose()
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1)
  for (const dispose of destinationDisposals)
    expect(dispose).not.toHaveBeenCalled()
  expect(pass.hasComposite).toBe(false)
  passes.splice(passes.indexOf(pass), 1)
  log('pass composite ownership', {
    released: releases.length,
    borrowedDisposed: 0
  })
})
