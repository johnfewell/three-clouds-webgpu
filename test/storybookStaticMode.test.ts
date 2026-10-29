// The Static Mode story must show static mode working, and its HUD must say
// what the pass did. Driven through the real pass the way the story drives it:
// the post-processing loop adds delta x timeScale to time and 1 to frame

import { PerspectiveCamera, Vector2 } from 'three'
import { describe, expect, it, vi } from 'vitest'

import {
  STATIC_MODE_STORY_TIME_SCALE,
  staticFrameSkipped
} from '../examples/storybook/src/clouds/helpers/staticModeStory'
import { clouds, type CloudsPassNode } from '../src/CloudsPassNode'
import { compileWGSL } from './helpers/compileWGSL'
import { log } from './helpers/log'

const FRAMES = 800

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

// Frame by frame: did the pass skip, and what would the HUD have shown
function driveStory(timeScale: number) {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  ctx.experimental = { staticMode: true }
  // The story's two lower layers cast shadows, so the shadow history counts
  ctx.cloudLayers[0]!.shadow = true
  ctx.cloudLayers[1]!.shadow = true
  const renderer = rendererStub()
  const camera = new PerspectiveCamera(60, 16 / 9, 1, 50000)
  camera.position.set(0, 6371000, 0)
  camera.updateMatrixWorld(true)
  pass.camera = camera
  compileWGSL(pass)
  const resolve = vi.spyOn(
    pass as unknown as { renderResolvePass: (...a: unknown[]) => void },
    'renderResolvePass'
  )
  const frames: { skipped: boolean; hud: boolean }[] = []
  let previous = 0
  for (let frameId = 1; frameId <= FRAMES; frameId++) {
    const before = resolve.mock.calls.length
    ctx.time += (1 / 60) * timeScale
    ctx.frame += 1
    pass.updateBefore({
      frameId,
      renderer,
      camera,
      deltaTime: 1 / 60,
      time: frameId / 60
    } as never)
    const rendered = pass.staticTracker.renderedFrames
    frames.push({
      skipped: resolve.mock.calls.length === before,
      hud: staticFrameSkipped(previous, rendered, true)
    })
    previous = rendered
  }
  pass.dispose()
  return frames
}

describe('Static Mode story', () => {
  it('lets the pass skip once the scene is still', () => {
    const frames = driveStory(STATIC_MODE_STORY_TIME_SCALE)
    const firstSkip = frames.findIndex(f => f.skipped)
    log('static-story-first-skip', {
      timeScale: STATIC_MODE_STORY_TIME_SCALE,
      firstSkip,
      skipped: frames.filter(f => f.skipped).length
    })
    expect(firstSkip, 'the story never let static mode skip').toBeGreaterThan(0)
  })

  it('HUD reports a skip exactly on the frames the pass skipped', () => {
    const frames = driveStory(STATIC_MODE_STORY_TIME_SCALE)
    const wrong = frames
      .map((f, i) => ({ ...f, i }))
      .filter(f => f.hud !== f.skipped)
    log('static-story-hud', {
      frames: frames.length,
      skipped: frames.filter(f => f.skipped).length,
      hudSkipped: frames.filter(f => f.hud).length,
      disagreements: wrong.length
    })
    expect(wrong.slice(0, 3)).toEqual([])
  })

  it('HUD does not report a skip while inputs change every frame', () => {
    // A ticking clock renders every frame, with the count pinned at 1
    const frames = driveStory(1)
    expect(frames.some(f => f.skipped)).toBe(false)
    expect(frames.filter(f => f.hud).length).toBe(0)
  })
})
