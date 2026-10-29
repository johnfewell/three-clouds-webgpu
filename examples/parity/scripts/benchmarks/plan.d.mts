export declare const SCHEMA_VERSION: 1
export declare const PROTOCOL_VERSION: 'clouds-bench-v1'
export declare const EXPERIMENT_KEYS: readonly string[]

export interface BenchmarkScene {
  caseName: string
  workloadId: string
  width: number
  height: number
  dpr: number
  motion: 'static' | 'shape'
  settings: Record<string, unknown>
}

export interface BenchmarkVariant {
  id: string
  experimental: Record<string, boolean>
}

export interface BenchmarkPlan {
  id: string
  profile: 'smoke' | 'standard' | 'full'
  schemaVersion: 1
  protocolVersion: 'clouds-bench-v1'
  seed: number
  warmupFrames: number
  sampleFrames: number
  repeats: number
  cases: readonly BenchmarkScene[]
  variants: readonly BenchmarkVariant[]
  backends: readonly ('webgl' | 'webgpu')[]
  resolutions: readonly (readonly [number, number])[]
}

export interface BenchmarkJob {
  scene: BenchmarkScene
  variant: BenchmarkVariant
  backend: 'webgl' | 'webgpu'
  repetition: number
  orderIndex: number
}

export declare const DEFAULT_VARIANTS: readonly BenchmarkVariant[]
export declare const FULL_VARIANTS: readonly BenchmarkVariant[]
export declare const PROFILES: Readonly<
  Record<
    BenchmarkPlan['profile'],
    { sampleFrames: number; repeats: number; warmupFrames: number }
  >
>
export declare const DEFAULT_PLAN: BenchmarkPlan
export declare function validatePlan(plan: BenchmarkPlan): BenchmarkPlan
export declare function makePlan(
  overrides?: Partial<BenchmarkPlan>
): BenchmarkPlan
export declare function scheduleFor(plan: BenchmarkPlan): BenchmarkJob[]
export declare function planFingerprint(plan: BenchmarkPlan): string
