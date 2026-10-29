// Adapted from dgreenheck/threejs-fire-pro src/engine/GpuProfiler.ts @ c284f0b
// (MIT, Copyright (c) 2026 Daniel Greenheck). Differences: render AND compute
// passes are named by their first pipeline, the clock probe runs after each
// sampled frame, and the GPU types are the narrow ones this file uses

/* eslint-disable no-comment-slop/max-comment-lines -- vendored MIT license, verbatim */
/**
 * MIT License
 *
 * Copyright (c) 2026 Daniel Greenheck
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* eslint-enable no-comment-slop/max-comment-lines */

import { exclusiveTimings, type PassRow, type PassSpan } from './attribution'
import { PROBE_BUFFER_BYTES, PROBE_WGSL, PROBE_WORKGROUPS } from './clock'
import { passLabel } from './labels'

// WebGPU flag values, fixed by the spec, so this file needs no global types
const MAP_READ = 0x0001
const COPY_SRC = 0x0004
const COPY_DST = 0x0008
const STORAGE = 0x0080
const QUERY_RESOLVE = 0x0200
const MAP_MODE_READ = 0x0001

// Two slots for the probe, then a begin and end pair per pass
const QUERY_COUNT = 4096
const FIRST_PASS_SLOT = 2

interface Labelled {
  label?: string
}
interface TimestampWrites {
  querySet: unknown
  beginningOfPassWriteIndex: number
  endOfPassWriteIndex: number
}
interface PassDescriptor extends Labelled {
  timestampWrites?: TimestampWrites
}
export interface MeterPass {
  setPipeline(pipeline: Labelled): void
  setBindGroup(index: number, group: unknown): void
  dispatchWorkgroups(x: number): void
  end(): void
}
export interface MeterEncoder {
  beginRenderPass(descriptor: PassDescriptor): MeterPass
  beginComputePass(descriptor?: PassDescriptor): MeterPass
  resolveQuerySet(
    set: unknown,
    first: number,
    count: number,
    dst: unknown,
    offset: number
  ): void
  copyBufferToBuffer(
    src: unknown,
    srcOffset: number,
    dst: unknown,
    dstOffset: number,
    size: number
  ): void
  finish(): unknown
}
export interface MeterBuffer {
  mapState: string
  mapAsync(mode: number, offset: number, size: number): Promise<void>
  getMappedRange(offset: number, size: number): ArrayBuffer
  unmap(): void
  destroy(): void
}
export interface MeterDevice {
  features: { has(name: string): boolean }
  queue: { submit(buffers: unknown[]): void }
  // A property, not a method: the profiler swaps it for a sampled frame
  createCommandEncoder: (descriptor?: Labelled) => MeterEncoder
  createQuerySet(descriptor: {
    label?: string
    type: 'timestamp'
    count: number
  }): { destroy(): void }
  createBuffer(descriptor: {
    label?: string
    size: number
    usage: number
  }): MeterBuffer
  createShaderModule(descriptor: { code: string }): unknown
  createComputePipeline(descriptor: {
    layout: 'auto'
    compute: { module: unknown; entryPoint: string }
  }): Labelled & { getBindGroupLayout(index: number): unknown }
  createBindGroup(descriptor: {
    layout: unknown
    entries: { binding: number; resource: { buffer: unknown } }[]
  }): unknown
}

export interface ProfiledFrame {
  rows: PassRow[]
  busyMs: number
  envelopeMs: number
  probeMs: number | null
  // Passes that drew nothing, left out of the rows
  noDraw: number
  // Passes not measured. A frame with any is incomplete
  skipped: number
  skipReasons: SkipReasons
}

export interface SkipReasons {
  // three already times the pass (trackTimestamp)
  alreadyTimed: number
  // past the query budget
  overflow: number
  // end before start
  invalid: number
  invalidLabels: string[]
}

interface Entry {
  pipelineLabel?: string
}

interface Resources {
  queries: { destroy(): void }
  resolve: MeterBuffer
  readback: MeterBuffer
  probe: {
    pipeline: Labelled
    bindGroup: unknown
    buffer: MeterBuffer
  }
}

// Bounded, asynchronous timestamp readback. No GPU waits in the render loop
export class GpuProfiler {
  readonly supported: boolean
  private resources?: Resources
  private entries: Entry[] = []
  private alreadyTimed = 0
  private overflow = 0
  private recording = false
  private pending = false
  private disposed = false
  private originalCreateEncoder?: MeterDevice['createCommandEncoder']
  private ownCreateEncoder = false

  constructor(private readonly device: MeterDevice) {
    this.supported = device.features.has('timestamp-query')
  }

  get busy(): boolean {
    return this.recording || this.pending
  }

  beginFrame(): boolean {
    if (!this.supported || this.busy || this.disposed) return false
    this.resources ??= this.createResources()
    this.entries = []
    this.alreadyTimed = 0
    this.overflow = 0
    this.recording = true
    // three owns its encoders. Instrument their passes only during this
    // frame, then restore the exact original device method
    const device = this.device
    const createEncoder = device.createCommandEncoder
    this.originalCreateEncoder = createEncoder
    this.ownCreateEncoder = Object.hasOwn(device, 'createCommandEncoder')
    device.createCommandEncoder = descriptor => {
      const encoder = createEncoder.call(device, descriptor)
      this.instrument(encoder)
      return encoder
    }
    return true
  }

