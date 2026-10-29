// Rolling per-pass statistics for the meter. Fire Pro's gpu-timings.ts
// averages its last 100 captures, this keeps a shorter window so a settings
// change shows within a couple of seconds

import type { PassRow } from './attribution'
import { clockCorrected } from './clock'

export interface MeterSample {
  rows: readonly PassRow[]
  busyMs: number
  probeMs: number | null
}

export interface MeterRowStats {
  label: string
  calls: number
  rawMs: number
  // Null until every averaged sample has a probe
  fastMs: number | null
  // Oldest first, fast ms where the sample has a probe, else raw
  series: number[]
}

export interface MeterStats {
  samples: number
  frame: MeterRowStats
  rows: MeterRowStats[]
  probeMs: number | null
}

interface Track {
  calls: number[]
  raw: number[]
  fast: (number | null)[]
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length

export class MeterHistory {
  private readonly tracks = new Map<string, Track>()
  private readonly frame: Track = { calls: [], raw: [], fast: [] }
  private readonly probes: (number | null)[] = []
  private count = 0

  constructor(
    readonly averageWindow = 10,
    readonly seriesWindow = 60
  ) {}

  add({ rows, busyMs, probeMs }: MeterSample): void {
    const byLabel = new Map(rows.map(row => [row.label, row]))
    for (const row of rows) {
      if (!this.tracks.has(row.label)) {
        // A pass first seen now has no history, not a zero one
        this.tracks.set(row.label, { calls: [], raw: [], fast: [] })
      }
    }
    // A pass missing from a sample cost nothing that frame, the way a shadow
    // update interval of 2 skips every other frame
    for (const [label, track] of this.tracks) {
      const row = byLabel.get(label)
      this.push(track, row?.calls ?? 0, row?.milliseconds ?? 0, probeMs)
    }
    this.push(this.frame, 1, busyMs, probeMs)
    this.probes.push(probeMs)
    if (this.probes.length > this.seriesWindow) this.probes.shift()
    this.count++
  }

  reset(): void {
    this.tracks.clear()
    this.frame.calls.length = 0
    this.frame.raw.length = 0
    this.frame.fast.length = 0
    this.probes.length = 0
    this.count = 0
  }

  snapshot(): MeterStats {
    const recentProbes = this.probes
      .slice(-this.averageWindow)
      .filter((p): p is number => p != null)
    return {
      samples: this.count,
      frame: this.stats('frame', this.frame),
      rows: [...this.tracks].map(([label, track]) => this.stats(label, track)),
      probeMs: recentProbes.length > 0 ? mean(recentProbes) : null
    }
  }

  private push(
    track: Track,
    calls: number,
    rawMs: number,
    probeMs: number | null
  ): void {
    track.calls.push(calls)
    track.raw.push(rawMs)
    track.fast.push(clockCorrected(rawMs, probeMs))
    if (track.raw.length > this.seriesWindow) {
      track.calls.shift()
      track.raw.shift()
      track.fast.shift()
    }
  }

  private stats(label: string, track: Track): MeterRowStats {
    const n = this.averageWindow
    const fast = track.fast.slice(-n)
    return {
      label,
      calls: mean(track.calls.slice(-n)),
      rawMs: mean(track.raw.slice(-n)),
      fastMs: fast.every(v => v != null) ? mean(fast) : null,
      series: track.raw.map((raw, i) => track.fast[i] ?? raw)
    }
  }
}
