// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial
// Port-only: the original has no governor. The levels come from the perf map
// and the operator's 2026-10-09 judgement

import { Vector2 } from 'three'

import {
  defaults,
  writeQualityPresetValues,
  type CloudsPresetFields,
  type QualityPreset,
  type QualityPresetTarget,
  type QualityPresetValues,
  type ShadowPresetFields
} from './qualityPresets'

/** What a governor drives: a `CloudsContext`, or anything shaped like one */
export interface QualityGovernorTarget extends QualityPresetTarget {
  qualityPreset: QualityPreset
  qualityGovernor?: QualityGovernor | null
}

/** 0 is the target's own settings, 1 the perf map's c3, 2 the lowEnd preset */
export type QualityGovernorLevel = 0 | 1 | 2

export interface QualityGovernorStepEvent {
  from: QualityGovernorLevel
  to: QualityGovernorLevel
  /** Frames fed since arm() */
  frame: number
  /** The frame time that completed the decision, 0 on disarm */
  frameMs: number
  reason: 'late' | 'headroom' | 'disarm'
}

export interface QualityGovernorOptions {
  /** Frame interval above which a frame is late. Default 24, a missed vsync at 60 fps */
  budgetMs?: number
  /** The window of recent frames a step down reads. Default 10 */
  stepDownFrames?: number
  /** Frames without a late one before a step up. Default 120 */
  stepUpFrames?: number
  /** The share of the window that must be late to step down. Default 0.5 */
  lateFraction?: number
  /** Frame time that must accumulate between two steps. Default 3000 */
  cooldownMs?: number
  /** Frames ignored after a step: the first after a rebuild is unlit and slow. Default 3 */
  settleFrames?: number
  /** A step down this soon after a step up doubles the next step-up wait. Default 5000 */
  revertWindowMs?: number
  /** Called after every level change */
  onStep?: (event: QualityGovernorStepEvent) => void
}

type ResolvedOptions = Readonly<
  Required<Omit<QualityGovernorOptions, 'onStep'>>
>

/** The defaults every option falls back to */
export const qualityGovernorDefaults: ResolvedOptions = Object.freeze({
  budgetMs: 24,
  stepDownFrames: 10,
  stepUpFrames: 120,
  lateFraction: 0.5,
  cooldownMs: 3000,
  settleFrames: 3,
  revertWindowMs: 5000
})

// Level 1 is the perf map's c3, the shelved performance preset: the same
// writes a preset makes, without a name. Measured on the M4 Mini at 2880x1800:
// 6.05 / 5.07 / 7.47 / 6.48 ms on the four perf-map scenes
export const QUALITY_GOVERNOR_LEVEL_1: QualityPresetValues = {
  ...defaults,
  resolutionScale: 0.75,
  temporalUpscale: true,
  lightShaftsHalfResolution: true,
  turbulence: false,
  haze: false,
  clouds: {
    ...defaults.clouds,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    accurateSunSkyLight: false,
    maxIterationCountToSun: 2,
    maxIterationCountToGround: 0
  },
  shadow: {
    ...defaults.shadow,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    cascadeCount: 2,
    updateInterval: 4,
    mapSize: /*#__PURE__*/ new Vector2(256, 256)
  }
}

const MAX_BACKOFF = 16
const EVENT_HISTORY = 64

interface Snapshot {
  preset: QualityPreset
  values: QualityPresetValues
}

// Every field a level writes, read off the target so a custom setting survives
// a round trip. The key lists are the defaults' own, never the target's
function capture(target: QualityGovernorTarget): Snapshot {
  const clouds = { ...defaults.clouds } as Record<string, unknown>
  for (const key of Object.keys(defaults.clouds)) {
    clouds[key] = target.clouds[key as keyof CloudsPresetFields]
  }
  const shadow = { ...defaults.shadow } as Record<string, unknown>
  for (const key of Object.keys(defaults.shadow)) {
    if (key === 'mapSize') continue
    shadow[key] = target.shadow[key as keyof ShadowPresetFields]
  }
  shadow.mapSize = target.shadow.mapSize.clone()
  const values: QualityPresetValues = {
    resolutionScale: target.resolutionScale,
    lightShafts: target.lightShafts,
    shapeDetail: target.shapeDetail,
    turbulence: target.turbulence,
    haze: target.haze,
    clouds: clouds as unknown as CloudsPresetFields,
    shadow: shadow as unknown as ShadowPresetFields
  }
  if (target.temporalUpscale !== undefined)
    values.temporalUpscale = target.temporalUpscale
  if (target.lightShaftsHalfResolution !== undefined)
    values.lightShaftsHalfResolution = target.lightShaftsHalfResolution
  return { preset: target.qualityPreset, values }
}

