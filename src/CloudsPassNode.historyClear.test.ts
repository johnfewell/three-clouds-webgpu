// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

import { Color, type ColorRepresentation } from 'three'
import { RenderTarget } from 'three/webgpu'
import { describe, expect, test } from 'vitest'

import { log, setCurrentSpec } from '../test/helpers/log'
import { clearHistoryPair } from './pass/targets'

function clearFixture(failAt = -1) {
  const original = new RenderTarget(4, 4)
  const color = new Color(0.2, 0.4, 0.6)
  let alpha = 1
  let target: RenderTarget | null = original
  let face = 2
  let mip = 1
  const clears: {
    target: RenderTarget | null
    face: number
    mip: number
    rgba: number[]
    buffers: boolean[]
  }[] = []
  const renderer = {
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    getClearColor: (result: Color) => result.copy(color),
    getClearAlpha: () => alpha,
    setClearColor: (value: ColorRepresentation, opacity = 1) => {
      color.set(value)
      alpha = opacity
    },
    setRenderTarget: (value: RenderTarget | null, layer = 0, level = 0) => {
      target = value
      face = layer
      mip = level
    },
    clear: (...buffers: boolean[]) => {
      clears.push({
        target,
        face,
        mip,
        rgba: [...color.toArray(), alpha],
        buffers
      })
      if (clears.length === failAt) throw new Error('clear failed')
    }
  }
  // The renderer is duck-typed on purpose, to record what the clear touched
  const clearPair = (
    a: RenderTarget | null,
    b: RenderTarget | null,
    layers?: number
  ): void =>
    clearHistoryPair(
      renderer as unknown as Parameters<typeof clearHistoryPair>[0],
      a,
      b,
      layers
    )
  return { renderer, clearPair, original, clears }
}

function expectRestored(fixture: ReturnType<typeof clearFixture>) {
  const { renderer, original } = fixture
  expect(renderer.getRenderTarget()).toBe(original)
  expect(renderer.getActiveCubeFace()).toBe(2)
  expect(renderer.getActiveMipmapLevel()).toBe(1)
  expect(renderer.getClearColor(new Color()).toArray()).toEqual([0.2, 0.4, 0.6])
  expect(renderer.getClearAlpha()).toBe(1)
}

describe('transparent history clear', () => {
  test.each([1, 3])('zeroes both targets at every one of %i layers', layers => {
    setCurrentSpec('CloudsPassNode.historyClear')
    const fixture = clearFixture()
    const a = new RenderTarget(4, 4)
    const b = new RenderTarget(4, 4)
    fixture.clearPair(a, b, layers)
    expect(fixture.clears).toHaveLength(2 * layers)
    for (const [index, clear] of fixture.clears.entries()) {
      expect(clear.target).toBe(index < layers ? a : b)
      expect(clear.face).toBe(index % layers)
      expect(clear.mip).toBe(0)
      expect(clear.rgba).toEqual([0, 0, 0, 0])
      expect(clear.buffers).toEqual([true, true, true])
    }
    expectRestored(fixture)
    log('zero-history-pair', {
      layers,
      clears: fixture.clears.length,
      restored: true
    })
  })

  test.each([false, true])('skips null targets (both null: %s)', bothNull => {
    const fixture = clearFixture()
    fixture.clearPair(null, bothNull ? null : new RenderTarget(4, 4))
    expect(fixture.clears).toHaveLength(bothNull ? 0 : 1)
    expectRestored(fixture)
  })

  test('restores clear state and target subresource after a failed clear', () => {
    const fixture = clearFixture(2)
    expect(() =>
      fixture.clearPair(new RenderTarget(4, 4), new RenderTarget(4, 4), 3)
    ).toThrow('clear failed')
    expect(fixture.clears).toHaveLength(2)
    expectRestored(fixture)
    log('zero-history-failed-clear', { clears: 2, restored: true })
  })
})
