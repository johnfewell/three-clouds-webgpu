import type { PixelImage, PixelMetrics } from './pixels.mjs'

export interface PhaseSample {
  image: PixelImage
  name: string
  before: number
  after: number
}
export interface PhaseIdentity {
  index: number
  name: string
  before: number
  after: number
}
export interface PhaseResult extends PhaseIdentity {
  visible: PixelMetrics
  adjacent: PixelMetrics | null
  referenceDifference: PixelMetrics | null
  referenceLimit: number | null
  anchor: PhaseIdentity | null
  recurrences: (PhaseIdentity & { difference: PixelMetrics; gap: number })[]
  historySize: number
  expired: boolean
  ready: boolean
}
export const RECURRENCE_LIMITS: Readonly<{
  history: 64
  minimumFrameGap: 64
  matches: 3
}>
export function createPhaseSampler(options?: {
  reference?: PixelImage
  referenceLimit?: number
}): { push(sample: PhaseSample): PhaseResult }
