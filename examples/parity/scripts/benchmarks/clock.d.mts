export declare const CLOCK_PROTOCOL: string
export declare const RAMP_LIMIT: number
export declare const PROBE_DRIFT_LIMIT: number
export declare function installClockProbe(): void
export declare function median(values: number[]): number
export declare function toProbeUnits(
  frameMs: number[],
  probeMs: number[] | null | undefined
): number[] | null
export declare function thirdsRatio(values: number[]): number | null
export interface ClockStability {
  protocol: string
  frameRamp: number | null
  probeDrift: number | null
  normalised: boolean
  probeMedianMs: number | null
  unitsMedian: number | null
  stable: boolean
  reasons: string[]
}
export declare function clockStability(
  frameMs: number[],
  probeMs: number[] | null | undefined,
  limits?: { rampLimit?: number; probeDriftLimit?: number }
): ClockStability
