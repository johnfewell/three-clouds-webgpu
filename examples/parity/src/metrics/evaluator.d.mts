export const METRICS_VERSION: number

export interface Metrics {
  ssim: number
  deMean: number
  deP95: number
  histDist: number
}

export interface PhaseThresholds {
  ssim?: number | null
  deP95?: number | null
  histDist?: number | null
}

/**
 * The measured footprint of a documented difference. ssim is a minimum (below
 * it the case fails), deP95 and histDist are maximums (above them it fails)
 */
export interface AcceptedFloor {
  ssim?: number
  deP95?: number
  histDist?: number
}

export interface AcceptedDifference {
  pattern: string
  reason: string
  floor?: AcceptedFloor
}

export interface Thresholds {
  phases: Record<number, PhaseThresholds>
  accepted?: AcceptedDifference[]
  plate?: {
    minStd: number
    minCloudFraction?: number
    reason?: string
  }
}

export type EvalResult = 'pass' | 'expected-difference' | 'fail'

export interface PlateStats {
  mean: number
  std: number
  cloudFraction?: number
}

export interface PlateCheck {
  minStd: number
  minCloudFraction?: number
  plate: { A: PlateStats; B: PlateStats } | null | undefined
}

export interface EvalDetail {
  result: EvalResult
  reasons: string[]
}

export function checkMetricsVersion(version: unknown): string[]
export function checkPlate(check: PlateCheck | undefined): string[]
export function evaluate(
  metrics: Metrics,
  thresholds: PhaseThresholds,
  caseName?: string,
  accepted?: AcceptedDifference[],
  plateCheck?: PlateCheck
): EvalDetail
