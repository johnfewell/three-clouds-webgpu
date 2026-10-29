// Bookkeeping and convergence tests for experimental.staticMode
//
// Asserts that static mode skips only when inputs are strictly unchanged,
// and that any camera, sun, time, knob, texture or size change resumes rendering

import { DataTexture, Matrix4, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { table } from '../../test/helpers/cpuTwin'
import { log } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { clouds, type CloudsPassNode } from '../CloudsPassNode'
import {
  contextConvergenceFrames,
  StaticModeTracker,
  type FrameDimensions
} from './staticMode'

function makeTracker(): StaticModeTracker {
  return new StaticModeTracker()
}

function makeContext(staticMode = true): CloudsContext {
  const ctx = new CloudsContext()
  ctx.experimental = { staticMode }
  return ctx
}

function makeCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 1000)
  cam.position.set(0, 1000, 2000)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

const DEFAULT_SIZE: FrameDimensions = { fullW: 1920, fullH: 1080 }

function convergeTracker(
  tracker: StaticModeTracker,
  ctx: CloudsContext,
  camera: PerspectiveCamera,
  size = DEFAULT_SIZE,
  frames = contextConvergenceFrames(ctx)
): void {
  for (let f = 0; f < frames; f++) {
    ctx.frame = f
    expect(tracker.isStatic(ctx, camera, size, true)).toBe(false)
    tracker.recordRender(ctx, camera, size)
  }
}

describe('StaticModeTracker convergence and opt-in flag', () => {
  it('never skips when staticMode is false', () => {
    const tracker = makeTracker()
    const ctx = makeContext(false)
    const camera = makeCamera()

    for (let f = 0; f < 30; f++) {
      ctx.frame = f
      expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
      tracker.recordRender(ctx, camera, DEFAULT_SIZE)
    }
    expect(tracker.renderedFrames).toBe(0)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
  })

  it('never skips before history is ready', () => {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    const camera = makeCamera()

    convergeTracker(tracker, ctx, camera)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, false)).toBe(false)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(true)
  })

  it('requires 16 advancing frames upscaled, with no shadow history', () => {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    ctx.temporalUpscale = true
    ctx.shadow.temporalPass = false
    const camera = makeCamera()

    for (let f = 0; f < 15; f++) {
      ctx.frame = f
      expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
      tracker.recordRender(ctx, camera, DEFAULT_SIZE)
      expect(tracker.renderedFrames).toBe(f + 1)
    }
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)

    ctx.frame = 15
    tracker.recordRender(ctx, camera, DEFAULT_SIZE)
    expect(tracker.renderedFrames).toBe(16)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(true)

    log('temporal-upscale-converged', {
      requiredFrames: 16,
      renderedFrames: tracker.renderedFrames,
      isStatic: true
    })
  })

  it('does not advance convergence count if frame does not advance', () => {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    ctx.temporalUpscale = true
    const camera = makeCamera()

    ctx.frame = 0
    tracker.recordRender(ctx, camera, DEFAULT_SIZE)
    expect(tracker.renderedFrames).toBe(1)

    // Repeated renders with unchanged frame ID must not count as convergence
    tracker.recordRender(ctx, camera, DEFAULT_SIZE)
    expect(tracker.renderedFrames).toBe(1)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
  })

  it('requires 66 frames at full resolution, the colour TAA at alpha 0.1', () => {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    ctx.temporalUpscale = false
    ctx.shadow.temporalPass = false
    const camera = makeCamera()

    for (let f = 0; f < 65; f++) {
      expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
      tracker.recordRender(ctx, camera, DEFAULT_SIZE)
    }
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
    tracker.recordRender(ctx, camera, DEFAULT_SIZE)
    expect(tracker.renderedFrames).toBe(66)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(true)
  })

  it('remains static after convergence whether frame pauses or advances', () => {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    const camera = makeCamera()
    convergeTracker(tracker, ctx, camera)

    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(true)
    // Advancing frame with no input changes stays static
    ctx.frame = 99
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(true)
  })
})

