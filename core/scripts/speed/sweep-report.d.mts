// Types for sweep-report.mjs, a plain .mjs reducer so node runs it directly

export interface PassRow {
  label: string
  exclusive: number
}

export interface TimedRun {
  case: string
  arm: string
  applied?: { graphVersion?: number }
  timed?: {
    passList: PassRow[][]
    probeMs: number[]
    gpuMs: number[]
  }
  vsync?: {
    refreshMs: number
    displayHz: number
    frames: number
    intervals: number
    fps: number
    dropped: number
    droppedShare: number
    longestMs: number
  }
  clock?: { unitsMedian: number; stable: boolean }
  failed?: string
  errors?: string[]
}

export interface ArmRow {
  arm: string
  n: number
  frame: number
  range: [number, number]
  saved: number
  savedShare: number
  passDelta: Record<string, number>
  unstable: number
  graphVersions: number
}

export interface VsyncRow {
  arm: string
  n: number
  fps: number
  displayHz: number
  dropped: number
  droppedShare: number
  longestMs: number
}

export interface Reduced<T> {
  result: Record<string, T[]>
  bad: number
}

export function perRun(run: TimedRun): {
  frame: number
  passes: Record<string, number>
}
export function reduce(report: { runs: TimedRun[] }): Reduced<ArmRow>
export function markdown(reduced: Reduced<ArmRow>): string
export function reduceVsync(report: { runs: TimedRun[] }): Reduced<VsyncRow>
export function markdownVsync(reduced: Reduced<VsyncRow>): string
