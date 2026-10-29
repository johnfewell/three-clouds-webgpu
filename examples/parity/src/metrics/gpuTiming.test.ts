import { describe, expect, it, vi } from 'vitest'

import {
  buildTimingSummary,
  computeMedian,
  computeTimingReport,
  formatGpuMs,
  GpuTimingCollector,
  unavailableResult,
  WebGLGpuTimer,
  WebGPUGpuTimer,
  type GpuFrameSample,
  type SideTimingResult
} from './gpuTiming'

// ────── computeMedian ──────

describe('computeMedian', () => {
  it('returns 0 for empty array', () => {
    expect(computeMedian([])).toBe(0)
  })

  it('returns the single value for length 1', () => {
    expect(computeMedian([5])).toBe(5)
  })

  it('returns the middle value for odd-length arrays', () => {
    expect(computeMedian([1, 3, 5])).toBe(3)
    expect(computeMedian([10, 20, 30, 40, 50])).toBe(30)
  })

  it('returns the average of two middle values for even-length arrays', () => {
    expect(computeMedian([1, 3, 5, 7])).toBe(4)
    expect(computeMedian([10, 20])).toBe(15)
  })

  it('handles unsorted input', () => {
    expect(computeMedian([5, 1, 3])).toBe(3)
    expect(computeMedian([7, 1, 5, 3])).toBe(4)
  })

  it('does not mutate the input array', () => {
    const input = [3, 1, 2]
    computeMedian(input)
    expect(input).toEqual([3, 1, 2])
  })
})

// ────── computeTimingReport ──────

describe('computeTimingReport', () => {
  it('returns zeros for empty samples', () => {
    const report = computeTimingReport([])
    expect(report.medianMs).toBe(0)
    expect(report.passes).toEqual({})
    expect(report.sampleCount).toBe(0)
  })

  it('computes median for a single sample', () => {
    const samples: GpuFrameSample[] = [
      {
        totalMs: 5,
        passes: [
          { name: 'render', ms: 3 },
          { name: 'post', ms: 2 }
        ]
      }
    ]
    const report = computeTimingReport(samples)
    expect(report.medianMs).toBe(5)
    expect(report.passes['render']).toBe(3)
    expect(report.passes['post']).toBe(2)
    expect(report.sampleCount).toBe(1)
  })

  it('computes median across multiple samples', () => {
    const samples: GpuFrameSample[] = [
      {
        totalMs: 10,
        passes: [
          { name: 'march', ms: 8 },
          { name: 'comp', ms: 2 }
        ]
      },
      {
        totalMs: 12,
        passes: [
          { name: 'march', ms: 9 },
          { name: 'comp', ms: 3 }
        ]
      },
      {
        totalMs: 11,
        passes: [
          { name: 'march', ms: 8.5 },
          { name: 'comp', ms: 2.5 }
        ]
      }
    ]
    const report = computeTimingReport(samples)
    expect(report.medianMs).toBe(11)
    expect(report.passes['march']).toBe(8.5)
    expect(report.passes['comp']).toBe(2.5)
    expect(report.sampleCount).toBe(3)
  })

  it('handles samples with different pass sets gracefully', () => {
    const samples: GpuFrameSample[] = [
      { totalMs: 5, passes: [{ name: 'a', ms: 3 }] },
      {
        totalMs: 7,
        passes: [
          { name: 'a', ms: 4 },
          { name: 'b', ms: 3 }
        ]
      }
    ]
    const report = computeTimingReport(samples)
    expect(report.passes['a']).toBe(3.5)
    expect(report.passes['b']).toBe(3)
  })
})

// ────── GpuTimingCollector ──────

