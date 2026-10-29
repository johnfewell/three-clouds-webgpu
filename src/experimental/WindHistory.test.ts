import { Fn, vec3 } from 'three/tsl'
import { describe, expect, it } from 'vitest'

import { compileWGSL } from '../../test/helpers/compileWGSL'
import { log } from '../../test/helpers/log'
import { CloudsContext } from '../CloudsContext'
import { previousCloudPosition, WindHistory } from './WindHistory'

function fixture() {
  const ctx = new CloudsContext()
  ctx.shapeDetail = false
  ctx.shapeRepeat.setScalar(0.001)
  ctx.updateOffsets()
  const history = new WindHistory()
  history.update(ctx)
  return { ctx, history }
}

describe('wind-aware history', () => {
  it('matches texture coordinates at the previous position and preserves static history', () => {
    const { ctx, history } = fixture()
    history.update(ctx)
    expect(history.cloudValid.value).toBe(true)
    expect(history.displacement.value.length()).toBe(0)
    ctx.shapeVelocity.set(0.01, -0.02, 0)
    ctx.time = 0.1
    ctx.updateOffsets()
    history.update(ctx)
    expect(history.displacement.value.toArray()).toEqual([1, -2, 0])
    expect(history.cloudValid.value).toBe(true)
    expect(history.shadowValid.value).toBe(false)
    const previousSampleX =
      (100 + history.displacement.value.x) * ctx.shapeRepeat.x
    const currentSampleX = 100 * ctx.shapeRepeat.x + ctx.derivedShapeOffset.x
    expect(previousSampleX).toBeCloseTo(currentSampleX, 12)
    log('wind coordinates', { previousSampleX, currentSampleX })
  })
  it('keeps the history through animated weather, which it cannot reproject', () => {
    // The reason is in docs/EXPERIMENTAL.md: the displacement
    // never compensates a weather step, so the fetch is the reference's own and
    // the history is worth keeping. Fails on any weather term in the domain test
    const { ctx, history } = fixture()
    const velocity = 0.01
    ctx.localWeatherVelocity.x = velocity
    ctx.time = 0.1
    ctx.updateOffsets()
    history.update(ctx)
    const firstValid = history.cloudValid.value
    ctx.time = 0.2
    ctx.updateOffsets()
    history.update(ctx)
    const secondValid = history.cloudValid.value
    // An uncompensated translation, so the displacement stays zero rather than
    // claiming a compensation that was never applied
    const displacement = history.displacement.value.toArray()
    log('wind through weather evolution', {
      weatherStepPerSecond: velocity,
      firstValid,
      secondValid,
      displacement,
      weatherOffsetAdvanced: ctx.derivedLocalWeatherOffset.x
    })
    expect([firstValid, secondValid]).toEqual([true, true])
    expect(displacement).toEqual([0, 0, 0])
    // Shadow history is valid precisely because nothing moved
    expect(history.shadowValid.value).toBe(true)
  })
  it('rejects a domain change, incompatible detail, time jumps, and resets', () => {
    const { ctx, history } = fixture()
    ctx.localWeatherRepeat.x = 200
    ctx.time = 0.1
    ctx.updateOffsets()
    history.update(ctx)
    expect(history.cloudValid.value).toBe(false)
    ctx.localWeatherRepeat.x = 100
    ctx.shapeDetail = true
    history.update(ctx)
    ctx.time = 0.2
    ctx.shapeVelocity.x = 0.1
    ctx.updateOffsets()
    history.update(ctx)
    expect(ctx.derivedShapeOffset.x).toBeGreaterThan(0)
    expect(history.cloudValid.value).toBe(false)
    ctx.time = 10
    history.update(ctx)
    expect(history.cloudValid.value).toBe(false)
    history.reset()
    history.update(ctx)
    expect(history.cloudValid.value).toBe(false)
    log('wind rejection', { valid: history.cloudValid.value })
  })
  it('compiles the positive displacement convention', () => {
    const shader = compileWGSL(
      Fn(() => previousCloudPosition(vec3(100), vec3(1, -2, 0)))()
    ).fragment
    expect(shader).toContain(' + ')
  })
})
