# Parity Harness

Visual-parity testing between the WebGL reference (Side A) and the WebGPU/TSL port (Side B).

## `metrics.json` Schema

Each capture writes a `metrics.json` file to `parity/results/<phase>/<case>/`:

```jsonc
{
  "metricsVersion": 4,    // Metric definitions this file was written against.
                          // A file at an older version is NOT comparable to
                          // today's thresholds — `verify-results.mjs` fails it
                          // with "stale metrics … re-capture".

  "ssim": 0.9823,        // Structural Similarity (Wang et al. 2004)
                          // Gaussian window σ = 1.5 px on linear luminance.
                          // C1/C2 use side A's robust luminance span as the
                          // dynamic range L, not a fixed 1.0.
                          // Range [−1, 1]; 1 = identical

  "deMean": 1.42,         // ΔE2000 mean across all pixels
                          // CIE ΔE2000 (Sharma, Wu, Dalal 2005)
                          // Computed on linear RGB → D65 Lab

  "deP95": 3.87,          // ΔE2000 95th-percentile

  "histDist": 0.0231,     // Luminance-distribution distance: Wasserstein-1
                          // between the luminance CDFs, ÷ mean(A).
                          // An exposure error ×k scores exactly |k − 1|.

  "shadedFraction": {     // shadow cases only, null otherwise.
    "A": { "fraction": 0.2131, "meanOn": 0.081, "meanOff": 0.093,
           "rise": 0.129, "classified": 786432 },
    "B": { "fraction": 0.2074, "...": "..." },
    "ratio": 0.973,       // B.fraction / A.fraction — floor 0.85, hard fail
    "flagsOff": { "A": [false, false], "B": [false] },   // what setShadow(false)
    "flagsRestored": { "A": [true, true], "B": [true] }, // RETURNED — a receipt,
    "reasons": []         // not a hope. Plate must brighten on both sides.
  },

  "gpuMs": {              // GPU timing per side (from parity-gpu-timing)
    "A": { "total": 4.2 },
    "B": { "total": 3.8 }
  },

  "size": [1024, 768],    // Capture dimensions [width, height]
  "time": 0.0,            // Scene time at capture
  "frame": 64,            // Frame index at capture (after warm-up)
  "warmup": 64,           // Warm-up frames rendered before capture

  "env": {                // Environment of the capture run
    "chrome": "128.0",
    "adapter": "Apple M2 Pro",
    "os": "darwin",
    "gpu": "hardware"     // "hardware" | "software" (SwiftShader)
  }
}
```

### Metric definitions

All three are computed on the **linear pre-tonemap readback** (ADR-011), never on
`toDataURL` output. Side A (WebGL) is the reference and sets the scale.

| Metric | Definition | Validated by |
|---|---|---|
| `ssim` | Wang et al. 2004, Gaussian window σ = 1.5 on Rec.709 luminance. `C1 = (0.01·L)²`, `C2 = (0.03·L)²` where **`L` is the ladder reference dynamic range 0.09** for every case (v4). Side A's own robust span (0.5–99.5 percentile) still drives the diagnostic `ssimAttribution.ssimAtMeasuredL`. | identity, bounds, σ=1.5 unit-sum window, near-zero on uncorrelated plates at every contrast and brightness |
| `deMean` / `deP95` | CIE ΔE2000 per pixel on linear RGB → D65 Lab. `deP95` is index `floor(0.95·n)` of the ascending sort (nearest-rank). | **all 34 Sharma, Wu & Dalal (2005) reference pairs to 1e-4** |
| `histDist` | Wasserstein-1 between the two luminance CDFs, divided by `mean(A)`: `Σ\|sortedA[i] − sortedB[i]\| / n / mean(A)`. | exposure law, coverage law, linearity, scale-freedom |
| `shadedFraction` | Per side, the fraction of classified pixels (lit plate luminance > 1e-4) whose luminance with the casters ON is < 0.98 × the same pixel with the casters OFF; `ratio = B / A`. Taken by the runner for shadow cases via `window.__parity.setShadow(false)` → render both sides → `setShadow(true)`; the setter returns the flags it wrote. | full shadow → 1, on = off → 0, sub-margin darkening not counted, black sky not classified, 3-channel stride, the three refusals (flags not off, no plate rise, ratio < 0.85) |

`histDist` **replaced a 256-bin normalised L1** in the ADR-011 amendment of
2026-08-31. L1 has no notion of bin
adjacency, so it saturated toward its 2.0 ceiling as soon as two supports
stopped overlapping. A linear plate living in 0.02–0.13 with σ ≈ 0.01 occupies
~15 of 256 bins, so the ~3-bin shift of a 10 % exposure difference already read
1.4 on pairs whose means agreed to 10 %. It was measuring exposure, not shape.