describe('GpuTimingCollector', () => {
  it('starts empty and not ready', () => {
    const c = new GpuTimingCollector(3)
    expect(c.count).toBe(0)
    expect(c.ready).toBe(false)
    expect(c.report()).toBeNull()
  })

  it('becomes ready at target count', () => {
    const c = new GpuTimingCollector(3)
    c.add({ totalMs: 1, passes: [] })
    expect(c.ready).toBe(false)
    c.add({ totalMs: 2, passes: [] })
    expect(c.ready).toBe(false)
    c.add({ totalMs: 3, passes: [] })
    expect(c.ready).toBe(true)
    expect(c.count).toBe(3)
  })

  it('evicts oldest sample when over target', () => {
    const c = new GpuTimingCollector(3)
    c.add({ totalMs: 1, passes: [] })
    c.add({ totalMs: 2, passes: [] })
    c.add({ totalMs: 3, passes: [] })
    c.add({ totalMs: 100, passes: [] })
    expect(c.count).toBe(3)
    const report = c.report()!
    expect(report.medianMs).toBe(3)
  })

  it('report() returns valid report with fewer than target samples', () => {
    const c = new GpuTimingCollector(32)
    c.add({ totalMs: 5, passes: [{ name: 'x', ms: 5 }] })
    c.add({ totalMs: 10, passes: [{ name: 'x', ms: 10 }] })
    const report = c.report()!
    expect(report.medianMs).toBe(7.5)
    expect(report.sampleCount).toBe(2)
  })

  it('reset() clears all samples', () => {
    const c = new GpuTimingCollector(3)
    c.add({ totalMs: 1, passes: [] })
    c.add({ totalMs: 2, passes: [] })
    c.reset()
    expect(c.count).toBe(0)
    expect(c.ready).toBe(false)
    expect(c.report()).toBeNull()
  })

  it('default target count is 32', () => {
    const c = new GpuTimingCollector()
    for (let i = 0; i < 31; i++) c.add({ totalMs: i, passes: [] })
    expect(c.ready).toBe(false)
    c.add({ totalMs: 31, passes: [] })
    expect(c.ready).toBe(true)
  })
})

// ────── WebGLGpuTimer ──────

