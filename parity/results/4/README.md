# Full committed ladder

Per-case record of every committed `metrics.json` under `parity/results/`,
grouped by phase. Numbers are the values stored in those files on origin/main, from the final full-ladder capture run.

## Provenance

| Field | Value |
|---|---|
| Captured on | `45179204` (detached HEAD in the isolated worktree `clouds-ladder-45179204`; `dirty 2`, both outside the receipt key paths: the key at capture equals the commit's key) |
| Served `build/shared.js` | `2d7a39905a24` (= built on all 63 cases; servedIsBuilt true) |
| Receipt key | `15d2b8857dbd` (`parity/results/e2e-receipt.json`: unfiltered, 128/128 passed, dirty false; the same key recomputes at 45179204 and at 3913a96f, 272 inputs) |
| Adapter / runner | `apple metal-3`, Chrome 153, hardware (from `metrics.json.env`) |
| Capture window | 2026-09-24, after the receipt run ended (19:15:54Z) and before the ladder commit (19:29:43Z); the capture logs carry no timestamps |
| Includes | B `shadow.updateInterval` pinned to 1, and ADR-015 |

`[verify] summary: 59 pass, 4 expected-difference, 0 fail`

That line is the summary from `node scripts/verify-results.mjs` run on this
tree. Each case is graded at its own phase's bar in `thresholds.json`
(`phases`), so `Bar` below is the threshold that graded the row.

## Accepted non-parity register

Full reasons are in `examples/parity/cases/thresholds.json` `accepted[]`.
A row below its floor fails as beyond the accepted footprint.

| Case | ADR | Floor (ssim) | Measured SSIM | Result |
|---|---|---:|---:|---|
| `procedural-textures` | ADR-014 | 0.696443 | 0.696664 | expected-difference |
| `layers-4-shadow` | ADR-015 | 0.971478 | 0.971489 | pass at 0.95; entry not engaged [^l4s] |
| `debug-cascades` | ADR-011 Amendment 6 | — | 0.978116 | expected-difference |
| `debug-sample-count` | ADR-011 Amendment 6 | — | 0.815794 | expected-difference |
| `debug-front-depth` | ADR-011 Amendment 6 | — | 0.969062 | expected-difference |

## Registry cases without a committed capture

| # | Case | Status |
|---:|---|---|
| 52 | `world-tiles` | look-only; runs only with `PARITY_GOOGLE_TILES_KEY` (not captured in this ladder) |
| 53 | `ortho-camera` | retired: the reference's ray construction is perspective-only |
| 54 | `webgl2-backend` | look-only; `hardwareSkip: 'WebGL2 backend not available'` (p4 e2e 8 passes 2/2 in the receipt: side B refuses WebGL2 with the documented message) |

Capture images are local-only. They are gitignored and are not part of this
record.

The gpuMs column is `gpuMs.sideA.medianMs` / `gpuMs.sideB.medianMs`. A
per-pass-per-side breakdown is deferred to a later attribution pass (ruled
2026-09-24 02:13Z).

## Phase 0

| Case | Phase | Bar | SSIM | deP95 | histDist | Result | gpuMs |
|---|---:|---:|---:|---:|---:|---|---|
| baseline-medium | 0 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 20.55 / B 89.7 |
| orbit-140km | 0 | 0.95 | 0.975367 | 1.19 | 0.032688 | pass | A 2.54 / B 2.1 |
| inside-deck | 0 | 0.95 | 0.99359 | 0.94 | 0.015022 | pass | A 3.04 / B 2.74 |
| below-deck-1km | 0 | 0.95 | 0.993468 | 1.09 | 0.099834 | pass | A 12.82 / B 60.33 |

## Phase 1

| Case | Phase | Bar | SSIM | deP95 | histDist | Result | gpuMs |
|---|---:|---:|---:|---:|---:|---|---|
| surface-up | 1 | 0.95 | 0.995623 | 0.52 | 0.049678 | pass | A 11.94 / B 64.81 |
| horizon-grazing | 1 | 0.95 | 0.993462 | 1.28 | 0.027169 | pass | A 30.74 / B 119.69 |
| sun-noon | 1 | 0.95 | 0.985348 | 0.98 | 0.025596 | pass | A 24.76 / B 89.27 |
| sun-low | 1 | 0.95 | 0.985967 | 0.76 | 0.025373 | pass | A 23.28 / B 88.97 |
| sun-horizon | 1 | 0.95 | 0.986349 | 0.67 | 0.025679 | pass | A 24.94 / B 88.93 |
| sun-twilight | 1 | 0.95 | 0.986532 | 0.61 | 0.025984 | pass | A 25.51 / B 87.49 |
| coverage-020 | 1 | 0.95 | 0.993779 | 0.95 | 0.025271 | pass | A 22.15 / B 51.83 |
| coverage-045 | 1 | 0.95 | 0.978018 | 1.53 | 0.026667 | pass | A 25.38 / B 112.19 |
| coverage-070 | 1 | 0.95 | 0.971346 | 2.24 | 0.039105 | pass | A 25.65 / B 127.47 |
| coverage-090 | 1 | 0.95 | 0.970247 | 2.22 | 0.042206 | pass | A 26.1 / B 120.02 |
| preset-low | 1 | 0.95 | 0.986734 | 0.97 | 0.024684 | pass | A 23.93 / B 87.87 |
| preset-medium | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 24.18 / B 89.1 |
| preset-high | 1 | 0.95 | 0.984495 | 0.97 | 0.025558 | pass | A 24.9 / B 92.9 |
| preset-ultra | 1 | 0.95 | 0.985017 | 0.97 | 0.025472 | pass | A 27.15 / B 91.43 |
| res-050 | 1 | 0.95 | 0.988916 | 0.96 | 0.024846 | pass | A 18.47 / B 41.29 |
| res-100 | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 24.44 / B 87.54 |
| detail-off | 1 | 0.95 | 0.987194 | 0.97 | 0.025002 | pass | A 26.58 / B 87.59 |
| turbulence-off | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 23.17 / B 88.78 |
| octaves-1 | 1 | 0.95 | 0.984934 | 1.07 | 0.027408 | pass | A 23.04 / B 89.72 |
| octaves-4 | 1 | 0.95 | 0.985465 | 0.98 | 0.025829 | pass | A 23.41 / B 88.56 |
| octaves-8 | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 24.88 / B 87.43 |
| accurate-sunsky-off | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 24.5 / B 89.14 |
| layers-2 | 1 | 0.95 | 0.988344 | 0.97 | 0.025491 | pass | A 21.97 / B 64.43 |
| layers-4 | 1 | 0.95 | 0.982315 | 0.97 | 0.025234 | pass | A 28 / B 105.05 |
| ecef-identity | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 21.43 / B 89.65 |
| ecef-rotated | 1 | 0.95 | 0.982714 | 0.98 | 0.025382 | pass | A 20.24 / B 92.11 |
| wind | 1 | 0.95 | 0.985291 | 0.97 | 0.025579 | pass | A 26.31 / B 89.06 |
| polar-altitude-corrected | 1 | 0.95 | 0.987189 | 0.9 | 0.033893 | pass | A 25.12 / B 90.6 |
| polar-altitude-uncorrected | 1 | 0.95 | 0.986831 | 0.93 | 0.036158 | pass | A 24.42 / B 89.52 |

## Phase 2

| Case | Phase | Bar | SSIM | deP95 | histDist | Result | gpuMs |
|---|---:|---:|---:|---:|---:|---|---|
| temporal-on-static | 2 | 0.95 | 0.957249 | 0.99 | 0.024533 | pass | A 16.49 / B 27.91 |
| temporal-on-orbit | 2 | 0.95 | 0.969347 | 1.17 | 0.031129 | pass | A 17.4 / B 27.53 |
| temporal-on-wind | 2 | 0.95 | 0.957249 | 0.99 | 0.024533 | pass | A 17.13 / B 28.04 |
| temporal-cut | 2 | 0.95 | 0.957249 | 0.99 | 0.024533 | pass | A 16.37 / B 28 |

## Phase 3

| Case | Phase | Bar | SSIM | deP95 | histDist | Result | gpuMs |
|---|---:|---:|---:|---:|---:|---|---|
| layers-4-shadow | 3 | 0.95 [^l4s] | 0.971489 | 1.6 | 0.039679 | pass [^l4s] | A 25.64 / B 111.03 |
| shadow-plane | 3 | 0.95 | 0.980474 | 1.25 | 0.037148 | pass | A 25.85 / B 91.78 |
| shadow-sphere | 3 | 0.95 | 0.970018 | 2.43 | 0.04005 | pass | A 22.13 / B 94.28 |
| shadow-both-moving | 3 | 0.95 | 0.980474 | 1.25 | 0.037148 | pass | A 24.36 / B 94.02 |
| shadow-cascades-2x512 | 3 | 0.95 | 0.973471 | 1.43 | 0.0364 | pass | A 27.73 / B 96.49 |
| shadow-cascades-4x1024 | 3 | 0.95 | 0.97956 | 1.26 | 0.03134 | pass | A 34.94 / B 130.8 |
| shafts-low-sun | 3 | 0.95 | 0.973426 | 1.86 | 0.062698 | pass | A 44.63 / B 120.49 |
| shafts-inside-deck | 3 | 0.95 | 0.964489 | 1.84 | 0.035181 | pass | A 45.79 / B 117.1 |
| shafts-orbit-off | 3 | 0.95 | 0.980474 | 1.25 | 0.037148 | pass | A 25.39 / B 93.4 |
| shadow-temporal | 3 | 0.95 | 0.96772 | 1.26 | 0.039611 | pass | A 17.73 / B 30.14 |
| sun-grazing | 3 | 0.95 | 0.986288 | 0.69 | 0.02551 | pass | A 25.78 / B 89.02 |
| shadow-grazing | 3 | 0.95 | 0.981824 | 1.2 | 0.041291 | pass | A 27.11 / B 94.92 |
| inside-deck-low-sun | 3 | 0.95 | 0.995396 | 0.68 | 0.013054 | pass | A 29.38 / B 90.8 |
| shadow-sphere-neutral | 3 | 0.95 | 0.984151 | 0.85 | 0.062683 | pass | A 24.82 / B 87.83 |
| sky-horizon-low-sun | 3 | 0.95 | 0.985599 | 1.82 | 0.03543 | pass | A 18.55 / B 63.4 |
| shafts-sky-horizon | 3 | 0.95 | 0.974414 | 3.09 | 0.062536 | pass | A 36.25 / B 91.21 |

## Phase 4

| Case | Phase | Bar | SSIM | deP95 | histDist | Result | gpuMs |
|---|---:|---:|---:|---:|---:|---|---|
| haze-on | 4 | 0.98 | 0.995633 | 0.52 | 0.049819 | pass | A 12.13 / B 65.34 |
| ground-bounce-on | 4 | 0.98 | 0.98643 | 1.14 | 0.08176 | pass | A 14.87 / B 69.83 |
| draine-phase | 4 | 0.98 | 0.985038 | 1 | 0.0269 | pass | A 24.47 / B 89.18 |
| procedural-textures | 4 | 0.98 | 0.696664 | 5.2 | 0.023358 | expected-difference | A 25.93 / B 90.92 |
| log-depth | 4 | 0.98 | 0.98529 | 0.97 | 0.025587 | pass | A 23.89 / B 88.35 |
| debug-cascades | 4 | 0.98 | 0.978116 | 2.79 | 0.035459 | expected-difference | A 24.25 / B 95.47 |
| debug-shadow-map | 4 | 0.98 | 0.984992 | 3.16 | 0.011027 | pass | A 15.69 / B 25.72 |
| debug-checker-uv | 4 | 0.98 | 0.989138 | 0.02 | 0.002401 | pass | A 16.05 / B 23.99 |
| debug-sample-count | 4 | 0.98 | 0.815794 | 19 | 0.195823 | expected-difference | A 17.55 / B 28.02 |
| debug-front-depth | 4 | 0.98 | 0.969062 | 0.58 | 0.000704 | expected-difference | A 17.77 / B 32.05 |

[^l4s]: `layers-4-shadow` is a phase-3 case and verify-results grades it at the
    phase-3 bar of 0.95. The 0.98 figure is the bar for the later cases,
    waived by ADR-015. The ADR-015 `accepted[]` entry records the measured
    footprint (floor 0.971478) and engages only if the case is ever graded at
    0.98 (ruled 2026-09-24).
