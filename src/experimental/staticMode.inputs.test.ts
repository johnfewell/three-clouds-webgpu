// Static mode must resume on every input the march, shadow or resolve reads
// each frame. Driven through the pass's own frame loop, so a skip is a real
// skip of the resolve and a resume is a real render

import { DataTexture, PerspectiveCamera, Texture, Vector2 } from 'three'
import { describe, expect, it, vi } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { table } from '../../test/helpers/cpuTwin'
import { CloudsContext } from '../CloudsContext'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import type { ProceduralTextureLike } from '../textures/ProceduralTexture'
import { StaticModeTracker } from './staticMode'

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

interface ResolveSpyTarget {
  renderResolvePass: (...args: unknown[]) => void
}

function staticFixture() {
  const pass: CloudsPassNode = clouds({ sceneDepth: null })
  const ctx = pass.cloudsContext
  ctx.experimental = { staticMode: true }
  ctx.temporalUpscale = false
  // No shadow history, so the colour TAA's 66 frames are the whole wait
  ctx.shadow.temporalPass = false
  const renderer = rendererStub()
  const camera = new PerspectiveCamera(60, 16 / 9, 1, 50000)
  camera.position.set(0, 6371000, 0)
  camera.updateMatrixWorld(true)
  pass.camera = camera
  // The targets the resolve and its history live in are allocated at build
  compileWGSL(pass)
  const resolve = vi.spyOn(
    pass as unknown as ResolveSpyTarget,
    'renderResolvePass'
  )
  let frameId = 0
  const step = (): number => {
    const before = resolve.mock.calls.length
    frameId++
    ctx.frame = frameId
    pass.updateBefore({
      frameId,
      renderer,
      camera,
      deltaTime: 1 / 60,
      time: frameId / 60
    } as never)
    return resolve.mock.calls.length - before
  }
  // Renders until a frame skips, so a test can wait out a re-convergence
  const settle = (): void => {
    for (let i = 0; i < 80; i++) {
      if (step() === 0) return
    }
  }
  // Every test starts from a static pass
  settle()
  expect(step(), 'static mode never engaged, so nothing is tested').toBe(0)
  return { pass, ctx, step, settle }
}

// Read by the march or the shadow pass every frame, through uniforms
const uniformInputs: [string, (ctx: CloudsContext) => void][] = [
  ...[0, 1, 2, 3].flatMap(i =>
    (['expTerm', 'exponent', 'linearTerm', 'constantTerm'] as const).map(
      key =>
        [
          `cloudLayers[${i}].densityProfile.${key}`,
          (ctx: CloudsContext) => {
            ctx.cloudLayers[i]!.densityProfile[key] += 0.125
          }
        ] as [string, (ctx: CloudsContext) => void]
    )
  ),
  ...(
    [
      'minDensity',
      'minExtinction',
      'minTransmittance',
      'hazeDensityScale',
      'hazeExponent',
      'hazeScatteringCoefficient',
      'hazeAbsorptionCoefficient'
    ] as const
  ).map(
    key =>
      [
        `clouds.${key}`,
        (ctx: CloudsContext) => {
          ctx.clouds[key] *= 1.5
        }
      ] as [string, (ctx: CloudsContext) => void]
  ),
  ...(
    [
      'maxIterationCount',
      'minStepSize',
      'maxStepSize',
      'minDensity',
      'minExtinction',
      'minTransmittance',
      'opticalDepthTailScale'
    ] as const
  ).map(
    key =>
      [
        `shadow.${key}`,
        (ctx: CloudsContext) => {
          ctx.shadow[key] *= 1.5
        }
      ] as [string, (ctx: CloudsContext) => void]
  )
]

describe('static mode resumes on per-frame uniform inputs', () => {
  it('coverage, an input it already tracked, as the positive control', () => {
    const { pass, ctx, step } = staticFixture()
    ctx.coverage += 0.1
    expect(step()).toBe(1)
    pass.dispose()
  })

  it.each(uniformInputs)('%s', (_label, mutate) => {
    const { pass, ctx, step } = staticFixture()
    mutate(ctx)
    expect(step()).toBe(1)
    pass.dispose()
  })
})

class ProceduralStub implements ProceduralTextureLike {
  readonly size = 1
  needsRender = true
  readonly texture = new Texture()
  render(): void {
    this.needsRender = false
  }
  dispose(): void {
    this.texture.dispose()
  }
}

describe('static mode resumes on texture content changes', () => {
  it('a weather texture updated in place', () => {
    const { pass, ctx, step, settle } = staticFixture()
    const weather = new DataTexture(new Uint8Array(4), 1, 1)
    ctx.localWeatherTexture = weather
    settle()
    expect(step(), 'the swapped texture must settle back to static').toBe(0)
    weather.needsUpdate = true
    expect(step()).toBe(1)
    pass.dispose()
  })

  it('a procedural generator re-filled after a parameter change', () => {
    const { pass, ctx, step, settle } = staticFixture()
    const generator = new ProceduralStub()
    ctx.localWeatherTexture = generator
    settle()
    expect(step(), 'the generator must settle back to static').toBe(0)
    // What ProceduralWeather.update() does after a uniform write
    generator.needsRender = true
    expect(step()).toBe(1)
    pass.dispose()
  })

  it('a cloud type map swapped with setMap', () => {
    const { pass, ctx, step } = staticFixture()
    ctx.cloudTypes.setMap(new DataTexture(new Uint8Array(4), 1, 1))
    expect(step()).toBe(1)
    pass.dispose()
  })
})

describe('StaticModeTracker knob buffer', () => {
  it('packs exactly the declared knob count, with no silent overflow', () => {
    // A typed array drops writes past its end, so a knob appended without
    // growing the buffer would be compared by nothing
    const tracker = new StaticModeTracker()
    const ctx = new CloudsContext()
    ctx.experimental = { staticMode: true }
    const camera = new PerspectiveCamera()
    const size = { fullW: 4, fullH: 4 }
    expect(() => tracker.recordRender(ctx, camera, size)).not.toThrow()
    const packed = (tracker as unknown as { _lastKnobs: Float64Array })
      ._lastKnobs
    table('static knob buffer', [
      { field: 'length', expected: 183, actual: packed.length }
    ])
    expect(packed.length).toBe(183)
  })
})
