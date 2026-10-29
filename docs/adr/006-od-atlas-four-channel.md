# ADR-006 — Optical-depth shadow atlas: four channels, two samplers, cascade descriptor

## Context

Cloud self-shadows in the original are a sun-view cascaded atlas (`DataArrayTexture`, one layer per cascade) whose texels encode front depth, mean extinction, max optical depth, and an optical-depth tail term. Two distinct samplers — one for in-cloud queries (includes the tail) and one for ground/aerial queries (ignores the tail) — read the same atlas with different formulas. The tail exists because a large amount of OD accumulates beyond the early-termination point (discussion: https://x.com/shotamatsuda/status/1886259549931520437).

This is not three's `CascadedShadowMapsNode` (which extends `CSMShadowNode` for mesh-depth cascades). Only the CPU split-frustum math is shared.

## Decision

The atlas texel is (`clouds.frag:178`, `shadow.frag:122–125`):

```text
vec4(
  frontDepth,           // r  transmittance-weighted mean distance from cascade near plane
  meanExtinction,       // g  extinctionSum / sampleCount
  maxOpticalDepth,      // b  Σ extinction · stepSize
  maxOpticalDepthTail   // a  min(opticalDepthTailScale · stepSize · e^(1 − sampleCount), stepSize · 0.5)
)
// no samples: vec4(maxRayDistance, 0, 0, 0)
```

Two samplers — port both, never merge:

```text
// In-cloud (clouds.frag:172–183 readShadowOpticalDepth):
distanceToFront = max(0, distanceToTop − distanceOffset − shadow.r)
od = min(shadow.b + shadow.a, shadow.g * distanceToFront)

// Ground/aerial (aerialPerspectiveEffect.frag ~177–183):
od = min(shadow.b, shadow.g * max(0, distanceToTop − shadow.r))
```

Cascade descriptor:
```ts
{ map: DataArrayTexture, mapSize: Vector2, cascadeCount: number,
  intervals: Vector2[], matrices: Matrix4[], inverseMatrices: Matrix4[],
  far: number, topHeight: number }
```

Per-layer: only `CloudLayer.shadow === true` layers contribute.

PCF: `SHADOW_SAMPLE_COUNT` (default 8, max 16) taps on a Vogel disk with interleaved-gradient-noise rotation, radius scaled by `remapClamped(dot(sunDirection, surfaceNormal), 0.1, 0.0)`.

Units: the port writes `.r` (front depth) and the no-sample sentinel in unit space (`× worldToUnit`). `.g` (mean extinction per metre), `.b`, `.a` (optical depth) are unchanged; both samplers convert `.r` back once before their distance subtraction.

## Consequences

- `src/shadow/opticalDepthMarch.ts` builds the atlas, `src/shadow/shadowResolve.ts` the cascade temporal pass, and the in-cloud and ground samplers the two reads.
- The atlas motion matches the visible march (same time/frame weather field) so shadows register with clouds and captures reproduce.
- Unit-space `.r` prevents fp16 overflow that the original's metre-space sentinel (`1e6`) would cause.

## References

- `clouds.frag:172–219` (samplers + PCF)
- `shadow.frag:105–145` (atlas write + tail)
- `CloudsEffect.ts:421–431` (descriptor bridge)
- https://x.com/shotamatsuda/status/1886259549931520437 (tail discussion)
