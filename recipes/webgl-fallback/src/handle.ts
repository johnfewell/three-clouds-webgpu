import type { Backend, PartialSettings } from './settings'

/** The app's view of a branch, the same for both */
export interface CloudsHandle {
  readonly backend: Backend
  /** Write settings onto the branch's clouds object */
  update: (settings: PartialSettings) => void
  setEnabled: (enabled: boolean) => void
  seek: (seconds: number) => void
  setPaused: (paused: boolean) => void
  resize: () => void
  dispose: () => void
}

/** The clock both branches advance, owned by the app (ADR-003) */
export interface Clock {
  timeSeconds: number
  frame: number
  paused: boolean
}

export interface BranchOptions {
  canvas: HTMLCanvasElement
  signal: AbortSignal
  clock: Clock
  report: (state: string, message: string) => void
}

export const EARTH_RADIUS_METRES = 6378137
export const ANIMATION_SPEED = 1