// The name first, so the target records it, then the captured values over it
function restore(target: QualityGovernorTarget, snapshot: Snapshot): void {
  target.qualityPreset = snapshot.preset
  writeQualityPresetValues(target, snapshot.values)
}

/**
 * Steps a target between its own settings (level 0), the perf map's c3
 * (level 1) and the `lowEnd` preset (level 2), down when frames run late and
 * back up when headroom returns. The host feeds frame intervals: the library
 * never reads a clock. Opt-in: nothing happens until `arm()`.
 *
 * @remarks
 * Domain: rAF intervals in ms, one `update()` per frame. Late is over 24 ms,
 * a missed vsync at 60 fps. A step down follows half of the last ten frames
 * late, a step up 120 without one, and a step up that misses backs off
 * Mutation: a step writes the level through the target's setters, which
 * rebuild the graph and reset history. Level 0 restores the captured values
 * Ownership: one governor per target, registered by `createQualityGovernor`
 */
export class QualityGovernor {
  readonly options: ResolvedOptions
  private readonly onStep: ((event: QualityGovernorStepEvent) => void) | null
  private readonly target: QualityGovernorTarget
  private _level: QualityGovernorLevel = 0
  private _enabled = false
  private base: Snapshot | null = null
  private frame = 0
  // 1 per late frame, the last stepUpFrames of them, with their running sum
  private readonly lateFlags: number[] = []
  private lateInLong = 0
  private settling = 0
  private sinceStepMs = 0
  private elapsedMs = 0
  private upCooldownMs: number
  private lastUpAtMs: number | null = null
  private readonly _events: QualityGovernorStepEvent[] = []

  constructor(
    target: QualityGovernorTarget,
    options: QualityGovernorOptions = {}
  ) {
    const { onStep, ...rest } = options
    this.target = target
    this.options = Object.freeze({ ...qualityGovernorDefaults, ...rest })
    this.onStep = onStep ?? null
    this.upCooldownMs = this.options.cooldownMs
  }

  /** The current level, 0 until a step down */
  get level(): QualityGovernorLevel {
    return this._level
  }

  /** True between `arm()` and `disarm()` */
  get enabled(): boolean {
    return this._enabled
  }

  /** The last 64 level changes, oldest first */
  get events(): readonly QualityGovernorStepEvent[] {
    return this._events
  }

  /** Frames fed since `arm()` */
  get frames(): number {
    return this.frame
  }

  /**
   * Capture the target's current settings as level 0 and start governing.
   * A second call while armed does nothing.
   */
  arm(): void {
    if (this._enabled) return
    this.base = capture(this.target)
    this._level = 0
    this.frame = 0
    this.elapsedMs = 0
    this.lastUpAtMs = null
    this.upCooldownMs = this.options.cooldownMs
    this.resetCounters()
    // No cooldown before the first step
    this.sinceStepMs = this.options.cooldownMs
    this._enabled = true
  }

  /** Restore level 0 if needed and stop governing */
  disarm(): void {
    if (!this._enabled) return
    const from = this._level
    if (from !== 0 && this.base != null) {
      restore(this.target, this.base)
      this._level = 0
      this.record(from, 0, 'disarm', 0)
    }
    this._enabled = false
    this.base = null
  }

  /**
   * Feed one frame interval in milliseconds, the delta between two
   * requestAnimationFrame timestamps. Decides at most one step per call.
   */
  update(frameMs: number): void {
    if (!this._enabled || !Number.isFinite(frameMs) || frameMs < 0) return
    this.frame++
    if (this.settling > 0) {
      this.settling--
      return
    }
    this.sinceStepMs += frameMs
    this.elapsedMs += frameMs
    this.expireBackoff()
    this.count(frameMs)
    this.decide(frameMs)
  }