The Wasserstein form makes the design floor derivable rather than arbitrary:

| Difference between the plates | `histDist` |
|---|---|
| Uniform exposure error ×k | exactly `\|k − 1\|` |
| 10 % exposure shift | **0.100** — precisely the `≤ 0.1` phase floor |
| `--sabotage exposure` (×2) | **1.000** — 10× the floor |
| Coverage difference Δc, cloud/sky contrast ΔL | `Δc · ΔL / mean(A)` |
| 50 % coverage difference at the ladder's own contrast (ΔL ≈ 0.037, mean ≈ 0.10) | **≈ 0.18** — fails the floor |

Because it is normalised by side A's mean, one threshold covers a bright orbit
plate and a dim twilight plate alike: the same 10 % relative error scores 0.100
on both. The normalisation is deliberately asymmetric — A is the reference.

### Why SSIM's `L` is the ladder reference, and the measured span is reported beside it

Since `metricsVersion` 4 (ADR-011 Amendment 3) the **gated** `ssim`
uses `L = 0.09`, the robust span the phase-1 ladder clusters at. Measuring `L`
per case (v3) made the pass bar scale inversely with frame content: `C2` shrinks
with a near-empty frame, so the same small difference field that costs nothing
on a textured plate costs most of the structure term there — 84 % of
`coverage-020`'s deficit was the stabiliser, not the port. The measured-`L`
number is still computed (`computeSSIMAtMeasuredL`) and written as
`ssimAttribution.ssimAtMeasuredL`; it is the sensitivity diagnostic and never
the gate. The trade is deliberate and visible: on plates darker than the
reference the gated `ssim` is less sensitive to structure, and the plate check
carries the black/flat regime.

### Why SSIM's `L` was measured, not fixed (v3 — now the diagnostic)

`L` in `C1 = (0.01·L)²` / `C2 = (0.03·L)²` is the **dynamic range of the data** —
that is what Wang et al. mean by it, and why 8-bit images use 255. Fixing
`L = 1.0` was wrong for a metric computed on the linear pre-tonemap readback: a
cloud plate occupies ~0.02–0.13 with local variance ~1e-4, so `C2 = 9e-4` swamped
the variance it was meant to stabilise, pinned the contrast/structure term near 1
and left SSIM reporting little more than its luminance term.

Measured on plates with **identical statistics and zero correlation** — true
structural similarity 0 in every row:

| local σ | fixed `L = 1.0` | sRGB-encoded, `L = 1.0` | `L = span(A)` |
|---|---|---|---|
| 0.002 | 0.9915 | 0.9767 | **0.0002** |
| 0.005 | 0.9494 | 0.8703 | **0.0003** |
| 0.010 | 0.8251 | 0.6276 | **0.0003** |
| 0.020 | 0.5445 | 0.2946 | **0.0003** |
| 0.050 | 0.1704 | 0.0515 | **−0.0011** |

Encoding to sRGB first was the other candidate and was **rejected on this
evidence**: it only stretches the values, still reports 0.98 for uncorrelated
content at σ = 0.002, and — because sRGB compresses highlights — it *weakens* the
exposure response, scoring the ×2 sabotage at 0.9313 where the linear forms score
0.64–0.74.

Two consequences worth knowing:

- **SSIM is reference-relative, not symmetric.** `L` comes from side A, so
  `computeSSIM(a, b) ≠ computeSSIM(b, a)` in general. This is deliberate and is
  the safe direction for a gate: taking `L` from both sides would let a blown-out
  side B widen `L` and mask its own error. Capture always passes `(A, B)`.
- **Historical note.** At `c84e3db`, `parity/results/1/ecef-identity` scored
  0.9716 — phase 1's *highest* — while side B marched no clouds and side A was
  flat. A synthetic stand-in with those statistics now scores **−0.0014**.

### Threshold evaluation

`evaluate(metrics, phaseThresholds)` returns `'pass'`, `'expected-difference'`, or `'fail'`:

| Metric     | Condition       | Result on breach |
|------------|-----------------|------------------|
| `ssim`     | `< threshold`   | fail             |
| `deP95`    | `> threshold`   | fail             |
| `histDist` | `> threshold`   | fail             |

A failing case whose name matches an entry in `thresholds.json`'s `accepted` array is downgraded to `'expected-difference'`.

Three checks run **before** `accepted[]` and are never downgraded:

- **plate check** — a black or flat side, or a side B that marched no clouds at
  all. Rejected outright, never counted as a pass.
- **metrics version** — a `metrics.json` whose `metricsVersion` is not the
  current one. Its `histDist` was computed under a superseded definition and
  cannot be compared to today's threshold, so it fails with
  `stale metrics … re-capture` rather than being silently re-graded.
