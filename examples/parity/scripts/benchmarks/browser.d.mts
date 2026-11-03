import type { ProfileOptions, ProfilePass } from './profile.mjs'

export interface BenchmarkMetric {
  values: number[]
  count: number
  median: number
  p95: number
  mean: number
  min: number
  max: number
}

export declare class BenchmarkUnsupportedError extends Error {
  constructor(message: string)
}
export declare const DEFAULT_FLAGS: readonly string[]
export declare function launchBenchmarkBrowser(options?: {
  headless?: boolean
  flags?: readonly string[]
  channel?: string
}): Promise<unknown>
export declare function summarise(values: number[]): BenchmarkMetric
export declare function benchmarkUrl(
  baseURL: string,
  scene: { caseName: string; width: number; height: number }
): string
export declare function runBrowserJob(
  browser: unknown,
  options: {
    baseURL?: string
    scene: {
      caseName: string
      width: number
      height: number
      dpr?: number
      settings?: Record<string, number | boolean>
      motion?: 'static' | 'shape'
    }
    variant: { id: string; experimental: Record<string, boolean> }
    backend: 'webgl' | 'webgpu'
    warmupFrames: number
    sampleFrames: number
    dpr?: number
    timeout?: number
    screenshotPath?: string
    profile?: ProfileOptions
  }
): Promise<{
  profile?: {
    effectiveScatteringSamples: [number, number]
    integration: { cloudsRaymarch: boolean; sceneRaymarch: boolean }
    frames: ProfilePass[][]
  }
  screening?: Record<string, unknown>
  environment: {
    errors: string[]
    warnings: string[]
    frame: number
    time: number
    startFrame: number
    browser: string
    gpu: Record<string, unknown> | null
    effectiveSettings: Record<string, unknown>
    actualDimensions: { width: number; height: number }
    pixelStats: {
      count: number
      mean: number
      variance: number
      max: number
      cloudPixels?: number
    }
    servedLibraryUrls: string[]
  }
  samples: {
    wallMs: BenchmarkMetric
    renderMs: BenchmarkMetric
    gpuMs: BenchmarkMetric | null
    computeMs: BenchmarkMetric | null
    gpuRenderMs: BenchmarkMetric | null
  }
  gpuReason: string | null
}>