describe('StaticModeTracker input sensitivity: proves each input resumes rendering', () => {
  function verifyInputBreak(
    label: string,
    mutate: (
      ctx: CloudsContext,
      cam: PerspectiveCamera,
      sz: FrameDimensions
    ) => void
  ): void {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    const camera = makeCamera()
    const size = { ...DEFAULT_SIZE }

    convergeTracker(tracker, ctx, camera, size)
    expect(tracker.isStatic(ctx, camera, size, true)).toBe(true)

    mutate(ctx, camera, size)
    const isStaticAfterMutation = tracker.isStatic(ctx, camera, size, true)
    table(`input-break-${label}`, [
      { field: 'label', expected: label, actual: label },
      {
        field: 'resumed rendering',
        expected: true,
        actual: !isStaticAfterMutation
      }
    ])
    expect(
      isStaticAfterMutation,
      `input change '${label}' must resume rendering (isStatic false)`
    ).toBe(false)
    expect(tracker.renderedFrames).toBe(0)
  }

  it('resumes rendering on camera position change', () => {
    verifyInputBreak('camera-position', (_ctx, cam) => {
      cam.position.x += 1
      cam.updateMatrixWorld(true)
    })
  })

  it('resumes rendering on camera rotation change', () => {
    verifyInputBreak('camera-rotation', (_ctx, cam) => {
      cam.rotation.y += 0.05
      cam.updateMatrixWorld(true)
    })
  })

  it('resumes rendering on camera projection FOV change', () => {
    verifyInputBreak('camera-fov', (_ctx, cam) => {
      cam.fov += 5
      cam.updateProjectionMatrix()
    })
  })

  it('resumes rendering on sun direction change', () => {
    verifyInputBreak('sun-direction', ctx => {
      ctx.sunDirection.x += 0.01
    })
  })

  it('resumes rendering on time change', () => {
    verifyInputBreak('time', ctx => {
      ctx.time += 0.1
    })
  })

  it('resumes rendering on viewport width change', () => {
    verifyInputBreak('viewport-width', (_ctx, _cam, sz) => {
      sz.fullW += 10
    })
  })

  it('resumes rendering on viewport height change', () => {
    verifyInputBreak('viewport-height', (_ctx, _cam, sz) => {
      sz.fullH += 10
    })
  })

  it('resumes rendering on graphVersion bump', () => {
    verifyInputBreak('graph-version', ctx => {
      ctx.scatterAnisotropy1 = 0.5
    })
  })

  it('resumes rendering on coverage change', () => {
    verifyInputBreak('coverage', ctx => {
      ctx.coverage += 0.05
    })
  })

  it('resumes rendering on scatteringCoefficient change', () => {
    verifyInputBreak('scatteringCoefficient', ctx => {
      ctx.scatteringCoefficient += 0.1
    })
  })

  it('resumes rendering on powderScale change', () => {
    verifyInputBreak('powderScale', ctx => {
      ctx.powderScale += 0.2
    })
  })

  it('resumes rendering on localWeatherOffset change', () => {
    verifyInputBreak('localWeatherOffset', ctx => {
      ctx.localWeatherOffset.x += 10
    })
  })

  it('resumes rendering on localWeatherVelocity change', () => {
    verifyInputBreak('localWeatherVelocity', ctx => {
      ctx.localWeatherVelocity.y += 2
    })
  })

  it('resumes rendering on shapeVelocity change', () => {
    verifyInputBreak('shapeVelocity', ctx => {
      ctx.shapeVelocity.z += 1
    })
  })

  it('resumes rendering on moonGain change', () => {
    verifyInputBreak('moonGain', ctx => {
      ctx.moonGain += 0.5
    })
  })

  it('resumes rendering on lightning intensity change', () => {
    verifyInputBreak('lightning', ctx => {
      ctx.lightning = {
        intensity: 10,
        position: new Vector3(100, 200, 300),
        colour: new Vector3(1, 1, 1)
      }
    })
  })

  it('resumes rendering on cloudLayer altitude change', () => {
    verifyInputBreak('layer-altitude', ctx => {
      ctx.cloudLayers[0]!.altitude += 50
    })
  })

  it('resumes rendering on cloudLayer densityScale change', () => {
    verifyInputBreak('layer-density', ctx => {
      ctx.cloudLayers[0]!.densityScale += 0.1
    })
  })

  it('resumes rendering on cloudShape erosionShape change', () => {
    verifyInputBreak('cloudShape-erosion', ctx => {
      ctx.cloudShape.erosionShape = 0.8
    })
  })

  it('resumes rendering on convectiveProfile anvilStrength change', () => {
    verifyInputBreak('convective-anvil', ctx => {
      ctx.convectiveProfile.anvilStrength += 0.2
    })
  })

  it('resumes rendering on rainShafts strength change', () => {
    verifyInputBreak('rainShafts-strength', ctx => {
      ctx.rainShafts.strength += 0.3
    })
  })

  it('resumes rendering on cirrusDeck strength change', () => {
    verifyInputBreak('cirrusDeck-strength', ctx => {
      ctx.cirrusDeck.strength += 0.2
    })
  })

  it('resumes rendering on cirrusDeck texture change', () => {
    verifyInputBreak('cirrusDeck-texture', ctx => {
      ctx.cirrusDeck.texture = new DataTexture(new Uint8Array(4), 1, 1)
    })
  })

  it('resumes rendering on evolvingWeather wind speed change', () => {
    verifyInputBreak('evolvingWeather-windSpeed', ctx => {
      ctx.evolvingWeather.windSpeed += 5
    })
  })

  it('resumes rendering on worldToECEFMatrix change', () => {
    verifyInputBreak('worldToECEFMatrix', ctx => {
      ctx.worldToECEFMatrix.multiply(new Matrix4().makeScale(1.01, 1.01, 1.01))
    })
  })

  it('resumes rendering on localWeatherTexture change', () => {
    verifyInputBreak('localWeatherTexture', ctx => {
      ctx.localWeatherTexture = new DataTexture(new Uint8Array(4), 1, 1)
    })
  })

  it('resumes rendering on reset() call', () => {
    const tracker = makeTracker()
    const ctx = makeContext(true)
    const camera = makeCamera()

    convergeTracker(tracker, ctx, camera)
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(true)

    tracker.reset()
    expect(tracker.isStatic(ctx, camera, DEFAULT_SIZE, true)).toBe(false)
    expect(tracker.renderedFrames).toBe(0)
  })
})

