import type { BenchmarkPlan } from './plan.mjs'

export declare function hashSources(
  root: string
): Promise<{ sourceHash: string; sourceFiles: string[] }>
export declare function verifyServedArtifact(
  baseURL: string,
  environment: { servedLibraryUrls: string[] },
  expectedSha256: string,
  servedRoot: string
): Promise<{
  url: string
  resolvedPath: string
  sha256: string
  diskSha256: string
  transformed: boolean
}>

export interface BuildMetadata {
  id: 'old' | 'new'
  root: string
  servedRoot: string
  commit: string
  sourceHash: string
  sourceFiles: string[]
  supportsExperiments: boolean
  lockfileHash: string
  artifactDigest: string
  buildDigest: string
  sharedSha256: string
  planFingerprint: string
}

export declare function runBenchmark(options: {
  plan: BenchmarkPlan
  roots: { old: string; new: string }
  machineLabel?: string
  checkpointPath?: string | null
  browserOptions?: { headless?: boolean; flags?: readonly string[] }
  idleConfirmed?: boolean
  prepare?: boolean
}): Promise<BenchmarkReport>

export declare function expectedRunCounts(plan: BenchmarkPlan): {
  jobCount: number
  totalRuns: number
  expectedUnsupported: number
  expectedSupported: number
}

export interface BenchmarkReport {
  schemaVersion: 1
  protocolVersion: 'clouds-bench-v1'
  suiteHash: string
  createdAt: string
  idleConfirmed: boolean
  publishable: boolean
  machine: Record<string, unknown>
  plan: BenchmarkPlan
  builds: { old: BuildMetadata; new: BuildMetadata }
  runs: BenchmarkRun[]
}

export interface BenchmarkRun {
  caseName: string
  width: number
  height: number
  dpr: number
  motion: 'static' | 'shape'
  workloadId: string
  variantId: string
  backend: 'webgl' | 'webgpu'
  buildId: 'old' | 'new'
  repetition: number
  orderIndex: number
  buildOrderIndex: number
  status: 'ok' | 'unsupported' | 'failed'
  reason?: string
  settings: Record<string, unknown>
  samples: {
    gpuMs: number[]
    wallMs: number[]
    renderMs?: number[]
    computeMs?: number[]
    gpuRenderMs?: number[]
  }
  gpuUnavailableReason?: string | null
  environment?: Record<string, unknown>
}
