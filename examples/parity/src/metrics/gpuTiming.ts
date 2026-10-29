// GPU timing utilities for the parity harness
// Side A: EXT_disjoint_timer_query_webgl2 (WebGL2)
// Side B: timestamp-query via three.js WebGPURenderer.resolveTimestampsAsync
//
// On software renderers (SwiftShader) or missing extensions, report null
// with a reason string, never fake numbers

const DEFAULT_SAMPLE_COUNT = 32

// ────── Types ──────

export interface GpuPassTiming {
  name: string
  ms: number
}

export interface GpuFrameSample {
  totalMs: number
  passes: GpuPassTiming[]
}

export interface GpuTimingReport {
  medianMs: number
  passes: Record<string, number>
  sampleCount: number
}

export type SideTimingResult =
  | { available: true; report: GpuTimingReport }
  | { available: false; reason: string }

export interface GpuTimingSummary {
  sideA: SideTimingResult
  sideB: SideTimingResult
}

// ────── Math ──────

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]!
}

export function computeTimingReport(
  samples: GpuFrameSample[]
): GpuTimingReport {
  if (samples.length === 0) {
    return { medianMs: 0, passes: {}, sampleCount: 0 }
  }

  const totalValues = samples.map(s => s.totalMs)

  const passNames = new Set<string>()
  for (const s of samples) {
    for (const p of s.passes) passNames.add(p.name)
  }

  const passes: Record<string, number> = {}
  for (const name of passNames) {
    const values = samples
      .map(s => s.passes.find(p => p.name === name)?.ms)
      .filter((v): v is number => v != null)
    passes[name] = computeMedian(values)
  }

  return {
    medianMs: computeMedian(totalValues),
    passes,
    sampleCount: samples.length
  }
}

// ────── Sample collector ──────

export class GpuTimingCollector {
  private readonly samples: GpuFrameSample[] = []
  private readonly targetCount: number

  constructor(targetCount = DEFAULT_SAMPLE_COUNT) {
    this.targetCount = targetCount
  }

  add(sample: GpuFrameSample): void {
    this.samples.push(sample)
    if (this.samples.length > this.targetCount) {
      this.samples.shift()
    }
  }

  get ready(): boolean {
    return this.samples.length >= this.targetCount
  }

  get count(): number {
    return this.samples.length
  }

  report(): GpuTimingReport | null {
    if (this.samples.length === 0) return null
    return computeTimingReport(this.samples)
  }

  reset(): void {
    this.samples.length = 0
  }
}

// ────── WebGL GPU Timer (Side A) ──────

interface DisjointTimerQueryExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

interface PendingBatch {
  queries: Array<{ name: string; query: WebGLQuery }>
}

export class WebGLGpuTimer {
  readonly available: boolean
  readonly reason: string | null

  private readonly gl: WebGL2RenderingContext | null
  private readonly ext: DisjointTimerQueryExt | null
  private currentBatch: Array<{ name: string; query: WebGLQuery }> = []
  private pendingBatches: PendingBatch[] = []

  constructor(gl: WebGL2RenderingContext | null) {
    if (gl == null) {
      this.available = false
      this.reason = 'No WebGL2 context'
      this.gl = null
      this.ext = null
      return
    }

    this.gl = gl
    const ext = gl.getExtension(
      'EXT_disjoint_timer_query_webgl2'
    ) as DisjointTimerQueryExt | null
    this.ext = ext

    if (ext == null) {
      this.available = false
      this.reason = 'EXT_disjoint_timer_query_webgl2 not available'
    } else {
      this.available = true
      this.reason = null
    }
  }