- **shaded-fraction receipt** (ADR-011 Amendment 4) — for a case
  whose `metrics.json` carries a `shadedFraction` block: the probe's
  `setShadow(false)` must have *returned* all-off flags on both sides, the
  plate must have brightened on both sides with the casters off (otherwise
  the knob was inert and the fraction is a fraction of nothing), and B's
  shaded fraction must be ≥ 0.85 of A's — and side A must shade at least
  **1 %** of the plate for the ratio to mean anything (two near-zero fractions
  divide to a large ratio that passes a *minimum* from above: `ground-bounce-on`
  read A 0.00 % / B 0.02 %, ratio 10.7). Below that the receipt reads
  `no shadow in frame` and fails. A case whose `shadow: true` is a
  prerequisite rather than the subject, or whose subject *is* the atlas (the
  debug views go dark, not bright, with the casters off), **declares**
  `shadedFractionReceipt: { skip: reason }` in the registry; the runner writes
  `{ "skipped": reason }` and a declared skip is covered — silence is not.
  SSIM at the reference `L` shipped a 90 % shadow loss green
  (`layers-4-shadow`, 21 % → 2 %); this is the metric that sees it.

## Metrics module

Pure functions in `src/metrics/`, usable in both Node (capture scripts) and the browser (live readout):

- `computeSSIM(bufA, bufB, w, h, channels?)` — SSIM over a σ=1.5 Gaussian window
- `computeDeltaE(bufA, bufB, w, h, channels?)` — per-pixel ΔE2000 with mean/P95/max
- `computeHistogramDistance(bufA, bufB, w, h, channels?)` — mean-normalised Wasserstein-1
- `evaluate(metrics, thresholds, caseName?, accepted?, plateCheck?)` — threshold gate
- `checkPlate(check)`, `checkMetricsVersion(version)`, `METRICS_VERSION` — the non-downgradeable gates
- `luminance(r, g, b)`, `linearRgbToLab(r, g, b)`, `deltaE2000(...)` — color utilities

`src/metrics/evaluator.mjs` is the single runtime implementation of `evaluate`,
`checkPlate`, `checkMetricsVersion`, and `METRICS_VERSION`. The TypeScript
facade, capture runner, and committed-results verifier all import it directly;
`evaluator.d.mts` supplies their shared types.

A **fourth** file encodes the metrics.json *shape* rather than those functions:
`src/capture/metricsWriter.ts` (`MetricsSchema`, `formatMetricsJson`,
`validateMetricsJson`). `capture.mjs` writes its object inline and never calls
it, so its writer functions have no caller but their own test — which is why its
schema silently fell behind the `metricsVersion` bump. Its types are
not dead: `gridPage.ts` and `gridData.ts` import `MetricsSchema` / `GpuMsSchema`
from it. A schema change lands there too — `MetricsSchema` and the `required`
list — and `METRICS_VERSION` is imported from `src/metrics`, never redeclared.

Validation lives in `src/metrics/validation.test.ts`: each metric against its
documented definition on synthetic buffers whose answer is known analytically.
Run it with `TEST_LOG=1` to print the computed-vs-expected tables.

## Read-only shadow-atlas comparison

`scripts/atlasDiff.mjs` reads side A's raw shadow atlas and side B's at one
case's own pose and sun, per cascade and per channel, and writes
`test-results/atlas-diff/<case>/atlas-pair.json`. It never writes
`parity/results`. Side A's lane is `probe.readShadowAtlasA()`
(`src/shadowAtlasReadback.ts`): a `framebufferTextureLayer` + `readPixels` per
array layer, because side A's atlas is a `WebGLArrayRenderTarget` where side B's
is read through three's async reader.

The comparison is worth a lane of its own because a composited plate cannot do
it: the aerial post-lighting factor `K` and the optical depth enter only as
`K * exp(-od)`, so one plate reads equally as "B's optical depth is 15× larger"
and as "K differs 15×".

Channel conventions, which differ and are the reason the raw values cannot be
compared without saying so:

| channel | meaning | side A | side B |
| --- | --- | --- | --- |
| r | `frontDepth` | metres | unit space (`metres * worldToUnit`) |
| g | `meanExtinction` | per metre | per metre |
| b | `maxOpticalDepth` | dimensionless | dimensionless |
| a | `maxOpticalDepth * opticalDepthTailScale` | dimensionless | dimensionless |

```sh
PARITY_URL=http://127.0.0.1:5243 node scripts/atlasDiff.mjs shadow-cascades-2x512
```

The ground optical depth the reference formula implies is
`min(b, g * max(0, distanceToTop - frontDepth))`, so the readback's consumer
reports which branch binds per cascade: that is the finding, not the mean.
