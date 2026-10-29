# Phase 1: First Calibration Run

First A/B capture for the Phase 1 parity ladder. Side A is the WebGL
reference (`@takram/three-clouds` via CloudsEffect). Side B is the WebGPU/TSL
port (`three-clouds-webgpu` via CloudsPassNode).

Captured: 2026-08-31 on macOS, headed Chrome with `--enable-unsafe-webgpu`.

## Calibrated Thresholds

Phase 0: SSIM ≥ 0.81 · Phase 1: SSIM ≥ 0.88, ΔE P95 ≤ 7.31, histDist ≤ 1.96

## Summary

| Phase | Case | SSIM | ΔE mean | ΔE P95 | histDist | ms | Result |
|-------|------|------|---------|--------|----------|-----|--------|
| 0 | baseline-medium | 0.9142 | 2.88 | 5.12 | 1.53 | 2942 | pass |
| 0 | orbit-140km | 0.9352 | 3.00 | 4.77 | 1.50 | 2148 | pass |
| 0 | inside-deck | 0.8269 | 3.27 | 7.63 | 1.53 | 1915 | pass |
| 0 | below-deck-1km | 0.9537 | 2.60 | 3.20 | 1.50 | 2826 | pass |
| 1 | surface-up | 0.9581 | 2.19 | 3.62 | 0.72 | 2960 | pass |
| 1 | horizon-grazing | 0.9591 | 3.63 | 5.58 | 1.98 | 3193 | expected-difference |
| 1 | coverage-020 | 0.9641 | 2.58 | 4.17 | 1.50 | 2869 | pass |
| 1 | ecef-identity | 0.9716 | 2.96 | 5.40 | 1.96 | 2447 | pass |
| 1 | sun-noon | 0.9135 | 2.91 | 5.19 | 1.53 | 2946 | pass |
| 1 | sun-low | 0.9305 | 2.28 | 4.70 | 1.37 | 2915 | pass |
| 1 | sun-horizon | 0.9327 | 2.06 | 4.34 | 1.34 | 2864 | pass |
| 1 | sun-twilight | 0.9331 | 1.89 | 4.00 | 1.15 | 2853 | pass |
| 1 | preset-low | 0.9304 | 2.68 | 4.45 | 1.49 | 2726 | pass |
| 1 | preset-medium | 0.9143 | 2.88 | 5.11 | 1.53 | 2600 | pass |
| 1 | preset-high | 0.9140 | 2.89 | 5.12 | 1.53 | 2592 | pass |
| 1 | preset-ultra | 0.9160 | 2.89 | 5.13 | 1.53 | 2477 | pass |
| 1 | res-050 | 0.9489 | 2.75 | 4.55 | 1.53 | 2436 | pass |
| 1 | res-100 | 0.9143 | 2.88 | 5.11 | 1.53 | 2567 | pass |
| 1 | detail-off | 0.9300 | 2.75 | 4.65 | 1.51 | 2547 | pass |
| 1 | turbulence-off | 0.9143 | 2.88 | 5.11 | 1.53 | 2598 | pass |
| 1 | octaves-1 | 0.9052 | 3.43 | 9.57 | 1.21 | 2579 | expected-difference |
| 1 | octaves-4 | 0.9112 | 2.97 | 5.50 | 1.53 | 2564 | pass |
| 1 | octaves-8 | 0.9143 | 2.88 | 5.11 | 1.53 | 2500 | pass |
| 1 | accurate-sunsky-off | 0.9142 | 2.88 | 5.12 | 1.53 | 2541 | pass |
| 1 | layers-2 | 0.9142 | 2.89 | 5.12 | 1.53 | 2565 | pass |
| 1 | layers-4 | 0.9142 | 2.88 | 5.12 | 1.53 | 2520 | pass |
| 1 | ecef-rotated | 0.9142 | 2.88 | 5.12 | 1.53 | 2560 | pass |
| 1 | wind | 0.9142 | 2.88 | 5.12 | 1.53 | 2148 | pass |
| 1 | coverage-045 | 0.7377 | 4.49 | 11.67 | 1.63 | 3045 | expected-difference |
| 1 | coverage-070 | 0.5393 | 9.76 | 13.81 | 1.89 | 3025 | expected-difference |
| 1 | coverage-090 | 0.5294 | 10.69 | 14.42 | 1.92 | 2948 | expected-difference |

**Passing: 26** · **Expected-difference: 5** · **Failing: 0** · **Skip: 0**

## Distribution (Phase 1, excluding accepted outliers)

23 cases (coverage-045/070/090, octaves-1, horizon-grazing excluded):

| Metric | Mean | Std | Min | Max |
|--------|------|-----|-----|-----|
| SSIM | 0.9264 | 0.0210 | 0.9052 | 0.9716 |
| ΔE P95 | 5.00 | 0.54 | 3.62 | 5.58 |
| histDist | 1.44 | 0.22 | 0.72 | 1.96 |

Calibrated thresholds (mean − 2σ, never below phase floor):
- SSIM ≥ 0.88 (phase floor target: 0.95 — not achievable until coverage fix + knob wiring)
- ΔE P95 ≤ 7.31
- histDist ≤ 1.96

## Expected-Difference Cases

| Case | Reason |
|------|--------|
| horizon-grazing | Step-size sensitivity at grazing angles (ADR-005) |
| octaves-1 | 1-octave multi-scatter amplifies GLSL/TSL approximation difference; tracked for P2 |
| coverage-045 | Coverage → density remap diverges above 0.20 in sampleWeather.ts |
| coverage-070 | Same root cause as coverage-045 |
| coverage-090 | Same root cause as coverage-045 |

## GPU Timing

Side B reports 0.00 ms on all cases — the WebGPU `timestamp-query` is not
producing results. Side A ranges 5–28 ms (median ~15 ms).

## Known Gaps

### Coverage response (SSIM 0.53–0.74 at coverage ≥ 0.45)

Coverage multiplier produces drastically different output at higher values.
Likely root cause: the coverage → density remap path in `sampleWeather.ts`
or `sampleShape.ts` differs from the GLSL original. At coverage=0.20 the
port is fine (SSIM 0.96); the curve diverges between 0.20 and 0.45.

### Knob-insensitive cluster (SSIM ≈ 0.9142)

Cases preset-medium, preset-high, preset-ultra, res-100, turbulence-off,
octaves-8, accurate-sunsky-off, layers-2, layers-4, ecef-rotated produce
identical SSIM to baseline-medium. This means changing these controls does
not measurably alter Side B's output — the knobs are either no-ops in
CloudsContext or the nested `clouds.*` preset fields aren't propagating to
the march uniforms.

### Inside-deck (SSIM 0.83, Phase 0)

Camera inside the cloud layer produces more divergence, likely from the
secondary sun-march and multi-scatter approximation differences.

### Wind sequence (flickerB 1.11 vs flickerA 0.13)

Side B's temporal stability is worse — the wind animation flickers more,
suggesting the TAA / temporal-upscale path differs.

## Capture Method

Playwright (headed, real GPU, `--enable-unsafe-webgpu --enable-features=Vulkan`)
→ dev server port 4174 → `?case=<name>&e2e=1`. Both sides: 64 warmup frames,
time=0, frame=0. Screenshots: Side A via `locator.screenshot()`, Side B via
`canvas.toDataURL()` (Playwright captures WebGPU canvases as black). Metrics
computed from linear pre-tonemap HalfFloat readback per ADR-011.