describe('WebGLGpuTimer', () => {
  it('reports unavailable when gl is null', () => {
    const timer = new WebGLGpuTimer(null)
    expect(timer.available).toBe(false)
    expect(timer.reason).toBe('No WebGL2 context')
  })

  it('reports unavailable when extension is missing', () => {
    const gl = {
      getExtension: vi.fn(() => null)
    } as unknown as WebGL2RenderingContext
    const timer = new WebGLGpuTimer(gl)
    expect(timer.available).toBe(false)
    expect(timer.reason).toBe('EXT_disjoint_timer_query_webgl2 not available')
  })

  it('reports available when extension exists', () => {
    const ext = {
      TIME_ELAPSED_EXT: 0x88bf,
      GPU_DISJOINT_EXT: 0x8fbb
    }
    const gl = {
      getExtension: vi.fn(() => ext),
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866
    } as unknown as WebGL2RenderingContext
    const timer = new WebGLGpuTimer(gl)
    expect(timer.available).toBe(true)
    expect(timer.reason).toBeNull()
  })

  it('beginPass/endPass/endFrame/collectPending lifecycle', () => {
    const ext = {
      TIME_ELAPSED_EXT: 0x88bf,
      GPU_DISJOINT_EXT: 0x8fbb
    }
    let queryCounter = 0
    const gl = {
      getExtension: vi.fn(() => ext),
      createQuery: vi.fn(() => ({ id: queryCounter++ })),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      getParameter: vi.fn(() => false),
      getQueryParameter: vi.fn((_q: unknown, pname: number) => {
        if (pname === 0x8867) return true
        return 5000000
      }),
      deleteQuery: vi.fn(),
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866
    } as unknown as WebGL2RenderingContext

    const timer = new WebGLGpuTimer(gl)

    timer.beginPass('render')
    timer.endPass()
    timer.beginPass('post')
    timer.endPass()
    timer.endFrame()

    const result = timer.collectPending()
    expect(result).not.toBeNull()
    expect(result!.passes).toHaveLength(2)
    expect(result!.passes[0]!.name).toBe('render')
    expect(result!.passes[0]!.ms).toBe(5)
    expect(result!.passes[1]!.name).toBe('post')
    expect(result!.totalMs).toBe(10)
  })

  it('discards frame on GPU_DISJOINT_EXT', () => {
    const ext = {
      TIME_ELAPSED_EXT: 0x88bf,
      GPU_DISJOINT_EXT: 0x8fbb
    }
    const gl = {
      getExtension: vi.fn(() => ext),
      createQuery: vi.fn(() => ({})),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      getParameter: vi.fn(() => true),
      deleteQuery: vi.fn(),
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866
    } as unknown as WebGL2RenderingContext

    const timer = new WebGLGpuTimer(gl)
    timer.beginPass('test')
    timer.endPass()
    timer.endFrame()

    const result = timer.collectPending()
    expect(result).toBeNull()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gl.deleteQuery).toHaveBeenCalled()
  })

  it('returns null when queries not yet available', () => {
    const ext = {
      TIME_ELAPSED_EXT: 0x88bf,
      GPU_DISJOINT_EXT: 0x8fbb
    }
    const gl = {
      getExtension: vi.fn(() => ext),
      createQuery: vi.fn(() => ({})),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      getParameter: vi.fn(() => false),
      getQueryParameter: vi.fn(() => false),
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866
    } as unknown as WebGL2RenderingContext

    const timer = new WebGLGpuTimer(gl)
    timer.beginPass('test')
    timer.endPass()
    timer.endFrame()

    expect(timer.collectPending()).toBeNull()
  })

  it('no-ops beginPass/endPass when unavailable', () => {
    const timer = new WebGLGpuTimer(null)
    timer.beginPass('test')
    timer.endPass()
    timer.endFrame()
    expect(timer.collectPending()).toBeNull()
  })

  it('dispose() cleans up all queries', () => {
    const ext = {
      TIME_ELAPSED_EXT: 0x88bf,
      GPU_DISJOINT_EXT: 0x8fbb
    }
    const gl = {
      getExtension: vi.fn(() => ext),
      createQuery: vi.fn(() => ({})),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      deleteQuery: vi.fn(),
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866
    } as unknown as WebGL2RenderingContext

    const timer = new WebGLGpuTimer(gl)
    timer.beginPass('a')
    timer.endPass()
    timer.beginPass('b')
    timer.endPass()
    timer.endFrame()
    timer.beginPass('c')
    timer.endPass()

    timer.dispose()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gl.deleteQuery).toHaveBeenCalledTimes(3)
  })
})

// ────── WebGPUGpuTimer ──────

