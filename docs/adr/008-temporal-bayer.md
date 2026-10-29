# ADR-008 — Temporal upscale: Bayer 1/16 sparse march + depthVelocity + variance-clipped resolve

## Context

The original cloud renderer offers two temporal modes: `temporalUpscale` (Bayer 4×4 sparse march at 1/16 resolution with a multi-frame resolve) and a TAA path that always runs when upscale is off (`cloudsResolve.frag:120–155`). Both rely on `depthVelocity` (transmittance-weighted front depth + screen velocity from reprojection) and variance clipping to reject stale history. This is NOT generic post-process TAA — it is tightly coupled to the cloud march's associated-color output and the Bayer sub-pixel selection.

## Decision

When `temporalUpscale === true`:

1. March target is `ceil(width/4) × ceil(height/4)`. Material's `resolution` is `lowRes × 4`; `targetUvScale` corrects depth reads.
2. Bayer 4×4 selects the sub-pixel per frame: jitter `dx = ((bayerOffsets[frame % 16].x − 0.5) / resolution.x) · 4`, likewise `dy`; projection matrix elements `[8],[9]` offset by `dx·2`, `dy·2`; `mipLevelScale = 0.25`.
3. March writes color + `depthVelocity = vec3(frontDepth, velocity.xy)`. `frontDepth` is the transmittance-weighted mean distance (cloud mass, not scene depth). Velocity from reprojection of the ECEF-front position through the previous view/projection.
4. Resolve at full res: current-frame texels take the fresh sample; others reproject through closest-fragment velocity (3×3 min-depth on `depthVelocity`), reject when `prevUv` leaves [0,1], else variance clipping (9-sample, `varianceGamma = 2`, `temporalAlpha = 0.1`).
5. Second history for shadow length when shafts are on.
6. Shadow cascades may use their own temporal pass.

When `temporalUpscale === false`: full march grid at `resolutionScale`; Bayer jitter zero, `mipLevelScale = 1`; the `temporalAntialiasing` path (a new knob, default true to match side A's always-on TAA) applies the same variance-clipped resolve with `temporalAlpha` blend. Only `temporalAntialiasing = false` bypasses the resolve entirely.

STBN is still indexed by `frame` in both modes. Consumer invalidates history on a seek cut via `resetHistory()`.

## Consequences

- `src/resolve/bayer.ts` and `src/resolve/cloudsResolve.ts` implement the Bayer march, the depthVelocity attachment and the resolve pass.
- Parity cases must warm up both sides with identical `frame` sequences before readback (ADR-011 warm-up rule).
- The `temporalAntialiasing = false` mode is a documented parity gap vs side A's always-on TAA, pinned in the harness.
- `depthVelocity.r` is stored in unit space, never metres.

## References

- `CloudsPass.ts:209–217` (upscale target size)
- `CloudsMaterial.ts:338–416` (Bayer jitter, mipLevelScale, targetUvScale)
- `clouds.frag:614–615, 944–974` (frontDepth, velocity)
- `cloudsResolve.frag:63–177` (both resolve paths)
- `CloudsResolveMaterial.ts:77–78` (varianceGamma, temporalAlpha)
- ADR-011 (warm-up rule)
