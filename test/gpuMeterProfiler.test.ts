// The Storybook GPU meter wraps device.createCommandEncoder, a hot path of
// every frame. Off, it must leave the device exactly as three made it, and on,
// it must restore the original after each sampled frame. Its rows must carry
// the clouds pass names the perf map uses, with cascades grouped into one row
import { describe, expect, it } from 'vitest'

import {
  GpuProfiler,
  type MeterDevice,
  type MeterEncoder,
  type MeterPass
} from '../examples/storybook/src/devtools/gpuMeter/GpuProfiler'
import {
  byPassOrder,
  passLabel
} from '../examples/storybook/src/devtools/gpuMeter/labels'
import { GpuMeter } from '../examples/storybook/src/devtools/gpuMeter/meter'
import { log } from './helpers/log'

interface Writes {
  beginningOfPassWriteIndex: number
  endOfPassWriteIndex: number
}

// A device whose passes write the next scripted [start, end] pair, in ns
function fakeDevice(script: [number, number][] = []) {
  const slots = new BigUint64Array(4096)
  const counts = { querySets: 0, passes: 0 }
  const received: unknown[] = []
  const pass = (writes?: Writes): MeterPass => {
    counts.passes++
    return {
      setPipeline: () => undefined,
      setBindGroup: () => undefined,
      dispatchWorkgroups: () => undefined,
      end: () => {
        const times = script.shift() ?? [0, 0]
        if (writes == null) return
        slots[writes.beginningOfPassWriteIndex] = BigInt(times[0])
        slots[writes.endOfPassWriteIndex] = BigInt(times[1])
      }
    }
  }
  const encoder = (): MeterEncoder => ({
    beginRenderPass: d => {
      received.push(d.timestampWrites)
      return pass(d.timestampWrites)
    },
    beginComputePass: d => pass(d?.timestampWrites),
    resolveQuerySet: () => undefined,
    copyBufferToBuffer: () => undefined,
    finish: () => ({})
  })
  const buffer = () => ({
    mapState: 'unmapped',
    mapAsync: () => Promise.resolve(),
    getMappedRange: (offset: number, size: number) =>
      slots.buffer.slice(offset, offset + size),
    unmap: () => undefined,
    destroy: () => undefined
  })
  const device: MeterDevice = {
    features: { has: name => name === 'timestamp-query' },
    queue: { submit: () => undefined },
    createCommandEncoder: encoder,
    createQuerySet: () => {
      counts.querySets++
      return { destroy: () => undefined }
    },
    createBuffer: buffer,
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({})
  }
  return { device, counts, received }
}

// What three does in one clouds frame: one encoder per render, pipelines
// labelled renderPipeline_<material name>_<id>
function threeFrame(device: MeterDevice): void {
  const draw = (pipeline: string) => {
    const encoder = device.createCommandEncoder({ label: 'renderContext_7' })
    const pass = encoder.beginRenderPass({})
    pass.setPipeline({ label: pipeline })
    pass.end()
  }
  draw('renderPipeline_ShadowPass_41')
  draw('renderPipeline_ShadowPass_41')
  draw('renderPipeline_ShadowPass_41')
  draw('renderPipeline_CloudsPass_42')
  draw('renderPipeline_RenderPipeline_57')
}

describe('passLabel', () => {
  it('names a pass by its pipeline stem, as the perf map does', () => {
    const cases: [string, string][] = [
      ['renderPipeline_ShadowPass_123', 'ShadowPass'],
      ['renderPipeline_CloudsResolve_9', 'CloudsResolve'],
      ['computePipeline_compute_transmittance', 'compute_transmittance'],
      [
        'renderPipeline_MipmapSurfaceBlur_downsample_88',
        'MipmapSurfaceBlur_downsample'
      ]
    ]
    log(
      'labels',
      cases.map(([p, want]) => ({ p, got: passLabel(p), want }))
    )
    for (const [pipeline, want] of cases) {
      expect(passLabel(pipeline)).toBe(want)
    }
  })
})

describe('byPassOrder', () => {
  it('keeps the clouds passes in pipeline order whatever sample saw them first', () => {
    // ShadowPass skipped the first sample (update interval), so it was seen last
    const seen = [
      'RenderPipeline',
      'GaussianBlur',
      'CloudsPass',
      'LensGlare',
      'ShadowPass'
    ]
    const out = byPassOrder(seen.map(label => ({ label }))).map(r => r.label)
    log('order', { seen: seen.join(' '), shown: out.join(' ') })
    expect(out).toEqual([
      'ShadowPass',
      'CloudsPass',
      'RenderPipeline',
      'GaussianBlur',
      'LensGlare'
    ])
  })
})