describe('CloudsPassNode staticTracker integration', () => {
  it('exposes staticTracker getter on CloudsPassNode', () => {
    const pass: CloudsPassNode = clouds({ sceneDepth: null })
    expect(pass.staticTracker).toBeInstanceOf(StaticModeTracker)
    pass.dispose()
  })

  it('clears staticTracker on resetHistory and dispose', () => {
    const pass: CloudsPassNode = clouds({ sceneDepth: null })
    pass.cloudsContext.experimental = { staticMode: true }
    const camera = makeCamera()

    convergeTracker(pass.staticTracker, pass.cloudsContext, camera)
    expect(
      pass.staticTracker.isStatic(
        pass.cloudsContext,
        camera,
        DEFAULT_SIZE,
        true
      )
    ).toBe(true)

    pass.resetHistory()
    expect(
      pass.staticTracker.isStatic(
        pass.cloudsContext,
        camera,
        DEFAULT_SIZE,
        true
      )
    ).toBe(false)
    expect(pass.staticTracker.renderedFrames).toBe(0)

    convergeTracker(pass.staticTracker, pass.cloudsContext, camera)
    expect(
      pass.staticTracker.isStatic(
        pass.cloudsContext,
        camera,
        DEFAULT_SIZE,
        true
      )
    ).toBe(true)

    pass.dispose()
    expect(
      pass.staticTracker.isStatic(
        pass.cloudsContext,
        camera,
        DEFAULT_SIZE,
        true
      )
    ).toBe(false)
  })
})
