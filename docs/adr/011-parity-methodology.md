# ADR-011 — Parity methodology

## Context

The port must demonstrate visual equivalence with the original `@takram/three-clouds@0.7.6` WebGL implementation. Canvas screenshots (`toDataURL`) lose precision and conflate tone mapping with rendering accuracy. The two renderers (WebGL vs WebGPU) have inherent floating-point and filtering differences, so pixel-identical output is not expected — the methodology must quantify similarity and define thresholds.

## Decision

**Artifacts per case.** For every parity ladder case, both sides render the same `time`, `frame`, camera, sun, and knobs at the same resolution:

| Artifact | Content |
|---|---|
| `A.png`, `B.png` | Display output, identical tone mapping (`NeutralToneMapping`, exposure 1), sRGB |
| Linear readback | Scene-referred RGBA `HalfFloatType` buffer after cloud composite, before tone mapping — read via `renderer.readRenderTargetPixelsAsync`. Never `canvas.toDataURL`. |
| `diff.png` | Amplified absolute difference + heat overlay |
| `metrics.json` | Gaussian-blurred SSIM (σ = 1.5 px), mean and 95th-percentile ΔE2000, luminance-histogram distance, GPU ms per pass per side |
| Temporal cases | 16-frame sequence after warm-up, flicker metric (mean frame-to-frame ΔE), ghosting check |

**Thresholds.** In `examples/parity/cases/thresholds.json`: SSIM ≥ 0.95 for the
early cases (medium preset, synthetic scene), raised to ≥ 0.98 once the later
cases are in. Recalibrate after the first green ladder. Known accepted non-parity (float precision, 3D texture filtering, Bayer phase alignment, dither patterns, the original's always-on TAA) is listed in the same file.

**Frozen-feature neutralisation.** Side A runs later-phase features by default. Every case pins all graph-time features explicitly on both sides and turns later-phase features off: `haze = false`, `maxIterationCountToGround = 0`, `cloudLayers[i].shadow = false`, `lightShafts = false`, `temporalUpscale = false`, `accuratePhaseFunction = false`, `debug = 'none'`. Side A receives this state before its first `update`.

**Warm-up rule.** Side A's resolve always runs TAA (α = 0.1). Every still renders `warmup` (default 64) identical frames on both sides before readback, converging TAA geometrically. `metrics.json` records `warmup`.

**GPU timing.** `EXT_disjoint_timer_query_webgl2` on side A, `timestamp-query` on side B, per pass, median of 32 frames, discarding disjoint samples.

**Artifact rules.** `*.linear.bin` readbacks never committed. `A.png`/`B.png`/`diff.png` are local capture output, gitignored and not committed (amended 2026-09-23: these were previously committed via git LFS). `metrics.json` includes `env`, `warmup`, `size`, `time`, `frame`. `capture.log` committed as evidence. CI re-validates committed metrics against `thresholds.json` via `scripts/verify-results.mjs`.

## Amendment — 2026-08-31: metric definitions validated

The first ladder on which side B actually rendered clouds (31 cases)
produced `histDist` 0.66–1.96 on **every** pair, including pairs whose linear
luminance means agreed to ~10 %, while SSIM sat at 0.91–0.975. Validating each
metric against its documented definition showed two of the three were not
measuring what the table above claims.

**1. `histDist` is redefined: mean-normalised Wasserstein-1, not 256-bin L1.**

The original 256-bin normalised L1 over linear luminance in [0, 1] measured bin
identity, not distance — L1 has no notion of bin adjacency, so it saturates
toward its 2.0 ceiling the moment two supports stop overlapping. A linear cloud
plate occupies 0.02–0.13 with σ ≈ 0.01, i.e. ~15 of 256 bins, so the ~3-bin
shift of a 10 % exposure difference already scored 1.4. The metric was reading
exposure, and saturating while doing it.

Rebinning would not have fixed it. sRGB-encoding the values (option a) and
log-luminance with an adaptive range (option c) are both monotone and locally
near-linear, so each stretches the shift and the spread by the same factor: the
shift-to-spread ratio that drives L1 saturation is preserved. Only replacing the
*distance* helps.

The new definition, with both plates' luminances sorted ascending (equal pixel
counts, so the sorted arrays are the quantile functions sampled at the same
points):

    W1       = (1/n) · Σ |sortedA[i] − sortedB[i]|
    histDist = W1 / mean(A)

This satisfies ADR-011's intent — catch a global tonal/exposure mismatch without
saturating on a 10 % shift — and makes the design floor follow from the
definition instead of being picked:

| Difference | `histDist` |
|---|---|
| Uniform exposure error ×k | exactly `\|k − 1\|` (no ceiling) |
| 10 % exposure shift | 0.100 — exactly the `≤ 0.1` floor |
| `--sabotage exposure` (×2) | 1.000 |
| Coverage difference Δc at contrast ΔL | `Δc · ΔL / mean(A)` |
| 50 % coverage difference at the ladder's contrast | ≈ 0.18 — fails |

The floor `histDist ≤ 0.1` is therefore retained at its original number but now
*means* something: no more than a 10 % exposure-equivalent tonal mismatch.
Normalising by side A's mean makes it scale-free, so one threshold serves a
bright orbit plate and a dim twilight plate; the asymmetry is deliberate, since
side A is the reference.

**2. ΔE2000 is confirmed correct.** The implementation matches all 34 published
Sharma, Wu & Dalal (2005) reference pairs to 1e-4, including the hue-wraparound
and `RT`-rotation edge cases the test set exists to catch. `deP95` is the
nearest-rank 95th percentile (index `floor(0.95·n)` of the ascending sort).

**3. SSIM is confirmed to match Wang et al. 2004 — and to be the wrong
parameterisation for this data.** Its stabilisers are fixed for a dynamic range
`L = 1.0` (`C2 = 9e-4`), but a linear cloud plate has local variance ~1e-4.
`C2` then dominates the variance it stabilises, pinning the contrast/structure
term near 1, so SSIM degenerates to little more than its luminance term. Two
plates with identical statistics and **zero** correlation score 0.9912 at
σ = 0.002, 0.9474 at σ = 0.005 and 0.8182 at σ = 0.01. 28 of the 31 committed
cases sit at `min(Astd, Bstd) ≤ 0.01`; `ecef-identity`, where side B marched no
clouds at all, carries phase 1's *highest* SSIM (0.9716).