describe('GpuProfiler', () => {
  it('times a sampled frame and groups the three cascades into one row', async () => {
    // probe 0..400 us, then each pass
    const { device } = fakeDevice([
      [0, 1e6],
      [1e6, 2e6],
      [2e6, 3e6],
      [3e6, 10e6],
      [10e6, 15e6],
      [0, 400e3]
    ])
    const profiler = new GpuProfiler(device)
    expect(profiler.beginFrame()).toBe(true)
    threeFrame(device)
    const frame = await profiler.endFrame()
    const rows = frame!.rows.map(r => [r.label, r.calls, r.milliseconds])
    log('profiler-rows', { rows: JSON.stringify(rows), probe: frame!.probeMs })
    expect(rows).toEqual([
      ['ShadowPass', 3, 3],
      ['CloudsPass', 1, 7],
      ['RenderPipeline', 1, 5]
    ])
    expect(frame!.probeMs).toBeCloseTo(0.4, 12)
    expect(frame!.skipped).toBe(0)
  })

  it('leaves a clear-only pass out instead of dropping the frame', async () => {
    // Metal's clear-only pass: an end long before its start
    const { device } = fakeDevice([
      [0, 5e6],
      [9e6, 1e3],
      [5e6, 8e6],
      [0, 400e3]
    ])
    const profiler = new GpuProfiler(device)
    profiler.beginFrame()
    const draw = (pipeline?: string) => {
      const pass = device.createCommandEncoder().beginRenderPass({})
      if (pipeline != null) pass.setPipeline({ label: pipeline })
      pass.end()
    }
    draw('renderPipeline_CloudsPass_1')
    draw()
    draw('renderPipeline_RenderPipeline_2')
    const frame = await profiler.endFrame()
    log('no-draw', { noDraw: frame!.noDraw, skipped: frame!.skipped })
    expect(frame!.skipped).toBe(0)
    expect(frame!.noDraw).toBe(1)
    expect(frame!.rows.map(r => r.label)).toEqual([
      'CloudsPass',
      'RenderPipeline'
    ])
    expect(frame!.busyMs).toBe(8)
  })

  it('still drops a frame whose drawing pass ends before it starts', async () => {
    const { device } = fakeDevice([
      [5e6, 1e6],
      [0, 400e3]
    ])
    const profiler = new GpuProfiler(device)
    profiler.beginFrame()
    const pass = device.createCommandEncoder().beginRenderPass({})
    pass.setPipeline({ label: 'renderPipeline_CloudsPass_1' })
    pass.end()
    const frame = await profiler.endFrame()
    expect(frame!.skipped).toBe(1)
    expect(frame!.skipReasons.invalidLabels).toEqual(['CloudsPass'])
  })

  it('restores the exact original createCommandEncoder after the frame', async () => {
    const { device } = fakeDevice()
    const original = device.createCommandEncoder
    const profiler = new GpuProfiler(device)
    profiler.beginFrame()
    expect(device.createCommandEncoder).not.toBe(original)
    threeFrame(device)
    await profiler.endFrame()
    expect(device.createCommandEncoder).toBe(original)
  })

  it('leaves no own property behind on a device whose method is inherited', async () => {
    // A real GPUDevice: createCommandEncoder lives on GPUDevice.prototype
    const { device: base } = fakeDevice()
    const device = Object.create(base) as MeterDevice
    const profiler = new GpuProfiler(device)
    profiler.beginFrame()
    expect(Object.hasOwn(device, 'createCommandEncoder')).toBe(true)
    await profiler.endFrame()
    expect(Object.hasOwn(device, 'createCommandEncoder')).toBe(false)
    expect(device.createCommandEncoder).toBe(base.createCommandEncoder)
  })

  it('leaves a pass three already times alone and marks the frame incomplete', async () => {
    const { device, received } = fakeDevice()
    const profiler = new GpuProfiler(device)
    profiler.beginFrame()
    const writes = {
      querySet: 'three',
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1
    }
    device.createCommandEncoder().beginRenderPass({ timestampWrites: writes })
    const frame = await profiler.endFrame()
    expect(received[0]).toBe(writes)
    expect(frame!.skipped).toBe(1)
  })
})

describe('GpuMeter sampling', () => {
  it('samples odd and even frames alike at 60 fps', async () => {
    // A shadow update interval of 2 runs on even frames only. A sampler locked
    // to one parity reports it at 0 or twice its average cost
    const { device } = fakeDevice()
    const original = device.createCommandEncoder
    const meter = new GpuMeter()
    meter.attach(device)
    meter.setEnabled(true)
    const parity = [0, 0]
    for (let frame = 0; frame < 3600; frame++) {
      meter.beginFrame(frame * (1000 / 60))
      if (device.createCommandEncoder !== original) parity[frame % 2]!++
      meter.endFrame()
      // let the fake readback resolve, as a real one does between frames
      await new Promise(resolve => setImmediate(resolve))
    }
    const share = parity[0]! / (parity[0]! + parity[1]!)
    log('sample-parity', { even: parity[0], odd: parity[1], share })
    expect(parity[0]! + parity[1]!).toBeGreaterThan(200)
    expect(share).toBeGreaterThan(0.35)
    expect(share).toBeLessThan(0.65)
  })
})

describe('GpuMeter on and off', () => {
  it('never touches the device while off', () => {
    const { device, counts } = fakeDevice()
    const original = device.createCommandEncoder
    const meter = new GpuMeter()
    meter.attach(device)
    for (let t = 0; t < 2000; t += 16) {
      meter.beginFrame(t)
      expect(device.createCommandEncoder).toBe(original)
      threeFrame(device)
      meter.endFrame()
    }
    log('meter-off', { querySets: counts.querySets })
    expect(counts.querySets).toBe(0)
    expect(meter.snapshot().state).toBe('off')
  })

  it('instruments only sampled frames while on, and restores when switched off mid-frame', () => {
    const { device } = fakeDevice()
    const original = device.createCommandEncoder
    const meter = new GpuMeter()
    meter.attach(device)
    meter.setEnabled(true)
    meter.beginFrame(0)
    expect(device.createCommandEncoder).not.toBe(original)
    meter.setEnabled(false)
    expect(device.createCommandEncoder).toBe(original)
    meter.endFrame()
    expect(device.createCommandEncoder).toBe(original)
  })
})
