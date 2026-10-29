import {
  Color,
  PerspectiveCamera,
  type ColorRepresentation,
  type WebGLRenderer,
  type WebGLRenderTarget
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import {
  AerialPerspectiveEffect,
  type SkyLightProbe,
  type SunDirectionalLight
} from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'

import { table } from '../../../test/helpers/cpuTwin'
import { NEUTRALISED_KNOBS } from './parityState'
import { createSyntheticScene } from './scenes/synthetic'
import {
  clearHistoryTargets,
  ParityCloudsEffect,
  type HistoryClearRenderer,
  type HistoryTarget
} from './sideA'

describe('ParityCloudsEffect', () => {
  it('extends CloudsEffect', () => {
    const cam = new PerspectiveCamera()
    const effect = new ParityCloudsEffect(cam)
    expect(effect).toBeInstanceOf(CloudsEffect)
    expect(effect.frameOverride).toBe(0)
  })

  it('pins frame to frameOverride after update', () => {
    const cam = new PerspectiveCamera()
    const effect = new ParityCloudsEffect(cam)
    effect.frameOverride = 42

    const superUpdate = vi.spyOn(CloudsEffect.prototype, 'update')
    // Mock simulates the ++this.frame that super.update does (:478)
    superUpdate.mockImplementation(function (this: { frame: number }) {
      ++this.frame
    })

    // The mock never touches the renderer or the input buffer
    effect.update(
      null as unknown as WebGLRenderer,
      null as unknown as WebGLRenderTarget,
      0
    )

    const frameAfterPin = (effect as unknown as { frame: number }).frame
    expect(frameAfterPin).toBe(42)

    const rows = [
      { field: 'frameOverride', expected: 42, actual: effect.frameOverride },
      { field: 'frame (after update)', expected: 42, actual: frameAfterPin }
    ]
    table('frame-pin', rows)

    superUpdate.mockRestore()
  })
})

describe('neutralised baseline defines (AUDIT-3)', () => {
  it('neutralised knobs apply correctly to CloudsEffect', () => {
    const cam = new PerspectiveCamera()
    const clouds = new ParityCloudsEffect(cam)

    // Apply neutralised knobs
    clouds.haze = NEUTRALISED_KNOBS.haze
    clouds.clouds.maxIterationCountToGround =
      NEUTRALISED_KNOBS.maxIterationCountToGround
    for (const layer of clouds.cloudLayers) {
      layer.shadow = NEUTRALISED_KNOBS.shadow
    }
    clouds.lightShafts = NEUTRALISED_KNOBS.lightShafts
    clouds.temporalUpscale = NEUTRALISED_KNOBS.temporalUpscale
    clouds.clouds.accuratePhaseFunction =
      NEUTRALISED_KNOBS.accuratePhaseFunction

    const rows = [
      {
        field: 'haze',
        expected: false,
        actual: clouds.haze
      },
      {
        field: 'maxIterationCountToGround',
        expected: 0,
        actual: clouds.clouds.maxIterationCountToGround
      },
      {
        field: 'cloudLayers[0].shadow',
        expected: false,
        actual: clouds.cloudLayers[0]?.shadow
      },
      {
        field: 'lightShafts',
        expected: false,
        actual: clouds.lightShafts
      },
      {
        field: 'temporalUpscale',
        expected: false,
        actual: clouds.temporalUpscale
      }
    ]
    table('neutralised-knobs', rows)

    expect(clouds.haze).toBe(false)
    expect(clouds.clouds.maxIterationCountToGround).toBe(0)
    expect(clouds.lightShafts).toBe(false)
    expect(clouds.temporalUpscale).toBe(false)
    for (const layer of clouds.cloudLayers) {
      expect(layer.shadow).toBe(false)
    }
  })

  it('CloudsMaterial.defines has no GROUND_BOUNCE when maxIterationCountToGround=0', () => {
    const cam = new PerspectiveCamera()
    const clouds = new ParityCloudsEffect(cam)
    clouds.clouds.maxIterationCountToGround = 0

    const material = clouds.cloudsPass.currentMaterial
    // Trigger onBeforeRender-like define evaluation by accessing defines
    // The actual defines update happens in onBeforeRender, but the initial
    // state with maxIterationCountToGround=0 should not enable GROUND_BOUNCE
    const defines = material.defines as Record<string, string>

    const rows = [
      {
        field: 'GROUND_BOUNCE',
        expected: 'absent',
        actual: defines.GROUND_BOUNCE != null ? 'present' : 'absent'
      },
      {
        field: 'shadowTopHeight uniform',
        expected: 0,
        actual: material.uniforms.shadowTopHeight?.value ?? 'N/A'
      }
    ]
    table('neutralised-defines', rows)

    expect(defines.GROUND_BOUNCE).toBeUndefined()
  })
})

describe('lighting modes (AUDIT-4)', () => {
  it('post mode: aerial has sunLight=true, skyLight=true', () => {
    const cam = new PerspectiveCamera()
    const aerial = new AerialPerspectiveEffect(cam, {
      sunLight: true,
      skyLight: true
    })

    const rows = [
      { field: 'sunLight', expected: true, actual: aerial.sunLight },
      { field: 'skyLight', expected: true, actual: aerial.skyLight }
    ]
    table('lighting-post-aerial', rows)

    expect(aerial.sunLight).toBe(true)
    expect(aerial.skyLight).toBe(true)
  })

  it('lights mode: aerial has sunLight=false, skyLight=false', () => {
    const cam = new PerspectiveCamera()
    const aerial = new AerialPerspectiveEffect(cam, {
      sunLight: false,
      skyLight: false
    })

    const rows = [
      { field: 'sunLight', expected: false, actual: aerial.sunLight },
      { field: 'skyLight', expected: false, actual: aerial.skyLight }
    ]
    table('lighting-lights-aerial', rows)

    expect(aerial.sunLight).toBe(false)
    expect(aerial.skyLight).toBe(false)
  })

  it('post mode scene has no SunDirectionalLight or SkyLightProbe', () => {
    const result = createSyntheticScene({
      nodeMaterials: false,
      lighting: 'post'
    })
    const sun = result.scene.getObjectByName('sunLight')
    const sky = result.scene.getObjectByName('skyProbe')

    const rows = [
      {
        field: 'SunDirectionalLight',
        expected: 'absent',
        actual: sun ? 'present' : 'absent'
      },
      {
        field: 'SkyLightProbe',
        expected: 'absent',
        actual: sky ? 'present' : 'absent'
      }
    ]
    table('lighting-post-scene', rows)

    expect(sun).toBeUndefined()
    expect(sky).toBeUndefined()
  })

  it('lights mode scene has SunDirectionalLight and SkyLightProbe', () => {
    const result = createSyntheticScene({
      nodeMaterials: false,
      lighting: 'lights'
    })
    const sun = result.scene.getObjectByName('sunLight')
    const sky = result.scene.getObjectByName('skyProbe')

    const rows = [
      {
        field: 'SunDirectionalLight',
        expected: 'present',
        actual: sun ? 'present' : 'absent'
      },
      {
        field: 'SkyLightProbe',
        expected: 'present',
        actual: sky ? 'present' : 'absent'
      }
    ]
    table('lighting-lights-scene', rows)

    expect(sun).toBeDefined()
    expect(sky).toBeDefined()
  })

  it('anchors WebGL atmosphere lights at the visible receiver', () => {
    const result = createSyntheticScene({
      nodeMaterials: false,
      lighting: 'lights'
    })
    const sun = result.scene.getObjectByName('sunLight') as SunDirectionalLight
    const sky = result.scene.getObjectByName('skyProbe') as SkyLightProbe
    const receiver = result.sphere.position.toArray()

    const rows = [
      { field: 'sun target', expected: receiver, actual: sun.target.position },
      { field: 'sky position', expected: receiver, actual: sky.position },
      {
        field: 'sun target in scene',
        expected: true,
        actual: result.scene.children.includes(sun.target)
      }
    ]
    table('lighting-lights-receiver-anchor', rows)

    expect(sun.target.position.toArray()).toEqual(receiver)
    expect(sky.position.toArray()).toEqual(receiver)
    expect(result.scene.children).toContain(sun.target)
  })
})

function recordingRenderer() {
  const state = {
    target: null as HistoryTarget | null,
    layer: 0,
    color: new Color(0x123456),
    alpha: 1
  }
  const clears: { layer: number; alpha: number; color: number }[] = []
  const renderer: HistoryClearRenderer = {
    getRenderTarget: () => state.target,
    setRenderTarget: (target, layer = 0) => {
      state.target = target
      state.layer = layer
    },
    getClearColor: (target: Color) => target.copy(state.color),
    getClearAlpha: () => state.alpha,
    setClearColor: (color: ColorRepresentation, alpha = 1) => {
      state.color = new Color(color)
      state.alpha = alpha
    },
    clear: () => {
      clears.push({
        layer: state.layer,
        alpha: state.alpha,
        color: state.color.getHex()
      })
    }
  }
  return { renderer, state, clears }
}

describe('clearHistoryTargets', () => {
  it('clears every layer to zero in all four channels and restores state', () => {
    const { renderer, state, clears } = recordingRenderer()
    const previous: HistoryTarget = {}
    state.target = previous
    const atlas: HistoryTarget = { isWebGLArrayRenderTarget: true, depth: 3 }
    const colour: HistoryTarget = {}

    clearHistoryTargets(renderer, [atlas, colour])

    table('history-clear', [
      { field: 'clears', expected: 4, actual: clears.length },
      {
        field: 'max clear alpha',
        expected: 0,
        actual: Math.max(...clears.map(c => c.alpha))
      },
      { field: 'alpha restored', expected: 1, actual: state.alpha }
    ])
    // Alpha is the shadow atlas's optical-depth tail: a non-zero clear alpha
    // is injected tail that the reference resolve never clips
    expect(clears.map(c => c.layer)).toEqual([0, 1, 2, 0])
    expect(clears.every(c => c.alpha === 0 && c.color === 0)).toBe(true)
    expect(state.alpha).toBe(1)
    expect(state.color.getHex()).toBe(0x123456)
    expect(state.target).toBe(previous)
  })
})
