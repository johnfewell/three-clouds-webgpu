// Types for sweepArgs.mjs. The module is plain .mjs so node runs sweep.mjs
// with no transpile. This declares it for the TypeScript test

export interface SweepArm {
  id: string
  preset?: string
  set?: readonly (readonly [string, unknown])[]
}

export interface SweepSize {
  w: number
  h: number
  dpr: number
}

export interface TimingInput {
  vsync?: boolean
  warmup?: string
  samples?: string
  seconds?: string
}

export type TimingMode =
  | { mode: 'timed'; warmup: number; samples: number }
  | { mode: 'vsync'; warmup: number; seconds: number }

export const ARMS: readonly SweepArm[]
export const DEFAULT_CASES: string
export const DEFAULT_SIZE: string
export const PROBE_FAST_MS: number

export function validateExtra(extra: unknown): SweepArm[]
export function resolveArms(
  ids: readonly string[],
  extra?: readonly SweepArm[]
): SweepArm[]
export function parseSize(text: string): SweepSize
export function checkRunInputs(inputs: {
  cases: readonly unknown[]
  arms: readonly unknown[]
  reps: number
}): { cases: number; arms: number; reps: number }
export function timingMode(values: TimingInput): TimingMode
export function armOrder(
  arms: readonly SweepArm[],
  rep: number,
  caseIndex: number
): SweepArm[]
export function median(values: readonly number[]): number
