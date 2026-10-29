// Static mode freezes a still. It must not freeze one whose temporal
// histories are still blending: the reused frame would differ from the image
// the same inputs converge to. Driven through the pass's own frame loop, with
// the alphas read from the live uniforms the resolve shaders use

import { PerspectiveCamera, Vector2 } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'

// The share of each history's starting error a reused still may keep
const TOLERANCE = 1e-3
const MAX_FRAMES = 2000

function rendererStub() {
  const size = new Vector2(320, 180)
  return {
    getDrawingBufferSize: vi.fn((target: Vector2) => target.copy(size)),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    setMRT: vi.fn(),
    setRenderObjectFunction: vi.fn(),
    setClearColor: vi.fn(),
    clear: vi.fn(),
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: 'srgb',
    autoClear: true,
    setPixelRatio: vi.fn(),
    getRenderTarget: vi.fn(() => null),
    getPixelRatio: vi.fn(() => 1),
    getMRT: vi.fn(() => null),
    getRenderObjectFunction: vi.fn(() => null),
    getClearColor: vi.fn(() => ({ r: 0, g: 0, b: 0 })),
    getClearAlpha: vi.fn(() => 1),
    getActiveCubeFace: vi.fn(() => 0),
    getActiveMipmapLevel: vi.fn(() => 0),
    getScissorTest: vi.fn(() => false),
    setScissorTest: vi.fn(),
    compute: vi.fn(),
    backend: { isWebGPUBackend: true },
    hasFeature: () => false
  }
}

interface PassInternals {
  renderResolvePass: (...args: unknown[]) => void
  _temporalAlpha: { value: number } | null
  _shadowTemporalAlpha: { value: number } | null
}

interface Setup {
  temporalUpscale: boolean
  shadowTemporal: boolean
  casters: boolean
  updateInterval?: number
}

// Renders before the first skipped frame, and the live alphas behind them
function firstSkip(setup: Setup) {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  ctx.experimental = { staticMode: true }
  ctx.temporalUpscale = setup.temporalUpscale
  ctx.shadow.temporalPass = setup.shadowTemporal
  ctx.shadow.updateInterval = setup.updateInterval ?? 1
  for (const layer of ctx.cloudLayers) layer.shadow = setup.casters
  const renderer = rendererStub()
  const camera = new PerspectiveCamera(60, 16 / 9, 1, 50000)
  camera.position.set(0, 6371000, 0)
  camera.updateMatrixWorld(true)
  pass.camera = camera
  compileWGSL(pass)
  const internals = pass as unknown as PassInternals
  const resolve = vi.spyOn(internals, 'renderResolvePass')
  let rendered = 0
  let skippedAt = -1
  for (let frameId = 1; frameId <= MAX_FRAMES; frameId++) {
    const before = resolve.mock.calls.length
    ctx.frame = frameId
    pass.updateBefore({
      frameId,
      renderer,
      camera,
      deltaTime: 1 / 60,
      time: frameId / 60
    } as never)
    if (resolve.mock.calls.length === before) {
      skippedAt = rendered
      break
    }
    rendered++
  }
  const cloudAlpha = internals._temporalAlpha?.value ?? null
  const shadowAlpha = internals._shadowTemporalAlpha?.value ?? null
  const castsShadow = ctx.cloudLayers.castsShadow
  pass.dispose()
  return { skippedAt, cloudAlpha, shadowAlpha, castsShadow }
}

// Smallest n with (1 - alpha)^n within tolerance
function needed(alpha: number): number {
  let n = 0
  let residual = 1
  while (residual > TOLERANCE) {
    residual *= 1 - alpha
    n++
  }
  return n
}

function expectConverged(setup: Setup): void {
  const r = firstSkip(setup)
  expect(r.skippedAt, 'static mode never skipped').toBeGreaterThanOrEqual(0)
  expect(r.cloudAlpha, 'colour resolve alpha unset').not.toBeNull()
  const interval = setup.updateInterval ?? 1
  // Upscaling replaces a Bayer cell once in 16 frames instead of blending
  const colourFrames = setup.temporalUpscale ? 16 : needed(r.cloudAlpha!)
  const shadowHistory = setup.shadowTemporal && r.castsShadow
  if (shadowHistory) {
    expect(r.shadowAlpha, 'shadow resolve alpha unset').not.toBeNull()
  }
  const shadowFrames = shadowHistory ? interval * needed(r.shadowAlpha!) : 0
  const required = Math.max(colourFrames, shadowFrames)
  table(
    `static convergence tu=${setup.temporalUpscale} shadow=${setup.shadowTemporal} casters=${setup.casters} interval=${interval}`,
    [
      { field: 'colour frames', expected: colourFrames, actual: colourFrames },
      { field: 'shadow frames', expected: shadowFrames, actual: shadowFrames },
      { field: 'first skip after', expected: required, actual: r.skippedAt }
    ]
  )
  // Not before every history is within tolerance, and no later than that
  expect(r.skippedAt).toBeGreaterThanOrEqual(required)
  expect(r.skippedAt).toBeLessThanOrEqual(required + 1)
}

describe('static mode freezes only a converged still', () => {
  it('full resolution, no shadow history: the colour TAA', () => {
    expectConverged({
      temporalUpscale: false,
      shadowTemporal: false,
      casters: true
    })
  })

  it('full resolution with a shadow history', () => {
    expectConverged({
      temporalUpscale: false,
      shadowTemporal: true,
      casters: true
    })
  })

  it('upscaled with a shadow history', () => {
    expectConverged({
      temporalUpscale: true,
      shadowTemporal: true,
      casters: true
    })
  })

  it('upscaled with a shadow history updated every 4 frames', () => {
    expectConverged({
      temporalUpscale: true,
      shadowTemporal: true,
      casters: true,
      updateInterval: 4
    })
  })

  it('upscaled, no shadow history: 16 frames, as before', () => {
    expectConverged({
      temporalUpscale: true,
      shadowTemporal: false,
      casters: true
    })
  })

  it('upscaled, temporal shadows but no casting layer: 16 frames', () => {
    expectConverged({
      temporalUpscale: true,
      shadowTemporal: true,
      casters: false
    })
  })
})
