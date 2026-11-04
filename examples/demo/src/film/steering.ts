export interface SteeringState {
  heading: number
  turnRate: number
  speed: number
  acceleration: number
}

export interface SteeringInput {
  turn: number
  throttle: number
}

export const createSteering = (): SteeringState => ({
  heading: 0,
  turnRate: 0,
  speed: 1,
  acceleration: 0
})

export function flightDelta(delta: number): number {
  return Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.1)) : 0
}

const clampAxis = (value: number): number => Math.max(-1, Math.min(value, 1))
const clampTurnRate = (value: number): number =>
  Math.max(-2.5, Math.min(value, 2.5))

// Exact critically damped springs keep the feel independent of frame rate
export function stepSteering(
  state: SteeringState,
  input: SteeringInput,
  delta: number
): void {
  const dt = flightDelta(delta)
  const turn = clampAxis(input.turn)
  const throttle = clampAxis(input.throttle)
  const headingTarget = turn * 22
  const headingRate = turn === 0 ? 0.22 : 0.28
  const headingError = state.heading - headingTarget
  const headingDrag = state.turnRate + headingRate * headingError
  const headingDecay = Math.exp(-headingRate * dt)
  const nextHeading =
    headingTarget + (headingError + headingDrag * dt) * headingDecay
  if (dt > 0)
    state.heading += clampTurnRate((nextHeading - state.heading) / dt) * dt
  state.turnRate = clampTurnRate(
    (state.turnRate - headingRate * headingDrag * dt) * headingDecay
  )

  const speedTarget = 1 + throttle * (throttle > 0 ? 0.3 : 0.2)
  const speedRate = throttle === 0 ? 0.28 : 0.4
  const speedError = state.speed - speedTarget
  const speedDrag = state.acceleration + speedRate * speedError
  const speedDecay = Math.exp(-speedRate * dt)
  state.speed = speedTarget + (speedError + speedDrag * dt) * speedDecay
  state.acceleration =
    (state.acceleration - speedRate * speedDrag * dt) * speedDecay
}

const KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight'
])

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export function bindSteeringInput(input: SteeringInput): () => void {
  const held = new Set<string>()
  const read = () => {
    input.turn =
      Number(held.has('KeyD') || held.has('ArrowRight')) -
      Number(held.has('KeyA') || held.has('ArrowLeft'))
    input.throttle =
      Number(held.has('KeyW') || held.has('ArrowUp')) -
      Number(held.has('KeyS') || held.has('ArrowDown'))
  }
  const clear = () => {
    held.clear()
    read()
  }
  const down = (event: KeyboardEvent) => {
    if (
      !KEYS.has(event.code) ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isEditing(event.target)
    )
      return
    event.preventDefault()
    held.add(event.code)
    read()
  }
  const up = (event: KeyboardEvent) => {
    held.delete(event.code)
    read()
  }
  const focus = (event: FocusEvent) => {
    if (isEditing(event.target)) clear()
  }
  window.addEventListener('keydown', down)
  window.addEventListener('keyup', up)
  window.addEventListener('blur', clear)
  window.addEventListener('focusin', focus)
  document.addEventListener('visibilitychange', clear)
  return () => {
    clear()
    window.removeEventListener('keydown', down)
    window.removeEventListener('keyup', up)
    window.removeEventListener('blur', clear)
    window.removeEventListener('focusin', focus)
    document.removeEventListener('visibilitychange', clear)
  }
}