  beginPass(name: string): void {
    if (!this.available || this.gl == null || this.ext == null) return
    const query = this.gl.createQuery()
    if (query == null) return
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query)
    this.currentBatch.push({ name, query })
  }

  endPass(): void {
    if (!this.available || this.gl == null || this.ext == null) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
  }

  endFrame(): void {
    if (!this.available || this.currentBatch.length === 0) return
    this.pendingBatches.push({ queries: [...this.currentBatch] })
    this.currentBatch = []
  }

  collectPending(): GpuFrameSample | null {
    if (
      !this.available ||
      this.gl == null ||
      this.ext == null ||
      this.pendingBatches.length === 0
    ) {
      return null
    }

    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    if (disjoint) {
      const batch = this.pendingBatches.shift()!
      for (const { query } of batch.queries) this.gl.deleteQuery(query)
      return null
    }

    const batch = this.pendingBatches[0]!
    for (const { query } of batch.queries) {
      const ready = this.gl.getQueryParameter(
        query,
        this.gl.QUERY_RESULT_AVAILABLE
      ) as boolean
      if (!ready) return null
    }

    this.pendingBatches.shift()
    const passes: GpuPassTiming[] = []
    let totalMs = 0
    for (const { name, query } of batch.queries) {
      const ns = this.gl.getQueryParameter(
        query,
        this.gl.QUERY_RESULT
      ) as number
      const ms = ns / 1e6
      passes.push({ name, ms })
      totalMs += ms
      this.gl.deleteQuery(query)
    }

    return { totalMs, passes }
  }

  dispose(): void {
    if (this.gl == null) return
    for (const { query } of this.currentBatch) {
      this.gl.deleteQuery(query)
    }
    this.currentBatch = []
    for (const batch of this.pendingBatches) {
      for (const { query } of batch.queries) {
        this.gl.deleteQuery(query)
      }
    }
    this.pendingBatches = []
  }
}

// ────── WebGPU GPU Timer (Side B) ──────

interface WebGPURendererLike {
  resolveTimestampsAsync(type?: string): Promise<number | undefined>
  hasFeature(name: string): boolean
  backend?: { trackTimestamp: boolean }
}

export class WebGPUGpuTimer {
  readonly available: boolean
  readonly reason: string | null
  private readonly renderer: WebGPURendererLike | null

  constructor(renderer: WebGPURendererLike | null) {
    if (renderer == null) {
      this.available = false
      this.reason = 'No WebGPU renderer'
      this.renderer = null
      return
    }

    this.renderer = renderer

    let hasTimestamp = false
    try {
      hasTimestamp = renderer.hasFeature('timestamp-query')
    } catch {
      // renderer not initialized
    }

    const trackTimestamp = renderer.backend?.trackTimestamp ?? false

    if (!hasTimestamp || !trackTimestamp) {
      this.available = false
      this.reason = !hasTimestamp
        ? 'timestamp-query feature not available (software renderer or unsupported GPU)'
        : 'trackTimestamp not enabled on WebGPURenderer'
    } else {
      this.available = true
      this.reason = null
    }
  }

  async resolve(): Promise<GpuFrameSample | null> {
    if (!this.available || this.renderer == null) return null

    const duration = await this.renderer.resolveTimestampsAsync('render')
    if (duration == null || duration === 0) return null

    // MILLISECONDS ALREADY: three divides the nanosecond timestamps by 1e6, so
    // dividing again printed 0.00 for side B. Unlike WebGL2's raw nanoseconds
    // above. Measured, not inferred: ~21.6 ms/frame on coverage-020.
    const ms = duration
    return {
      totalMs: ms,
      passes: [{ name: 'render', ms }]
    }
  }
}

// ────── Harness integration helpers ──────

export function unavailableResult(reason: string): SideTimingResult {
  return { available: false, reason }
}

export function buildTimingSummary(
  sideACollector: GpuTimingCollector | null,
  sideBCollector: GpuTimingCollector | null,
  sideAReason: string | null,
  sideBReason: string | null
): GpuTimingSummary {
  const sideA: SideTimingResult =
    sideAReason != null
      ? { available: false, reason: sideAReason }
      : sideACollector?.report() != null
        ? { available: true, report: sideACollector.report()! }
        : { available: false, reason: 'No samples collected' }

  const sideB: SideTimingResult =
    sideBReason != null
      ? { available: false, reason: sideBReason }
      : sideBCollector?.report() != null
        ? { available: true, report: sideBCollector.report()! }
        : { available: false, reason: 'No samples collected' }

  return { sideA, sideB }
}

export function formatGpuMs(result: SideTimingResult): string {
  if (!result.available) return 'n/a'
  return `${result.report.medianMs.toFixed(2)} ms`
}