  async endFrame(): Promise<ProfiledFrame | null> {
    if (!this.recording) return null
    this.stopRecording()
    const { queries, resolve, readback, probe } = this.resources!
    const slots = FIRST_PASS_SLOT + this.entries.length * 2
    const bytes = slots * 8
    const encoder = this.device.createCommandEncoder({
      label: 'GPU meter probe and resolve'
    })
    // Queued after the frame's own work, so it runs in the frame's clock state
    const pass = encoder.beginComputePass({
      label: 'GPU meter clock probe',
      timestampWrites: {
        querySet: queries,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1
      }
    })
    pass.setPipeline(probe.pipeline)
    pass.setBindGroup(0, probe.bindGroup)
    pass.dispatchWorkgroups(PROBE_WORKGROUPS)
    pass.end()
    encoder.resolveQuerySet(queries, 0, slots, resolve, 0)
    encoder.copyBufferToBuffer(resolve, 0, readback, 0, bytes)
    this.device.queue.submit([encoder.finish()])
    this.pending = true
    try {
      await readback.mapAsync(MAP_MODE_READ, 0, bytes)
      if (this.disposed) return null
      const times = new BigUint64Array(readback.getMappedRange(0, bytes))
      return this.toFrame(times)
    } catch (error) {
      if (!this.disposed) throw error
      return null
    } finally {
      if (readback.mapState === 'mapped') readback.unmap()
      this.pending = false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.recording) this.stopRecording()
    this.resources?.queries.destroy()
    this.resources?.resolve.destroy()
    this.resources?.readback.destroy()
    this.resources?.probe.buffer.destroy()
    this.resources = undefined
  }

  private toFrame(times: BigUint64Array): ProfiledFrame {
    const spans: PassSpan[] = []
    let noDraw = 0
    this.entries.forEach((entry, i) => {
      // Dawn on Metal gives a pass that sets no pipeline (a clear) garbage
      // timestamps, an end up to seconds before its start, so it is not timed
      if (entry.pipelineLabel == null) {
        noDraw++
        return
      }
      spans.push({
        label: passLabel(entry.pipelineLabel),
        start: times.at(FIRST_PASS_SLOT + i * 2) ?? 0n,
        end: times.at(FIRST_PASS_SLOT + i * 2 + 1) ?? 0n
      })
    })
    const { rows, invalid, invalidLabels, busyMs, envelopeMs } =
      exclusiveTimings(spans)
    const probeNs = (times.at(1) ?? 0n) - (times.at(0) ?? 0n)
    return {
      rows,
      busyMs,
      envelopeMs,
      probeMs: probeNs > 0n ? Number(probeNs) / 1e6 : null,
      noDraw,
      skipped: this.alreadyTimed + this.overflow + invalid,
      skipReasons: {
        alreadyTimed: this.alreadyTimed,
        overflow: this.overflow,
        invalid,
        invalidLabels
      }
    }
  }

  private instrument(encoder: MeterEncoder): void {
    const timed =
      (begin: (descriptor: PassDescriptor) => MeterPass) =>
      (descriptor: PassDescriptor = {}): MeterPass => {
        const writes = this.timestamps(descriptor)
        if (writes == null) return begin(descriptor)
        const pass = begin({ ...descriptor, timestampWrites: writes.slots })
        const setPipeline = pass.setPipeline.bind(pass)
        pass.setPipeline = pipeline => {
          writes.entry.pipelineLabel ??= pipeline.label
          setPipeline(pipeline)
        }
        return pass
      }
    encoder.beginRenderPass = timed(encoder.beginRenderPass.bind(encoder))
    encoder.beginComputePass = timed(encoder.beginComputePass.bind(encoder))
  }

  private timestamps(
    descriptor: PassDescriptor
  ): { slots: TimestampWrites; entry: Entry } | undefined {
    if (!this.recording) return undefined
    const index = FIRST_PASS_SLOT + this.entries.length * 2
    // A pass three already times (trackTimestamp) keeps its own writes
    if (descriptor.timestampWrites != null) {
      this.alreadyTimed++
      return undefined
    }
    if (index + 2 > QUERY_COUNT) {
      this.overflow++
      return undefined
    }
    const entry: Entry = {}
    this.entries.push(entry)
    return {
      entry,
      slots: {
        querySet: this.resources!.queries,
        beginningOfPassWriteIndex: index,
        endOfPassWriteIndex: index + 1
      }
    }
  }

  private stopRecording(): void {
    // A real GPUDevice has the method on its prototype: delete the wrapper
    // rather than leave an own copy behind
    if (this.originalCreateEncoder != null) {
      if (this.ownCreateEncoder) {
        this.device.createCommandEncoder = this.originalCreateEncoder
      } else {
        delete (this.device as Partial<MeterDevice>).createCommandEncoder
      }
    }
    this.originalCreateEncoder = undefined
    this.recording = false
  }

  private createResources(): Resources {
    const device = this.device
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: PROBE_WGSL }),
        entryPoint: 'main'
      }
    })
    const buffer = device.createBuffer({
      label: 'GPU meter probe output',
      size: PROBE_BUFFER_BYTES,
      usage: STORAGE
    })
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }]
    })
    return {
      queries: device.createQuerySet({
        label: 'GPU meter timestamps',
        type: 'timestamp',
        count: QUERY_COUNT
      }),
      resolve: device.createBuffer({
        label: 'GPU meter resolve',
        size: QUERY_COUNT * 8,
        usage: QUERY_RESOLVE | COPY_SRC
      }),
      readback: device.createBuffer({
        label: 'GPU meter readback',
        size: QUERY_COUNT * 8,
        usage: COPY_DST | MAP_READ
      }),
      probe: { pipeline, buffer, bindGroup }
    }
  }
}
