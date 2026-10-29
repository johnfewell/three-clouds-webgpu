# ADR-003 — Time and frame are plain settable numbers; wind is a function of time, not an accumulator

## Context

The original integrates `offset += velocity * deltaTime` every `update` (`CloudsEffect.ts:348–357`), which is order-dependent and not seek-safe. `frame` is a private counter incremented in `update` (`CloudsEffect.ts:478`). The original's `mipLevelScale`/Bayer jitter read `frame % 16` (`CloudsMaterial.ts:339–341`), STBN reads `frame % size.z` (`clouds.glsl:4`).

The original's `skipRendering` (`CloudsEffect.ts:505–506`) is not a disable switch — it only skips `CloudsEffect`'s own composite because `AerialPerspectiveEffect.overlay` composites the layer. The port has a single composite path, so `skipRendering` is intentionally dropped.

## Decision

- `clouds.time: number` drives weather/wind evolution. `clouds.frame: number` drives Bayer phase (`frame % 16`), STBN slice (`frame % size.z`), and temporal cadence. The library takes no clock, fps, or `deltaTime`; a consumer sets both.
- Wind offsets are derived: `localWeatherOffset = localWeatherBaseOffset + localWeatherVelocity * time` (likewise `shapeOffset`, `shapeDetailOffset`). Any `time` renders the same weather regardless of how it was reached (seek-safe, order-independent).
- `CloudsPassNode` owns the previous view/projection matrices for the velocity
  term and stores them after each render.
- `enabled: boolean` (new, no WebGL equivalent): when false the pass does not render and `composite(dst)` returns `dst` unchanged. `enabled` is a graph-time flag — `composite()` compiles to a pass-through and the march drops out of the graph; a runtime toggle rebuilds through `CloudsContext.graphVersion`, and re-enabling resets temporal history. `resetHistory()` is exposed on `CloudsContext`.

Stable `time` + `frame` ⇒ stable pixels. A capture sets both from its own deterministic clock.

## Consequences

- The WebGL-named `localWeatherOffset` / `shapeOffset` / `shapeDetailOffset` properties remain as base offsets; the shader uniform is base + velocity * time, computed in `CloudsContext` on update.
- `resetHistory()` is the only cut-handling API; the library never detects seeks
  itself.
- Side A (original) must be driven with `deltaTime = delta-time` so its accumulated offset equals side B's `velocity * time`; the harness resets side A's offsets when `time` seeks backwards.
- `frame` on side A is private: the harness patches it via a subclass or renders exactly `frame` times from a reset.

## References

- `reference/clouds/src/CloudsEffect.ts:348–357, 478, 505–506`
- `reference/clouds/src/CloudsMaterial.ts:339–341, 393–398`
- `reference/clouds/src/shaders/clouds.glsl:4`
- ADR-008 (temporal upscale — Bayer phase from `frame`)
