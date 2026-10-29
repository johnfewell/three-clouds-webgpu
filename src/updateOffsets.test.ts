// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Cite: CloudsEffect.ts:345–357 (accumulation in original)
// ADR-003: time and frame are plain settable numbers, and wind is a function of time, not an accumulator

import { Vector2, Vector3 } from 'three'

import { CloudsContext } from './CloudsContext'
import {
  createParameterUniforms,
  disposePlaceholders,
  updateParameterUniforms
} from './parameterUniforms'

describe('updateOffsets', () => {
  test('derived offsets = base + velocity × time', () => {
    const ctx = new CloudsContext()
    ctx.localWeatherOffset.set(10, 20)
    ctx.localWeatherVelocity.set(1, 2)
    ctx.shapeOffset.set(0.1, 0.2, 0.3)
    ctx.shapeVelocity.set(0.01, 0.02, 0.03)
    ctx.shapeDetailOffset.set(1, 2, 3)
    ctx.shapeDetailVelocity.set(0.1, 0.2, 0.3)
    ctx.time = 5

    ctx.updateOffsets()

    expect(ctx.derivedLocalWeatherOffset.x).toBeCloseTo(15, 10)
    expect(ctx.derivedLocalWeatherOffset.y).toBeCloseTo(30, 10)
    expect(ctx.derivedShapeOffset.x).toBeCloseTo(0.15, 10)
    expect(ctx.derivedShapeOffset.y).toBeCloseTo(0.3, 10)
    expect(ctx.derivedShapeOffset.z).toBeCloseTo(0.45, 10)
    expect(ctx.derivedShapeDetailOffset.x).toBeCloseTo(1.5, 10)
    expect(ctx.derivedShapeDetailOffset.y).toBeCloseTo(3, 10)
    expect(ctx.derivedShapeDetailOffset.z).toBeCloseTo(4.5, 10)
  })

  test('zero velocity preserves base offset', () => {
    const ctx = new CloudsContext()
    ctx.localWeatherOffset.set(5, 10)
    ctx.time = 100

    ctx.updateOffsets()

    expect(ctx.derivedLocalWeatherOffset).toEqual(new Vector2(5, 10))
    expect(ctx.derivedShapeOffset).toEqual(new Vector3(0, 0, 0))
    expect(ctx.derivedShapeDetailOffset).toEqual(new Vector3(0, 0, 0))
  })

  test('time=0 gives base offset regardless of velocity', () => {
    const ctx = new CloudsContext()
    ctx.localWeatherOffset.set(1, 2)
    ctx.localWeatherVelocity.set(100, 200)
    ctx.time = 0

    ctx.updateOffsets()

    expect(ctx.derivedLocalWeatherOffset).toEqual(new Vector2(1, 2))
  })

  test('seek-safe: time=5 after time=0 === time=5 directly', () => {
    const ctxA = new CloudsContext()
    ctxA.localWeatherOffset.set(10, 20)
    ctxA.localWeatherVelocity.set(1, 2)
    ctxA.shapeOffset.set(0.1, 0.2, 0.3)
    ctxA.shapeVelocity.set(0.01, 0.02, 0.03)
    ctxA.shapeDetailOffset.set(1, 2, 3)
    ctxA.shapeDetailVelocity.set(0.1, 0.2, 0.3)

    ctxA.time = 0
    ctxA.updateOffsets()
    ctxA.time = 3
    ctxA.updateOffsets()
    ctxA.time = 5
    ctxA.updateOffsets()
    const afterSequence = {
      lw: ctxA.derivedLocalWeatherOffset.clone(),
      shape: ctxA.derivedShapeOffset.clone(),
      detail: ctxA.derivedShapeDetailOffset.clone()
    }

    const ctxB = new CloudsContext()
    ctxB.localWeatherOffset.set(10, 20)
    ctxB.localWeatherVelocity.set(1, 2)
    ctxB.shapeOffset.set(0.1, 0.2, 0.3)
    ctxB.shapeVelocity.set(0.01, 0.02, 0.03)
    ctxB.shapeDetailOffset.set(1, 2, 3)
    ctxB.shapeDetailVelocity.set(0.1, 0.2, 0.3)

    ctxB.time = 5
    ctxB.updateOffsets()
    const direct = {
      lw: ctxB.derivedLocalWeatherOffset.clone(),
      shape: ctxB.derivedShapeOffset.clone(),
      detail: ctxB.derivedShapeDetailOffset.clone()
    }

    expect(afterSequence.lw).toEqual(direct.lw)
    expect(afterSequence.shape).toEqual(direct.shape)
    expect(afterSequence.detail).toEqual(direct.detail)
  })

  test('updateOffsets does not mutate base offset fields', () => {
    const ctx = new CloudsContext()
    ctx.localWeatherOffset.set(10, 20)
    ctx.localWeatherVelocity.set(1, 2)
    ctx.shapeOffset.set(0.1, 0.2, 0.3)
    ctx.shapeVelocity.set(0.01, 0.02, 0.03)
    ctx.time = 5

    ctx.updateOffsets()

    expect(ctx.localWeatherOffset).toEqual(new Vector2(10, 20))
    expect(ctx.shapeOffset).toEqual(new Vector3(0.1, 0.2, 0.3))
    expect(ctx.shapeDetailOffset).toEqual(new Vector3(0, 0, 0))
  })

  test('updateParameterUniforms calls updateOffsets', () => {
    const ctx = new CloudsContext()
    ctx.stbnTexture = null
    ctx.localWeatherVelocity.set(1, 2)
    ctx.shapeVelocity.set(0.01, 0.02, 0.03)
    ctx.time = 5

    const u = createParameterUniforms(ctx)
    updateParameterUniforms(u, ctx)

    expect(u.localWeatherOffset.value).toEqual(new Vector2(5, 10))
    expect(u.shapeOffset.value).toEqual(new Vector3(0.05, 0.1, 0.15))

    disposePlaceholders(u.placeholders)
  })

  test('negative time works (backwards seek)', () => {
    const ctx = new CloudsContext()
    ctx.localWeatherOffset.set(10, 20)
    ctx.localWeatherVelocity.set(1, 2)
    ctx.time = -3

    ctx.updateOffsets()

    expect(ctx.derivedLocalWeatherOffset).toEqual(new Vector2(7, 14))
  })
})