The `ssim ≥ 0.95` floors are consequently **not structural gates today**. This
is recorded as an open high-priority defect rather than fixed here: choosing between a data-derived `L` and computing SSIM on
display-encoded luminance is a design decision needing its own evidence and its
own re-capture. Until it lands, the plate check — not SSIM — is what rejects a
non-rendering side B.

**4. Metric definitions are versioned.** `metrics.json` now carries
`metricsVersion` (currently 2). A committed file at an older version has a
`histDist` from a superseded definition, so `scripts/verify-results.mjs` fails
it with `stale metrics … re-capture` instead of comparing it to the new
threshold. Like the plate check, this runs before `accepted[]` and is never
downgraded. Every case committed before this amendment is stale by construction.

**5. Calibration is still deferred.** Thresholds stay at the design floors. The
`bias` block in `thresholds.json` records the measured mean/σ over the 31 cases
marked `"measured, not applied"`, because the port still has open defects
(the weather coverage response, the ECEF identity case that marched no clouds, the
pass graph lifecycle, and the SSIM floor itself) that calibration would bake
into the bias.

`evaluate` / `checkPlate` / `checkMetricsVersion` exist in three copies —
`examples/parity/src/metrics/evaluate.ts`, `examples/parity/scripts/capture.mjs`
and `scripts/verify-results.mjs` — and a definition change lands in all three in
one commit.

A **fourth** site encodes the metrics.json *shape* rather than those three
functions: `examples/parity/src/capture/metricsWriter.ts` (`MetricsSchema`,
`formatMetricsJson`, `validateMetricsJson`). It is easy to miss because
`capture.mjs` builds and writes its object inline and never calls it, so its
writer functions have no caller but their own test — and it had already fallen
behind the `metricsVersion` bump when this was found. Its *types*
are load-bearing regardless: `gridPage.ts` and `gridData.ts` import
`MetricsSchema` / `GpuMsSchema` from it, and both are wired into the live app.
It now imports `METRICS_VERSION` rather than redeclaring it, so a schema change
touches the three copies above plus this file's `MetricsSchema` and its
`required` list.

## Amendment 2 — 2026-08-31: SSIM's dynamic range is measured, not assumed

Amendment 1 established that SSIM matched Wang et al. 2004 but was the wrong
*parameterisation* for this data, and deferred the fix. This is that fix.

`L` in `C1 = (K1·L)²` / `C2 = (K2·L)²` is the dynamic range of the data — that is
what the paper means, and why 8-bit images use `L = 255`. Fixing `L = 1.0` was
wrong for a metric computed on the linear pre-tonemap readback, where a cloud
plate occupies ~0.02–0.13 with local variance ~1e-4 against `C2 = 9e-4`.

**Decision: `L` is side A's robust luminance span (0.5–99.5 percentile),
measured per case.** Percentiles rather than `max − min` so a single fp16 blowout
cannot inflate the range; side A only, because the reference must set the scale —
deriving `L` from both sides would let a blown-out side B widen `L` and mask its
own error, and it matches the asymmetry `histDist` already uses.

Amendment 1 *recommended* the other candidate — encoding to sRGB and keeping
`L = 1.0`. **Measurement overturned that recommendation.** On plates with
identical statistics and zero correlation (true similarity 0):

| local σ | fixed `L = 1.0` | sRGB-encoded, `L = 1.0` | `L = span(A)` |
|---|---|---|---|
| 0.002 | 0.9915 | 0.9767 | 0.0002 |
| 0.005 | 0.9494 | 0.8703 | 0.0003 |
| 0.010 | 0.8251 | 0.6276 | 0.0003 |
| 0.020 | 0.5445 | 0.2946 | 0.0003 |
| 0.050 | 0.1704 | 0.0515 | −0.0011 |

sRGB encoding only stretches the values: it still endorses uncorrelated content
at 0.98 for a low-contrast plate, and because it compresses highlights it
*weakens* the exposure response — the ×2 sabotage scores 0.9313 under it, against
0.6408 for the adopted form. The recommendation in Amendment 1 was reasoned
analytically and not measured; it was wrong.

Consequences:

- SSIM is now **reference-relative, not symmetric**. Capture always calls
  `computeSSIM(linearA, linearB, …)`.
- The `ssim ≥ 0.95` / `≥ 0.98` floors are structural gates again. A synthetic
  stand-in with the old `ecef-identity` statistics (side A flat at std 0.000283,
  side B 0.00582) scores **−0.0014** where it previously scored 0.9716.
- Brightness independence: the same true similarity now scores the same on a
  mean-0.101 plate and a mean-0.0156 plate (0.0003 both), where the fixed `L`
  gave 0.8251 and 0.9949.
- `METRICS_VERSION` is **3**. Every capture at v1 or v2 is stale and re-graded as
  a fail until re-captured; the committed SSIM numbers from Amendment 1 are void.
- Thresholds remain **uncalibrated**. The `bias` block's SSIM distribution was
  measured under the old definition and is now void as well.

## Amendment 3 — 2026-09-01: SSIM is gated at the ladder reference L; the measured span becomes the diagnostic

Amendment 2 was right that `L` must be the dynamic range of the data and not
`1.0`, and its measured-`L` form is what made SSIM structural again. It also
made the pass bar scale inversely with frame content. With
`C2 = (0.03·L)²` and `1 − cs = σd² / (σA² + σB² + C2)`, a near-empty frame
shrinks the denominator: the same difference field that costs nothing on a
textured plate costs most of the structure term there. Measured on the
committed phase-1 plates, holding every σ and correlation fixed and changing
only `L`: `coverage-020` (span 0.027) scores 0.8377 at its own `L` and 0.9746 at
the ladder norm 0.09 — the reconstruction lands on the measured 0.8375 before it
is asked to change anything, so 84 % of that case's deficit was the stabiliser.
The ladder clusters at `L ≈ 0.09` (surface-up 0.056, coverage-070/090 0.12);
`coverage-020` was held to a ~14× stricter bar than its neighbours.

**Decision (option b):**

- The gated `ssim` is computed at the **ladder reference `L = 0.09`**
  (`REFERENCE_L` in `metrics/ssim.ts`) for every case.
