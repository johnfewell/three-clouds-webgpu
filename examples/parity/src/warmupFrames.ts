// Which frame each warm-up render draws. With temporalUpscale on, only the
// `frame % 16` Bayer cell is marched (as the reference gates it,
// shared.js:2376), so a fixed frame builds history in 4x4 blocks (a
// hjhq). Extracted from main.ts to test without a GPU Cite: bayer.ts
// (`bayerIndices`), ADR-011 (time and frame pinned per case)

/** The resolve marches cell `frame % BAYER_PERIOD` */
export const BAYER_PERIOD = 16

/** The atmosphere's blue-noise jitter repeats every STBN_PERIOD frames */
export const STBN_PERIOD = 64

/**
 * How far ahead of the case's pinned frame a warm-up finishes.
 *
 * A multiple of both BAYER_PERIOD and STBN_PERIOD, so the final frame keeps the
 * pinned frame's Bayer cell AND its jitter offset: the ADR-011 pin is preserved
 * exactly and only the run-up ahead of it is filled in.
 *
 * The run-up counts FORWARD from the pinned frame rather than backward to it
 * because `frame - warmup` is negative for the usual `frame: 0` case, and a
 * negative frame gives a negative Bayer index (WGSL `%` keeps the sign).
 */
export const TEMPORAL_RUNUP = 64

/**
 * The frame for each of the `warmup + 1` renders a single renderOnce performs:
 * `warmup` warm-up renders followed by the final one.
 *
 * Every call lands on the SAME final frame regardless of `warmup`, which keeps
 * the asymmetric capture flow symmetric: counting up left A and B on different
 * Bayer cells and history depths (0.7226 vs 0.9395 for a symmetric run).
 *
 * `warmup: 0` stays pinned at `frame`: with no history to assemble, a single
 * render gets exactly the frame it asked for.
 */
export function warmupFramePlan(
  frame: number,
  warmup: number,
  temporal: boolean
): number[] {
  const count = warmup + 1
  if (!temporal || warmup === 0) {
    return new Array<number>(count).fill(frame)
  }
  const finalFrame = frame + TEMPORAL_RUNUP
  return Array.from({ length: count }, (_, i) =>
    Math.max(0, finalFrame - warmup + i)
  )
}

/**
 * Whether a renderOnce warm-up should advance the frame, read from the side's
 * LIVE state rather than the case's declaration.
 *
 * `pc.knobs` goes stale when set() toggles the live state, and a
 * pinned-frame temporal warm-up marched one Bayer cell in sixteen: a plate a
 * sixteenth as bright that read as a dim render (0.0069 vs 0.11 at p2).
 */
export function planTemporal(
  side: 'A' | 'B',
  sideA: { temporalUpscale?: boolean } | null | undefined,
  sideB: { temporalUpscale?: boolean } | null | undefined
): boolean {
  const live = side === 'A' ? sideA?.temporalUpscale : sideB?.temporalUpscale
  return live === true
}
