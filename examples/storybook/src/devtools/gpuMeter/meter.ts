// Adapted from dgreenheck/threejs-fire-pro editor/gpu-timings.ts @ c284f0b
// (MIT, Copyright (c) 2026 Daniel Greenheck). One meter for the preview: a
// story attaches its renderer's device and calls beginFrame and endFrame
// around each frame. While the meter is off both are no-ops

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

import { GpuProfiler, type MeterDevice, type SkipReasons } from './GpuProfiler'
import { MeterHistory, type MeterStats } from './history'

const SAMPLE_INTERVAL_MS = 200
const WARMUP_SAMPLES = 5

export type MeterState =
  'off' | 'no-device' | 'unavailable' | 'waiting' | 'live' | 'failed'

export interface MeterSnapshot {
  state: MeterState
  stats: MeterStats
  // Sampled frames dropped because a pass went unmeasured
  incomplete: number
  // Why the latest incomplete sample was dropped
  lastSkip: SkipReasons | null
  envelopeMs: number | null
  // Clear-only passes per frame, which are not timed
  noDraw: number
  message?: string
}

export class GpuMeter {
  private enabled = false
  private device?: MeterDevice
  private profiler?: GpuProfiler
  private readonly history = new MeterHistory()
  private nextSample = 0
  private sampling = false
  private warmup = 0
  private generation = 0
  private incomplete = 0
  private lastSkip: SkipReasons | null = null
  private envelopeMs: number | null = null
  private noDraw = 0
  private failure?: string
  private readonly listeners = new Set<() => void>()
  private snapshotCache?: MeterSnapshot

  get active(): boolean {
    return this.enabled
  }

  setEnabled(value: boolean): void {
    if (value === this.enabled) return
    this.enabled = value
    this.restart()
  }

  // Returns the detach function. Attaching only stores the device
  attach(device: MeterDevice): () => void {
    this.device = device
    this.restart()
    return () => {
      if (this.device !== device) return
      this.device = undefined
      this.restart()
    }
  }

  beginFrame(now: number): void {
    if (!this.enabled || this.failure != null || now < this.nextSample) return
    if (this.profiler?.beginFrame() !== true) return
    this.sampling = true
    // Jittered: a fixed 200 ms is 12 frames at 60 fps and would always land on
    // the same frame parity, so a pass that runs every other frame read 0 or 2x
    this.nextSample = now + SAMPLE_INTERVAL_MS * (0.5 + Math.random())
  }

  endFrame(): void {
    const profiler = this.profiler
    if (!this.sampling || profiler == null) return
    this.sampling = false
    const generation = this.generation
    profiler
      .endFrame()
      .then(frame => {
        if (frame == null || generation !== this.generation) return
        if (frame.skipped > 0) {
          this.incomplete++
          this.lastSkip = frame.skipReasons
        } else if (this.warmup < WARMUP_SAMPLES) {
          this.warmup++
        } else {
          this.history.add(frame)
          this.envelopeMs = frame.envelopeMs
          this.noDraw = frame.noDraw
        }
        this.changed()
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return
        this.failure = error instanceof Error ? error.message : String(error)
        this.changed()
      })
  }

  reset(): void {
    this.history.reset()
    this.warmup = 0
    this.incomplete = 0
    this.lastSkip = null
    this.envelopeMs = null
    this.nextSample = 0
    this.generation++
    this.changed()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): MeterSnapshot {
    this.snapshotCache ??= {
      state: this.state(),
      stats: this.history.snapshot(),
      incomplete: this.incomplete,
      lastSkip: this.lastSkip,
      envelopeMs: this.envelopeMs,
      noDraw: this.noDraw,
      message: this.failure
    }
    return this.snapshotCache
  }

  private state(): MeterState {
    if (!this.enabled) return 'off'
    if (this.device == null) return 'no-device'
    if (this.profiler?.supported !== true) return 'unavailable'
    if (this.failure != null) return 'failed'
    return this.history.snapshot().samples > 0 ? 'live' : 'waiting'
  }

  private restart(): void {
    this.profiler?.dispose()
    this.profiler = undefined
    this.sampling = false
    this.failure = undefined
    if (this.enabled && this.device != null) {
      this.profiler = new GpuProfiler(this.device)
    }
    this.reset()
  }

  private changed(): void {
    this.snapshotCache = undefined
    for (const listener of this.listeners) listener()
  }
}

export const gpuMeter = new GpuMeter()
