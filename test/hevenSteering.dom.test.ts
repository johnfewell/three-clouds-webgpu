// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  bindSteeringInput,
  createSteering,
  flightDelta,
  stepSteering
} from '../examples/demo/src/film/steering'

const coast = { turn: 0, throttle: 0 }
const rightAndForward = { turn: 1, throttle: 1 }

function simulate(seconds: number, fps: number, input = rightAndForward) {
  const state = createSteering()
  for (let i = 0; i < seconds * fps; ++i) stepSteering(state, input, 1 / fps)
  return state
}

describe('heven gentle flight', () => {
  it('leaves the passive meander exactly alone without input', () => {
    expect(simulate(600, 60, coast)).toEqual(createSteering())
  })

  it('starts softly and builds speed and turning over a sustained hold', () => {
    const first = simulate(1, 60)
    const held = simulate(8, 60)
    expect(first.heading).toBeGreaterThan(0)
    expect(first.heading).toBeLessThan(1)
    expect(first.speed).toBeGreaterThan(1)
    expect(first.speed).toBeLessThan(1.025)
    expect(held.heading).toBeGreaterThan(12)
    expect(held.heading).toBeLessThan(17)
    expect(held.speed).toBeGreaterThan(1.24)
    expect(held.speed).toBeLessThan(1.3)
    expect(simulate(90, 60).heading).toBeCloseTo(22, 7)
    expect(simulate(90, 60).speed).toBeCloseTo(1.3, 10)
  })

  it('coasts through release without a snap and returns to the sun-facing baseline', () => {
    const state = simulate(8, 60)
    const released = { ...state }
    stepSteering(state, coast, 1 / 60)
    expect(Math.abs(state.heading - released.heading)).toBeLessThan(0.04)
    expect(Math.abs(state.speed - released.speed)).toBeLessThan(0.001)
    expect(state.turnRate).toBeGreaterThan(0)
    for (let i = 0; i < 45 * 60; ++i) stepSteering(state, coast, 1 / 60)
    expect(Math.abs(state.heading)).toBeLessThan(0.02)
    expect(Math.abs(state.turnRate)).toBeLessThan(0.005)
    expect(state.speed).toBeCloseTo(1, 4)
  })

  it('keeps the same response at 30, 60 and 144 frames per second', () => {
    const reference = simulate(8, 60)
    for (const fps of [30, 144]) {
      const state = simulate(8, fps)
      expect(state.heading).toBeCloseTo(reference.heading, 10)
      expect(state.speed).toBeCloseTo(reference.speed, 10)
      expect(state.turnRate).toBeCloseTo(reference.turnRate, 10)
    }
  })

  it('stays limited through reversals and never turns S into reverse flight', () => {
    const state = createSteering()
    for (const input of [
      rightAndForward,
      coast,
      { turn: -1, throttle: -1 },
      rightAndForward,
      coast
    ]) {
      for (let i = 0; i < 30 * 60; ++i) {
        stepSteering(state, input, 1 / 60)
        expect(Math.abs(state.heading)).toBeLessThanOrEqual(22)
        expect(Math.abs(state.turnRate)).toBeLessThan(2.6)
        expect(state.speed).toBeGreaterThanOrEqual(0.8)
        expect(state.speed).toBeLessThanOrEqual(1.3)
      }
    }
  })

  it('does not catch up a suspended tab in a single frame', () => {
    const suspended = createSteering()
    const normal = createSteering()
    stepSteering(suspended, rightAndForward, 120)
    stepSteering(normal, rightAndForward, 0.1)
    expect(suspended).toEqual(normal)
    expect(flightDelta(-1)).toBe(0)
    expect(flightDelta(NaN)).toBe(0)
    expect(flightDelta(Infinity)).toBe(0)
  })
})

describe('heven keyboard handoff', () => {
  const key = (
    type: string,
    code: string,
    target: EventTarget = window,
    extra = {}
  ) => {
    const event = new KeyboardEvent(type, {
      code,
      bubbles: true,
      cancelable: true,
      ...extra
    })
    target.dispatchEvent(event)
    return event
  }

  it('combines WASD and arrows without repeated keys doubling the influence', () => {
    const input = { ...coast }
    const dispose = bindSteeringInput(input)
    try {
      expect(key('keydown', 'KeyW').defaultPrevented).toBe(true)
      key('keydown', 'KeyW', window, { repeat: true })
      key('keydown', 'ArrowUp')
      key('keydown', 'KeyD')
      expect(input).toEqual(rightAndForward)
      key('keydown', 'KeyA')
      key('keydown', 'KeyS')
      expect(input).toEqual(coast)
      key('keyup', 'KeyW')
      key('keyup', 'ArrowUp')
      expect(input.throttle).toBe(-1)
    } finally {
      dispose()
    }
  })

  it('clears held keys on blur, tab visibility changes and disposal', () => {
    const input = { ...coast }
    const dispose = bindSteeringInput(input)
    key('keydown', 'KeyD')
    window.dispatchEvent(new Event('blur'))
    expect(input).toEqual(coast)
    key('keydown', 'KeyW')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(input).toEqual(coast)
    key('keydown', 'KeyW')
    dispose()
    expect(input).toEqual(coast)
    key('keydown', 'KeyD')
    expect(input).toEqual(coast)
  })

  it('leaves typing and browser shortcuts alone and clears keys on field focus', () => {
    const input = { ...coast }
    const dispose = bindSteeringInput(input)
    const field = document.createElement('input')
    document.body.append(field)
    try {
      expect(key('keydown', 'KeyW', field).defaultPrevented).toBe(false)
      for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
        expect(
          key('keydown', 'KeyW', window, { [modifier]: true }).defaultPrevented
        ).toBe(false)
      }
      expect(input).toEqual(coast)
      key('keydown', 'KeyW')
      field.focus()
      expect(input).toEqual(coast)
    } finally {
      dispose()
      field.remove()
    }
  })
})
