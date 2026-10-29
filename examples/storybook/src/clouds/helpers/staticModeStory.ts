// The Static Mode story's clock and its HUD's reading of the pass

// Static mode compares ctx.time, so a clock that ticks every frame is an input
// change every frame and nothing is ever skipped. The story's own motion
// toggle advances time when it wants the clouds to move
export const STATIC_MODE_STORY_TIME_SCALE = 0

// A skipped frame records no render, so the tracker's count stands still. A
// count pinned at 1 is a render every frame on changing inputs, not a skip
export function staticFrameSkipped(
  previousRenderedFrames: number,
  renderedFrames: number,
  enabled: boolean
): boolean {
  return (
    enabled && renderedFrames > 1 && renderedFrames === previousRenderedFrames
  )
}