  // The last step up held for the whole window, so the backoff is over
  private expireBackoff(): void {
    const o = this.options
    if (
      this.lastUpAtMs != null &&
      this.elapsedMs - this.lastUpAtMs > o.revertWindowMs
    ) {
      this.upCooldownMs = o.cooldownMs
      this.lastUpAtMs = null
    }
  }

  // One flag per frame, kept for the long window with a running sum
  private count(frameMs: number): void {
    const o = this.options
    const late = frameMs > o.budgetMs ? 1 : 0
    this.lateFlags.push(late)
    this.lateInLong += late
    if (this.lateFlags.length > o.stepUpFrames) {
      this.lateInLong -= this.lateFlags.shift() ?? 0
    }
  }

  private lateInShort(): number {
    const o = this.options
    let late = 0
    const from = Math.max(0, this.lateFlags.length - o.stepDownFrames)
    for (let i = from; i < this.lateFlags.length; i++) {
      late += this.lateFlags[i] ?? 0
    }
    return late
  }

  // A step down reads the short window, a step up the long one. Each window
  // must be full, so a step never follows a handful of frames
  private decide(frameMs: number): void {
    const o = this.options
    const n = this.lateFlags.length
    if (
      n >= o.stepDownFrames &&
      this.lateInShort() >= Math.ceil(o.lateFraction * o.stepDownFrames) &&
      this._level < 2 &&
      this.sinceStepMs >= o.cooldownMs
    ) {
      this.step((this._level + 1) as QualityGovernorLevel, 'late', frameMs)
      return
    }
    if (
      n >= o.stepUpFrames &&
      this.lateInLong === 0 &&
      this._level > 0 &&
      this.sinceStepMs >= this.upCooldownMs
    ) {
      this.step((this._level - 1) as QualityGovernorLevel, 'headroom', frameMs)
    }
  }

  private step(
    to: QualityGovernorLevel,
    reason: 'late' | 'headroom',
    frameMs: number
  ): void {
    const from = this._level
    const o = this.options
    if (reason === 'late') {
      // A step down this soon after a step up reverts it: back off
      if (
        this.lastUpAtMs != null &&
        this.elapsedMs - this.lastUpAtMs <= o.revertWindowMs
      ) {
        this.upCooldownMs = Math.min(
          this.upCooldownMs * 2,
          o.cooldownMs * MAX_BACKOFF
        )
      }
      this.lastUpAtMs = null
    } else {
      this.lastUpAtMs = this.elapsedMs
    }
    this.apply(to)
    this._level = to
    this.resetCounters()
    this.sinceStepMs = 0
    this.settling = o.settleFrames
    this.record(from, to, reason, frameMs)
  }

  private apply(level: QualityGovernorLevel): void {
    if (level === 0) {
      if (this.base != null) restore(this.target, this.base)
    } else if (level === 1) {
      writeQualityPresetValues(this.target, QUALITY_GOVERNOR_LEVEL_1)
    } else {
      this.target.qualityPreset = 'lowEnd'
    }
  }

  private resetCounters(): void {
    this.lateFlags.length = 0
    this.lateInLong = 0
    this.settling = 0
  }

  private record(
    from: QualityGovernorLevel,
    to: QualityGovernorLevel,
    reason: QualityGovernorStepEvent['reason'],
    frameMs: number
  ): void {
    const event = { from, to, frame: this.frame, frameMs, reason }
    this._events.push(event)
    if (this._events.length > EVENT_HISTORY) this._events.shift()
    this.onStep?.(event)
  }
}

/**
 * Create a governor for a target and register it as the target's
 * `qualityGovernor`, which is what `applyReferenceMode` disarms. The governor
 * starts disarmed: call `arm()` to begin, and feed `update(frameMs)` per frame.
 */
export function createQualityGovernor(
  target: QualityGovernorTarget,
  options?: QualityGovernorOptions
): QualityGovernor {
  const governor = new QualityGovernor(target, options)
  target.qualityGovernor = governor
  return governor
}