describe('WebGPUGpuTimer', () => {
  it('reports unavailable when renderer is null', () => {
    const timer = new WebGPUGpuTimer(null)
    expect(timer.available).toBe(false)
    expect(timer.reason).toBe('No WebGPU renderer')
  })

  it('reports unavailable when timestamp-query not supported', () => {
    const renderer = {
      hasFeature: vi.fn(() => false),
      resolveTimestampsAsync: vi.fn(),
      backend: { trackTimestamp: false }
    }
    const timer = new WebGPUGpuTimer(renderer)
    expect(timer.available).toBe(false)
    expect(timer.reason).toContain('timestamp-query')
  })

  it('reports unavailable when trackTimestamp not enabled', () => {
    const renderer = {
      hasFeature: vi.fn(() => true),
      resolveTimestampsAsync: vi.fn(),
      backend: { trackTimestamp: false }
    }
    const timer = new WebGPUGpuTimer(renderer)
    expect(timer.available).toBe(false)
    expect(timer.reason).toContain('trackTimestamp')
  })

  it('reports available when both feature and tracking enabled', () => {
    const renderer = {
      hasFeature: vi.fn(() => true),
      resolveTimestampsAsync: vi.fn(),
      backend: { trackTimestamp: true }
    }
    const timer = new WebGPUGpuTimer(renderer)
    expect(timer.available).toBe(true)
    expect(timer.reason).toBeNull()
  })

  // three's resolveTimestampsAsync returns MILLISECONDS (it divides by 1e6)
  // This test once fed 5_000_000 and expected 5, sharing the implementation's
  // wrong assumption. Feed it a value a real frame actually produces.
  it('resolve() passes the renderer duration through as milliseconds', async () => {
    const renderer = {
      hasFeature: vi.fn(() => true),
      resolveTimestampsAsync: vi.fn(() => Promise.resolve(21.6)),
      backend: { trackTimestamp: true }
    }
    const timer = new WebGPUGpuTimer(renderer)
    const sample = await timer.resolve()
    expect(sample).not.toBeNull()
    expect(sample!.totalMs).toBe(21.6)
    expect(sample!.passes[0]!.name).toBe('render')
    expect(sample!.passes[0]!.ms).toBe(21.6)
  })

  // The regression this guards: a plausible per-frame duration must not come
  // back as a number that formats to "0.00 ms"
  it('resolve() does not scale a realistic frame time to zero', async () => {
    const renderer = {
      hasFeature: vi.fn(() => true),
      resolveTimestampsAsync: vi.fn(() => Promise.resolve(21.6)),
      backend: { trackTimestamp: true }
    }
    const timer = new WebGPUGpuTimer(renderer)
    const sample = await timer.resolve()
    expect(sample!.totalMs).toBeGreaterThan(1)
  })

  it('resolve() returns null when duration is 0', async () => {
    const renderer = {
      hasFeature: vi.fn(() => true),
      resolveTimestampsAsync: vi.fn(() => Promise.resolve(0)),
      backend: { trackTimestamp: true }
    }
    const timer = new WebGPUGpuTimer(renderer)
    expect(await timer.resolve()).toBeNull()
  })

  it('resolve() returns null when unavailable', async () => {
    const timer = new WebGPUGpuTimer(null)
    expect(await timer.resolve()).toBeNull()
  })
})

// ────── buildTimingSummary ──────

describe('buildTimingSummary', () => {
  it('returns unavailable with reason when reasons provided', () => {
    const summary = buildTimingSummary(null, null, 'no ext', 'no feature')
    expect(summary.sideA).toEqual({ available: false, reason: 'no ext' })
    expect(summary.sideB).toEqual({ available: false, reason: 'no feature' })
  })

  it('returns report from collector when available', () => {
    const collectorA = new GpuTimingCollector(2)
    collectorA.add({ totalMs: 5, passes: [{ name: 'x', ms: 5 }] })
    collectorA.add({ totalMs: 7, passes: [{ name: 'x', ms: 7 }] })

    const summary = buildTimingSummary(collectorA, null, null, 'no feature')
    expect(summary.sideA.available).toBe(true)
    if (summary.sideA.available) {
      expect(summary.sideA.report.medianMs).toBe(6)
    }
    expect(summary.sideB).toEqual({ available: false, reason: 'no feature' })
  })

  it('returns unavailable when collector has no samples', () => {
    const collectorA = new GpuTimingCollector(32)
    const summary = buildTimingSummary(collectorA, null, null, null)
    expect(summary.sideA).toEqual({
      available: false,
      reason: 'No samples collected'
    })
  })
})

// ────── formatGpuMs ──────

describe('formatGpuMs', () => {
  it('formats available result', () => {
    const result: SideTimingResult = {
      available: true,
      report: { medianMs: 5.123, passes: {}, sampleCount: 32 }
    }
    expect(formatGpuMs(result)).toBe('5.12 ms')
  })

  it('formats unavailable result', () => {
    expect(formatGpuMs(unavailableResult('no ext'))).toBe('n/a')
  })
})