- The measured-`L` number (Amendment 2's form) is still computed
  (`computeSSIMAtMeasuredL`) and written beside it as
  `ssimAttribution.ssimAtMeasuredL`, with `measuredL` and the stabiliser's
  share of the measured-`L` deficit. It is the sensitivity diagnostic; the
  register may not cite it as a gate.
- `METRICS_VERSION` is **4**. Every v3 capture is stale until re-captured; the
  re-capture is the uniform one already owed, and its
  recalibration (including the debug views' 0.98 floor) is done on the gated
  number.
- The trade is stated, not hidden: on plates darker than the reference the
  gated SSIM is less sensitive to structure than the measured-`L` form. The
  plate check (black/flat) and the diagnostic carry that regime, and the
  existing floors — calibrated on textured plates at `L ≈ 0.09` — keep their
  meaning where the ladder lives.

## Amendment 4 — 2026-09-01: shadow cases carry a shaded-fraction receipt that SSIM cannot substitute for

Amendment 3 fixed *what* SSIM measures; this amendment records what it
cannot. `layers-4-shadow` (phase 3) lost ~90 % of its cloud shadow on side B
(shaded plate fraction 21 % → 2 %) and the gated SSIM moved by less than the
phase floor's margin — a whole feature can vanish under a structural metric
that is dominated by the sky and the cloud bodies. Every fix or regression in
the shadow path since, including the Linear-filter placeholder, its revert and
the explicit-LOD fix, was invisible to the ladder; each was judged by hand
from PNGs.

- **Receipt, not hope.** Shadow cases (any case whose `state.shadow` is
  `true`) render both sides a second time with the casters off and count the
  pixels the shadow darkens (`examples/parity/src/metrics/shadedFraction.ts`:
  a pixel is classified when its lit-plate luminance exceeds `1e-4`; shaded
  when the casters-on luminance is below `0.98` of the casters-off value).
  The runner calls `window.__parity.setShadow(false)` and the probe **returns
  the flags it wrote**; `p.set({ shadow: false })` had been a silent no-op
  for a whole evening of "correlations" and the receipt exists so that
  cannot recur. The block is written to `metrics.json` as `shadedFraction`.
- **Three refusals, then a floor.** The receipt is refused (hard fail, not
  downgradeable by `accepted[]`) when a side's flags did not read back
  all-off, or when a side's plate did not brighten with the casters off
  (the knob was inert — the fraction would be a fraction of nothing). Only a
  verified receipt is graded: `B.fraction / A.fraction ≥ 0.85`. The floor is
  provisional — it is set above the 0.10 the defect produced and below the
  ~0.97 a matching shadow produces, and will be calibrated once the phase-3
  re-capture lands the receipt on every shadow case.
- **Two gaps found by the first full pass, closed the same night.**
  The floor is a *minimum*, so two near-zero fractions divided to 10.7 and
  passed it from above on `ground-bounce-on` — a pose under the deck looking
  up, with no ground shadow in frame. The receipt now requires side A to shade
  at least 1 % of the plate (`MIN_SIGNAL_FRACTION`); below that it reads "no
  shadow in frame" and fails, because an undeclared no-signal means the pose
  is wrong for a shadow case. And the premise "casters off brightens the
  plate" inverts when the subject *is* the atlas: `debug-shadow-map` darkened
  (rise −0.319) and `debug-cascades` brightened by luck. Cases where
  `shadow: true` is a prerequisite (ground bounce is gated on
  `shadowTopHeight`) or whose subject is the atlas declare
  `shadedFractionReceipt: { skip: reason }` in the registry; the runner writes
  `{ skipped: reason }`, `verify-results` and the coverage test accept a
  declared skip and never silence.
- **Same rule in two places.** `scripts/verify-results.mjs` cannot import
  the TypeScript module, so `checkShadedFraction` mirrors
  `evaluateShadedFraction` (the third-copy problem); both are
  pinned by tests.
- **Not a definition change.** `metricsVersion` stays 4: `ssim`, `deP95` and
  `histDist` are unchanged, and a `metrics.json` without the block is still
  comparable — it predates the receipt and `verify-results.mjs` does not
  check what is absent. The block becomes mandatory for shadow cases once
  every phase-3 shadow case has been re-captured with it.

## Amendment 5 — 2026-09-01: a capture requires a passing e2e suite for its own inputs

A red **typecheck** refused every capture. A red **e2e
suite** refused nothing. So a failing suite still produced a complete,
well-formed results table, which is the same failure the typecheck gate exists
to prevent — a measurement taken on a tree already known to be unsound — one
signal over.

Playwright's own `test-results/.last-run.json` could not close it: it records a
single status, is not keyed to the code under test, and nothing read it. It
cannot distinguish "this tree is red" from "some tree was red once".

**The receipt.** Every unfiltered e2e run writes
`parity/results/e2e-receipt.json`, committed alongside the plates it backs:

```jsonc
{
  "key": "<sha256 of the e2e INPUTS' working-tree contents>",
  "filtered": false,   // true if --grep/--shard/--project or a spec path narrowed the run
  "dirty": false,      // uncommitted or untracked changes UNDER the input paths
  "tests": [ { "spec": "e2e/p4.spec.ts", "title": "...", "status": "passed" } ],
  "ts": "..."
}
```

**Keyed by inputs, not by commit.** The receipt is committed *with* the results,
so a commit-keyed receipt would name a commit that does not exist when the
receipt is written — stale by construction. The key hashes the working-tree
contents of `src`, `examples/parity/{src,e2e,cases}` and `pnpm-lock.yaml`:

```sh
git ls-files -z -- src examples/parity/src examples/parity/e2e \
    examples/parity/cases pnpm-lock.yaml \
  | xargs -0 shasum -a 256 | LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1
```

Working tree rather than index: `git write-tree` hashes staged content and would
call a dirty tree clean. `LC_ALL=C sort` so the key does not depend on the
machine's collation.

**Per-test, because two states a boolean flattens both matter:**

| State | Why it is not a pass |
|---|---|
| `skipped` | A suite that skipped the case you care about is not evidence about that case. Reported and named, never counted as a pass. |
| filtered / did-not-run | A `--grep` run exercises a fraction of the suite. Reading it as green licenses a capture on tests that never executed. |

**Verdicts.** `green` only for an unfiltered, clean run with no failures.
A capture **refuses** on `red` *for its own key* and **warns and proceeds** on
`stale`, `missing`, `dirty` or `partial`. An unknown must not masquerade as
either verdict, and refusing on a missing receipt would block a fresh clone that
has never run e2e. `PARITY_SKIP_E2E_RECEIPT=1` opts out, printing loudly.

**The check is opt-in, and must be.** The e2e runner itself calls
`ensureFreshBuild`; a receipt check applied to every caller would deadlock,
because a red suite would block the very run that would make it green. Captures
opt in (`requireGreenE2e: true`); the e2e gate does not.

**Regeneration is required at acceptance points only.** A phase sign-off or a
threshold change needs a green receipt whose key matches the tree being signed
off. Ordinary commits let the receipt go stale and warn. Requiring regeneration
on every source commit would make each one owe a full e2e run; a gate that
costly gets bypassed, and then it protects nothing — the same argument that
killed mtime-based staleness.

**Known limit, stated rather than papered over.** `git ls-files` lists *tracked*
files, so an untracked addition changes what the suite runs while leaving the key
identical. That is why `dirty` exists and is scoped to the input paths. Folding
untracked files into the key would churn it on every scratch file. This limit is
not hypothetical: untracked files under `src/` took the typecheck down on
2026-09-01.

## Amendment 6 — 2026-09-01: debug views are judged on their quantity, then their plate

The phase-4 debug floor is intentionally strict (`SSIM >= 0.98`), but a debug
view is not a beauty frame. Several views turn small cross-backend floating-point
or filtering differences into discontinuous colours: an integer counter changes
by one, a cascade selector crosses a boundary, or `turbo` expands a small depth
delta. Requiring those discontinuities to correlate like continuous radiance
either accepts a broken flat plate or rejects a source-aligned instrument.

The first hardware observation found real defects, so this is not permission to
register the initial output. `debug-sample-count` used one scalar for three
different counters and saturated two channels (`0.0841`); `debug-front-depth`
used zero for every miss (`0.0713`); `debug-shadow-map` displayed unit-space
front depth as metres and sampled an unused fourth cascade (`0.4259`). Those
were repaired before any basis was recorded. The current evidence is:

| View | SSIM | Quantity receipt |
|---|---:|---|
| `debug-cascades` | 0.9677 | Same faded cascade selector and colour table; A/B means 0.0542/0.0560. |
| `debug-shadow-map` | 0.9794 | Red B/A 1.001 and the same unused black quadrant after unit conversion and runtime cascade guards. |
| `debug-sample-count` | 0.8158 | Separate weather/shape/detail counters; structured cloud plate, G/B correlations 0.954, B mean counts about 5.5% higher. |
| `debug-front-depth` | 0.9691 | Hit depth plus scene-or-far miss depth; A/B means 0.6966/0.6963, `histDist = 0.0007`. |

Each view has an **exact-name** `accepted[]` entry citing this amendment. No
phase floor moves and no wildcard is used. The plate checks still execute before
the register, so a black or flat output cannot become an expected difference.
Any future semantic change must remove the entry, re-capture, and earn it again;
the register is the named cost of exposing discontinuous internal quantities
across WebGL and WebGPU, not a substitute for implementing them.

**2026-09-23: `debug-shadow-map` removed from the register.** Most of the atlas difference this view
showed came from the harness, not from cross-backend variance. Side A's history
reset cleared the reference's shadow ping-pong targets with `renderer.clear()`
at three's default clear alpha of 1. The atlas's alpha is the optical-depth
tail, and the reference `clipAABB` never clips alpha, so the injected tail
survived the warm-up. Clearing those targets to zero
in all four channels. The re-capture after that fix scores the
view at SSIM 0.985805, deP95 2.88, above the 0.98 floor with no entry.
`debug-cascades` (0.978), `debug-front-depth` (0.969) and `debug-sample-count`
(0.816) keep their exact-name entries under this amendment.

## Amendment 7 — 2026-09-01: repeated captures define a separate hardware-state floor

The first moving-shadow differential treated a `1.1e-5` SSIM spread as a
sequence-specific race. Repeating the measurement on one fixed library artifact
(`build/shared.js` SHA-256 `7a3fc18fb0bdeb9a9675f0c848ae9f0c61f495c974bc320417f9adaea107ca3b`)
separated the still from the sequence:

| Capture | Runs | SSIM states | Spread |
|---|---:|---|---:|
| `shadow-both-moving` still | 10 | 0.962632, 0.962638, 0.962643 | 0.000011 |
| `shadow-plane` non-sequence control | 10 | 0.962632, 0.962638, 0.962643 | 0.000011 |

The two cases have the same still setup; case 36 applies its weather, camera and
sun motion only after that still is measured. Side A's PNG was byte-identical in
all 20 successful captures. Side B occupied the same three metric states in
both cases; comparing two different states changed 36.5% of display pixels, but
every changed channel moved by exactly one 8-bit code, with positive and
negative changes balanced to 0.2%. `maxDiffDelta` moved by at most `7.1e-5`,
about two half-float ULPs at the plate's luminance. This is the WebGPU
half-float/display-quantisation boundary of the fixed-frame capture, not a
sequence-state selector. One additional control attempt timed out before its
probe became ready and was excluded as a failed capture, as required by.

This floor is distinct from both a metric threshold and the analytic ULP floor:

- A single-run before/after delta at or below the measured state spread is
  unresolved. Repeat the exact case at least 10 times on one artifact, report
  the modal value and full spread, and compare distributions rather than the
  selected run.
- A larger delta does not inherit this exemption. Phase thresholds and the
  `accepted[]` register are unchanged.
- Sequence flicker and ghosting are scalar magnitudes; they do not prove that
  A and B move in the same direction. Directional displacement is tracked
  separately and must not be inferred from this floor.

## Amendment 8 — 2026-09-01: moving cases gate dominant displacement direction

Flicker and ghosting reduce a sequence to unsigned magnitudes. Two clouds moving
in opposite directions can therefore produce the same values and pass every
existing temporal assertion. Moving cases now correlate the edge fields of the
first and last linear frames, after downsampling to at most 160 pixels wide, and
write `motionA`, `motionB` and `motionDirection` into `metrics.json`.

- The displacement is the offset with the highest normalised cross-correlation
  within a 16-grid-pixel search radius. Edge fields suppress uniform atmosphere
  luminance and make the measurement follow cloud structure.
- Direction is graded only when both correlation scores are at least 0.1 and
  both displacements are at least 2 full-resolution pixels. Static or noisy
  plates are recorded as `comparable: false`; absence of a measurable vector is
  not converted into a direction claim.
- Comparable vectors require cosine similarity at least 0.5. This deliberately
  permits small cross-axis differences while refusing an orthogonal or reversed
  dominant motion.
- The operator-observed `shadow-both-moving` plate did not reproduce as a
  dominant reversal. Hardware component captures measured weather A `(21,10)` /
  B `(20,10)`, camera `(-2,0)` on both, and sun `(0,2)` on both; the combined
  committed sequence measured A `(19,12)` / B `(18,11)`. The regression is the
  missing gate exposed by that observation, not a sign change hidden in the
  current dominant field.

`METRICS_VERSION` remains 4 because the new sequence fields are additive and
older committed stills remain comparable. A newly captured moving case always
writes the fields (or explicit nulls), so the evidence cannot disappear through
the metrics writer.

## Amendment 9 — 2026-09-01: temporal captures converge per side, and a capture states its own stationarity

Before the accumulator was reset, `renderOnce(warmup)` continued from whatever it held, so `warmup 64` meant "64 frames on top of the page's history".
The same call measured 71.88 % changed from cold and ~0 % on a warm page
, which made every temporal baseline a function of render order.
Resetting both sides before the warm-up; one caller was then restored that must
*continue*. This amendment records how convergence is measured
now that it can be.

**The criterion is per-case-per-side plate-mean drift.** Bit-identity between
two independent runs is retired. It was falsified by its own inert control:
`baseline-medium` has empty state and nothing that can converge, yet 72.25 % of
its pixels differed between two runs at `W=256` and again at `W=512` — flat, no
trend — while its plate mean held at 0.103425 / 0.103426. The criterion was
measuring per-pixel noise, not accumulation. The corroborating tell was
non-monotonicity, which no convergence process produces:
`shadow-cascades-2x512` side B went 55.63 → 88.42 → **0.34** → 89.60 % as `W`
rose. Drift separates the same cases cleanly:

| Case | A converged | B converged | plate-mean drift W64→W512 (A / B), post-d5cm |
|---|---:|---:|---|
| `shafts-inside-deck` | >512 | >512 | **2.91 %** / 0.47 % |
| `shadow-cascades-2x512` | 64 | >512 | — / 0.84 % |
| `layers-4-shadow` | 64 | >512 | — / 1.63 % |
| `temporal-on-static` (control) | 64 | 256 | — / −0.00 % |
| `baseline-medium` (inert control) | 64 | >512 | — / −0.00 % |

Both controls read −0.00 %. A statistic that cannot tell an inert case from a
live one cannot tell a converged case from an unconverged one, so **every
convergence run carries an inert control** and its result is reported.

Every B-side number in this amendment is re-measured after the pending
re-capture; the A-side figures and the ancestry rule are unaffected by it.

**Stationarity is not reproducibility.** The convergence receipt records
whether a capture had settled *within its own run*; it says nothing about
whether a second capture would agree. A green receipt is necessary, not
sufficient. Where the two differ, the reproducibility number governs.

**The reproducibility floor remains Amendment 7's.** `shafts-inside-deck`
repeats at **N=10**, temporal on, registry state, one SHA: SSIM spread
**`2.79e-6`** (Q1 baseline). An earlier pair had put it at `2.3e-6`,
which was n=2 — one pairwise observation, not a bounded floor — and the N=10
measurement supersedes it rather than confirming it by luck. The case-specific
figure is recorded as a per-case observation and **does not supersede**
Amendment 7's measured `1.1e-5` at N=10, which remains the floor a single-run
delta is judged against. Amendment 7's N≥10 requirement applies unchanged, and
a per-case floor is quoted only where it has been measured to that standard.

**Non-converging sides.** A side that has not settled by the capture warm-up is
not thereby disqualified, but it must be declared. `shafts-inside-deck` side A
is the ladder's only such side: ~1.21–1.28 % of pixels still changing between
independent runs at every `W` out to 512, mean climbing 0.057808 → 0.059490.
The ladder captures at `W=64`, so that baseline measures B against an A ~2.9 %
short of settled, and the disparity itself narrows with warm-up (B/A 1.1070 at
`W=64` → 1.0807 at `W=512`).

The mechanism is the **shadow temporal history**: an alpha-0.01 accumulator is
still only part-converged at `W=64`, and `temporalPass=false` removes both this
drift and side B's elevated run-to-run floor on the same case (arm F).
That toggle is the cheap diagnostic for any future non-converging side — it
separates "has not settled" from "noisy for another reason" in one render,
where finding it the first time cost a `W` 64/128/256/512 sweep. It is a
diagnostic, not a capture setting: the ladder still captures with temporal on,
because that is the configuration under test.

- Capture at the **fixed** conventional warm-up. A per-case warm-up would make
  cases incomparable and invite tuning `W` until a case passes.
- **Record the residual drift per side** for any case where a side has not
  converged, and cite it in any differential taken against that side.
- A differential that compares two arms at **different** warm-ups quotes the
  drift bound for the moving side, or it is not a differential.

**Acceptance procedure, consolidated.** A phase acceptance requires all three:

1. A **matching-key `PASSED` e2e receipt** (Amendment 5) — keyed to the inputs,
   unfiltered, not dirty.
2. **Post-correction shaded-fraction receipts** wherever the gate leans on
   `shadedFraction`. The test is **git ancestry against the correction's own
   revision**, not the
   presence of the convergence field: ancestry classifies all 61 committed
   receipts retroactively (59 pre / 2 post), where a field-presence test only
   covers captures taken after the field shipped. `isPreCorrection` treats
   unknown provenance as PRE — an artifact whose provenance cannot be
   established is not current evidence (`scripts/verify-results.mjs`).
3. **The capture states its own stationarity** — the per-side `convergence`
   block in `metrics.json`. A `null` is the recorded absence of a reading; an
   absent key is a capture that predates the receipt reaching the artifact at
   all, and is not evidence of stationarity either way.

No mass re-capture follows from this amendment. The 59 pre-correction receipts
are classified by ancestry, not re-taken.

**What the boundary is worth, so it is not read as a regression.** Ancestry
classifies receipts, but nothing recorded how far the correction moved them, and
a pre/post pair wearing one case name invites exactly the wrong reading. Measured
from committed evidence across the refresh that crossed it (one revision before the correction,
one after), every shadow case moved and **every one moved
down**:

| | pre | post | delta |
|---|---:|---:|---:|
| `layers-4-shadow` | 0.958747 | 0.940020 | −0.01873 |
| `shadow-both-moving` | 0.962565 | 0.945724 | −0.01684 |
| `shafts-orbit-off` | 0.962565 | 0.945723 | −0.01684 |
| `shadow-plane` | 0.962565 | 0.945738 | −0.01683 |
| `shafts-low-sun` | 0.953408 | 0.938887 | −0.01452 |
| `shadow-temporal` | 0.961352 | 0.949786 | −0.01157 |
| `shadow-cascades-2x512` | 0.941521 | 0.933431 | −0.00809 |
| `shafts-inside-deck` | 0.642752 | 0.640880 | −0.00187 |
| `shadow-cascades-4x1024` | 0.969210 | 0.967624 | −0.00159 |
| `shadow-sphere` | 0.968737 | 0.967800 | −0.00094 |

Ten of ten in one direction, mean −0.01078. That is the signature of a change in
what the capture measures, not of ten independent regressions — the honesty
correction landing, not a defect appearing. Two systematic causes sit in that
window (the capture itself, and `cloudShadowLength` becoming a live node so
side B's light shafts stopped being inert) and **this table does not attribute
between them**; it bounds the boundary, nothing more.

The rule that follows: **before treating any committed ladder metric as a
regression, check its source revision's ancestry against the correction's own
revision.** Pre- and post-correction numbers
wear the same case name and measure different things, and the gap is ~0.011 SSIM
on a shadow case — an order of magnitude above Amendment 7's `1.1e-5` floor, so
it will not announce itself as noise.

## Amendment 10 — 2026-09-24 (accepted, with ADR-013 Amendment 6): side B's atmosphere method is part of a capture's configuration

Side B's atmosphere method changes what the ladder measures, as much as any
graph-time flag. So, from ADR-013 Amendment 6:
- A capture records it. Each case's `capture.log` has
  `atmosphere: requested=<profile> effective=<profile> B raymarchScattering=<live value>`, read from
  side B rather than assumed. `<- PROFILE NOT APPLIED` voids that case.
- The committed ladder uses each case's EFFECTIVE profile: the LUT lookup,
  except where the case definition itself declares an `atmosphereException`
  (today only `below-deck-1km`, ADR-013 Amendment 6, Decision 3). A profile
  requested on the URL or the capture command line (`raymarch-256`,
  `lookup-both`) is a diagnostic capture and must write outside
  `parity/results` (`scripts/captureArgs.mjs` refuses otherwise).
- A method change is not compared case by case against captures taken under the
  other method. The ladder is re-captured wholesale under the new method, with a
  fresh receipt. Per-case deltas across the change are reported for review,
  never gated on.
- gpuMs taken under different atmosphere methods are not comparable, just as
  gpuMs from different machines are not.

## Amendment 11 — 2026-10-02: the e2e receipt is read at VERIFY time, and so are the build skips

Amendment 5 put the e2e gate in the CAPTURE path only. Whether that was the
whole story was open, so it was measured rather than assumed.

**The measurement.** `provenance.e2e` was corrupted on all 63 committed
captures — verdict `red`, `overrideArmed: true`, `inputsKey` set to the
SHA-256 of nothing, plus `build.servedIsBuilt=false`, an unresolvable
`servedTree` and `git.dirty=9999` — and `verify-results.mjs` was re-run.
Output was byte-identical: 59 pass, 4 expected-difference, 0 fail, exit 0,
both ways. **Verify-time did not read the field at all.** The four things it
does read were each confirmed by the same method (metricsVersion,
`metrics.json.env`, `shadedFraction`, the pre-correction ancestry flag).

**What verify-time already read, precisely.** Four things, none of them the
`provenance` object: `metrics.metricsVersion` and `metrics.shadedFraction` are
TOP-LEVEL fields, the hardware count reads the SIBLING FILE
`metrics.json.env`, and the pre-correction flag reads the FILE'S OWN git
ancestry. So the survey's "verify-results.mjs never reads provenance" was true
in the narrow technical sense, and no retraction of it is owed. The claim that
actually settles this is narrower, and is what Amendment 5's scope implies:
**nothing read `provenance.e2e`.** No line in the pre-existing verifier read any
`provenance.*` path.

**Known gap, deliberately not closed here.** `provenance.build.servedIsBuilt`
and `provenance.servedTree` remain **UNGATED at verify time**. A committed
capture carrying `servedIsBuilt: false` and an unresolvable `servedTree`
verifies clean, because `refuseUnlessServedIsBuilt` and
`refuseUnlessServedIsSelf` are CAPTURE-time refusals only. Tracked as its own
here; fixing it would widen this amendment past the question it answers.
**CLOSED by Amendment 12**, which adds the verify-time gate this
paragraph warned was missing.

**Also corrected: the premise.** The record then held 63 of 63 captures stamped
`stale` with `overrideArmed: true`. Re-measured afterwards: 60 `green`, 3
`stale`, and **zero** with the override armed. Every committed capture was
taken with the override off. The override was legitimate on all of them.

**What verify-time now does.** It reads the STAMP the capture left, never a
recomputation. Recomputing would be wrong by construction: `e2eInputsKey`
hashes the working tree, which has moved since, so a fresh evaluation would
read every historical capture as stale, the trap already named for the
off-arm correction, where git ancestry replaced a field test for that reason.

| Stamp | Verdict |
|---|---|
| `red` | **hard fail**, never downgradeable by `accepted[]` |
| `stale` / `dirty` / `partial` | reported, grouped, never a fail |
| `missing` | reported, never a fail (an ABSENT proof, see below) |
| `overrideArmed: true` | reported |
| block absent | reported as predating Amendment 5 |
| `skips.build` / `skips.typecheck` true | reported |

Red is a hard fail because that is already Amendment 5's own policy: a capture
stamped red measured a tree whose suite was failing, which is not a difference
to be accepted but a measurement to be discarded.

The softer states stay warnings, but they are not all the same and the reasons
differ. `stale` is a proof about a DIFFERENT tree: the receipt is real and green,
it is for inputs this capture did not use, which is the normal state of
historical evidence once any commit lands, so refusing it would redden the whole
ladder on the next source commit (the cost that made the capture-time gate
bypassable in the first place). `missing` is an ABSENT proof: no suite ran, or
none was found on that machine, so nothing at all is established about the tree.
It is still not a hard fail here, because Amendment 5 declined to refuse on it at
capture time and verify-time must not be stricter than the gate that produced
the evidence — but it is the weaker of the two, and a case whose only receipt is
`missing` should be re-captured before anything leans on it.

**The skips were recorded nowhere.** `PARITY_SKIP_BUILD` and
`PARITY_SKIP_TYPECHECK` were logged loudly and stamped nowhere, so a committed
capture could not be said to have skipped either; only the e2e skip was
recorded, as `e2e.overrideArmed`. Every capture now carries
`provenance.skips`, and the same provenance reaches the `capture.log` line.

**Backward compatible, and stated because the shape is a trap.** `skips` is
declared REQUIRED on `CaptureProvenance`, and every one of the 63 committed
captures predates it, so all 63 lack the field. The reader guards it
(`e2eReceiptAnnotations` tests `skips != null`) and `provenanceLine` prints it
only when present, so historical evidence neither crashes nor falsely reports a
skip. A required field that no committed artifact carries is exactly the shape
that breaks a later reader, which is why it is written down here.

**Scope held.** The capture-path gate is unchanged: it still takes the receipt
and still refuses on red before a server starts. This amendment adds a reader
for the stamp it already left.

## Amendment 12 — 2026-10-02: the SERVED bytes are read at VERIFY time

Closes the gap Amendment 11 recorded and deliberately left open.

**The hole, measured.** `build.servedIsBuilt: false` and an unresolvable
`servedTree` were injected into all 63 committed `metrics.json`, and
`verify-results.mjs` was re-run on `main` at this ADR's base: **59 pass, 4
expected-difference, 0 fail, exit 0**, byte-identical to the uncorrupted run.
`refuseUnlessServedIsBuilt`, `refuseUnlessServedIsAncestor` and
`refuseUnlessServedIsSelf` all gate at **capture** time only, so a copied or
hand-edited capture carrying the stamp of a run that measured the wrong bytes
verified as sound. With the gate in place, the same injection reads **0 pass,
63 fail, exit 1**, each line naming both builds. Evidence restored;
`parity/results/**` unmodified.

**What verify-time now does.** It reads the stamps the capture left, never a
recomputation, for the reason Amendment 11 gave: these fields record what the
capture observed about itself, and re-deriving them at verify time would read
every historical capture as stale.

| Stamp | Verdict |
|---|---|
| `build.servedIsBuilt` not `true` | **hard fail**, never downgradeable by `accepted[]` |
| `servedTree.root` null | **hard fail** |
| `servedTree.root` set, `servedTree.head` null | **hard fail** |
| `build` block absent | reported, never a fail (predates the stamp) |
| `servedTree` block absent | reported, never a fail |

The fails are hard on Amendment 5's own reasoning, unchanged here: a capture whose
served build is not the build it recorded did not measure this project, so it is
not a difference to be accepted but a measurement to be discarded. An
unresolvable `servedTree` is the same class, because
`refuseUnlessServedIsAncestor` already refuses on exactly that input at capture
time, so verify-time refusing it is not stricter than the gate that produced the
evidence. A **missing or non-boolean** `servedIsBuilt` fails too: the value must
be positively `true`, so a truthiness bug cannot pass.

**Absent is still not a fail.** A capture with no `build` block predates the
stamp. It cannot say the bytes were wrong, so it cannot fail, and refusing it
would redden historical evidence for the sin of being old. The asymmetry is the
load-bearing part: a block that is **present and unsound** fails, a block that is
**absent** is reported.

`servedTree` absent is reported on the same reasoning and for an extra reason.
It is an **unconditional** key of the provenance object at capture time, so an
artifact without one was not produced by `captureProvenance` and was edited
afterwards, which is this amendment's own threat model. It is still not a fail,
because it is a weaker signal than a block present and unsound and the lineage
proof it carries cannot be reconstructed after the fact.

`refuseUnlessServedIsSelf` has no counterpart here and cannot have one. It
leaves no stamp, because it throws before a provenance object exists, and no
`metrics.json` records whether the served tree was *self* rather than which tree
it was. That is the correct design: a refusal needs no receipt. An auditor
should not demand a gate that cannot exist.

**All 63 committed captures already satisfy the gate**, re-derived from the
evidence at this base: every one has `servedIsBuilt === true`, a resolved
`servedTree.root`, a readable `servedTree.head`, and for all 63 the served head
is a git ancestor of the commit last touching the file. That is why a hard fail
is the right verdict here rather than an annotation, and it is checked rather
than assumed: the ladder is 59 pass / 4 expected-difference / 0 fail, exit 0,
before and after.

## Amendment 13 — 2026-10-05: a receipt names its subject, and a packed plate is gated on the channels that reach rendering

Amendment 4 introduced the shaded-fraction receipt, and Amendment 6 judged the
debug views. Both amendments assumed a case's subject is ONE quantity that BOTH
sides produce. Two cases broke that assumption, in opposite directions, and
both had been reporting a hard fail that said nothing about the port.

### 1. The shaded-fraction receipt may be declared `b-only`

**The defect in the instrument.** `aerialPerspectiveEffect.frag` computes the
shadow transmittance and then discards it unless a light is post-applied: the
only consumer of `sunTransmittance` is `getSunSkyIrradiance`, compiled under
`#if defined(SUN_LIGHT) || defined(SKY_LIGHT)`, and `sideA.ts` sets
`sunLight`/`skyLight` to `lighting === 'post'`. Case 35 is the one
`lighting: 'lights'` case, so on side A `aerial.shadow` is a dead store — it
cannot darken a pixel. What side A's plate responds to is the CLOUD pass: with
the casters cleared, `layer.shadow = false` empties the atlas,
`readShadowOpticalDepth` returns 0, and the cloud loses its own sun
attenuation. Side B's plate responds to that AND to ADR-007 3.2b's ground
shadow. The receipt divided them: A 9.63 % / B 4.28 %, ratio 0.445 < 0.85. The
two numbers are the cloud self-shadow response and the cloud self-shadow
response plus a ground shadow. `shadow-plane` at the same 10° sun passes at
0.980 because in `post` mode the GROUND dominates its plate, and case 35's
fractions sit an order of magnitude below every other shadow case's.

**Decision.** A case declares `shadedFractionReceipt.compare`:

| value | gate | who declares it |
|---|---|---|
| `ratio` (default) | flags all-off, both plates brighten, A ≥ 1 % signal, B ≥ 0.85 × A | every case whose shadow both sides shade from the same consumer |
| `b-only` | flags all-off, **side B** plate brightens, **side B** ≥ 1 % signal | case 35 only |

`b-only` keeps the measurement, so both fractions and the (meaningless) ratio
stay in `metrics.json` as evidence. It does NOT relax the receipt to silence:
the reference-restricted ground-shadow assertion is the phase-4 e2e
that toggles the sphere's visibility to build a receiver mask and asserts
side B's masked pixels darken. That assertion is the gate for 3.2b and this amendment
tightens its bounds; the capture receipt is the plate-level companion.

**Consequence.** A `b-only` receipt cannot detect a 3.2b regression that the
cloud self-shadow masks, because at this pose the two overlap. The e2e can and
does, and this amendment tightens its bounds to what was measured rather than
to a token value: side B's receiver pixels measured `fraction 0.625` and
`darkening 0.02999` on a 0.0524 mean, against bounds of `0.25` and `0.005`.
The previous bound, `darkening > 1e-4`, was 300000× looser than the signal it
stood in for. The same test now also asserts side A's receiver does NOT
darken, which is the premise the `b-only` policy rests on. A case that
declares `b-only` and is NOT the lights path fails `cases.test.ts`, which pins
the membership.

### 2. A packed debug plate is gated per channel, on the channels that reach rendering

**The defect in the instrument.** `DEBUG_SHOW_SHADOW_MAP` packs three
heterogeneous atlas quantities into RGB with per-channel scales
(`clouds.frag:279-293`): `frontDepth × 1e-5`, `meanExtinction × 10`,
`(maxOpticalDepth + tail) × 0.01`. `frontDepth` has no consumer above the
march's own out-of-range fallback: `readShadowOpticalDepth` computes
`distanceToFront = max(0, distanceToTop − distanceOffset − frontDepth)`, so a
texel can only shade when `frontDepth < distanceToTop`, and at this case's
geometry the two sides' fallback values (side A pinned at fp16's 65504,
because the reference stores metres while the port stores unit space per
ATTACHMENT UNITS; side B at `getShadowRayNearFar`'s `1e6`) sit above the whole
plausible range. Both clamp to `od = 0` on the same texels — the casting texel
sets match to 0.17 points at the case's real `distanceToTop`, and stay inside
1.5 points across a 5 000–20 000 m sweep. So the plate rendered a 15.25×
difference in a quantity both sides discard, and the phase-4 0.98 plate bar
scored that.

**Decision.** A case may declare `atlasChannelGate`: which channels DECIDE
RENDERING and the per-channel agreement each must hold to. Every channel is
measured and written to `metrics.json`; only the declared ones are gated, so an
ungated channel's divergence can neither fail the case nor excuse the gated
ones. A gated channel whose mean is not positive on BOTH sides is REFUSED, not
divided — a zero mean is an absent quantity, and 0/0 must not read as
agreement. `debug-shadow-map` declares `['g', 'b']` at 5 %: those are
`meanExtinction` and `maxOpticalDepth`, which is what `exp(-od)` is built from.

A per-channel ratio is a plate-level quantity, so it carries the case's
post-lighting factor `K` (the plate is `channel × scale × K`). The gate is
therefore a statement about the RENDERED channel content, not a raw-atlas
comparison: it bounds atlas divergence only to within the sides' own `K`
agreement. The K-free raw-atlas comparison needs the side-A atlas readback,
which side A cannot expose today; until it exists, 5 % is the tightest bound
the common instrument supports.

Measured on the re-capture (Mini, 2026-10-05), which reproduced the committed
`debug-shadow-map` numbers exactly (gated ssim 0.381061, histDist 14.0901):

| channel | quantity | B/A | gated |
|---|---|---:|---|
| R | `frontDepth × 1e-5` | 15.2561 | no |
| G | `meanExtinction × 10` | 1.0046 | yes |
| B | `(maxOpticalDepth + tail) × 0.01` | 0.9842 | yes |

5 % leaves a 3.2× margin on the worst gated channel. The R column is written
to `metrics.json` on every run precisely so the divergence cannot go quiet.

**Consequence.** `debug-shadow-map` carries an exact-name `accepted[]` entry
with an `ssim` floor for the frontDepth channel's storage divergence, and the
atlas-channel gate is its positive receipt. The floor is the measured footprint
minus Amendment 7's `1.1e-5` cross-session floor, and a drop below it is a new
failure, not the accepted one. The same entry is removed, and the case
re-captured, the moment the debug view's channel set changes.

### What this does not change

No phase floor moves. No wildcard is used. The plate check, the metricsVersion
check and the e2e-receipt check still run first and are never downgraded. The
two receipts keep their capture-time and verify-time standing: a red receipt is
a hard fail that `accepted[]` cannot downgrade, which is why the accepted entry
above carries a FLOOR and not a waiver.


## Consequences

- The scaffolding stage needs no metrics. Its acceptance was the gates plus a
  curved-deck and composite smoke test.
- Metrics are mandatory from the first capture onwards.
- A case that cannot run on one side shows "not yet", never a substitute render.
- Gate numbers print on every parity page per build.
- The STBN jitter volume and Bayer phase are shared between sides (ADR-009).

## References

- ADR-009 (STBN jitter volume)
