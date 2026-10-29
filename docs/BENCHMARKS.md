# Portable Performance Benchmarks

This is an opt-in performance experiment, separate from the acceptance gates.
It compares independently built old/new revisions and WebGL/WebGPU on one
otherwise idle machine, then compares matching reports across machines.
It does not change any gate, threshold, or committed parity capture.

## Three Protocols, Not One

The port is timed three ways, and they answer different questions. The README's
headline figures come from the first two, not from `pnpm bench`.

1. **The consumer path** (`examples/storybook/scripts/perf.mjs`): the port's
   Storybook Basic story against the WebGL original's Basic story, each at
   **its own library defaults**, at one viewport and DPR. It reports an uncapped
   rAF mean frame, which is a wall-clock number for the whole page, so it
   includes everything the two pages happen to do and nothing the GPU timestamps
   would attribute. It is the closest thing to "what a user of either library
   sees", and it is the figure the README quotes.
2. **The parity harness** (`examples/parity/scripts/benchmarks/stages.mjs`,
   summarised by `stages-report.mjs`): the A/B cases of the parity harness with
   **settings matched**, split into per-stage GPU cost by paired knock-out, with
   each side's own sample counts read back from its march target. It reports GPU
   milliseconds, and it is where a per-stage or per-sample claim can be made.
3. **The portable suite** (`pnpm bench`, the rest of this document): old/new
   revisions and WebGL/WebGPU across a fixed experiment matrix, for comparing
   machines. It does not produce the README's figures.

Two things follow, and both are easy to get wrong:

- **A stage cost is a marginal, not a total.** `stages.mjs` times a frame with
  one stage knocked out and subtracts it from the adjacent base frame, because a
  timer query around one WebGL pass reads the whole command buffer instead. A
  stage whose output a consumer reads can therefore read low, and a WebGPU pass
  that is emptied still runs its clear.
- **The harness's own A/B GPU timer is not the harness's verdict.** It runs both
  renderers in one page, which is what makes the parity capture possible and
  what makes it unsuitable as a timing reference for either side. Quote protocol
  1 or 2 numbers; never a cross-contaminated A/B figure.

## Prepare Each Machine

Use the same benchmark branch and revisions on every machine. Install Node 24,
the repository's pinned pnpm through Corepack, and Google Chrome with
hardware acceleration. On Windows, use PowerShell and a normal Windows Node
installation; do not run the GPU benchmark inside WSL.
Use LF checkouts on every machine (`core.autocrlf=false` when cloning), since
source provenance hashes the actual file bytes, not just Git's commit ID.

From the benchmark checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm bench:prepare --old-root ../clouds-benchmark-old
```

The old revision defaults to the pinned baseline in
`examples/parity/scripts/benchmarks/prepare.mjs` (the `old-ref` default), and the
new revision is the checkout supplied to `--new-root`. Both revisions are rebuilt
before each run. The old worktree receives its own
workspace install; sharing `node_modules` between revisions is not valid.
Preparation refuses to overwrite an existing directory. For subsequent runs,
reuse the prepared root without preparing it again.

Use `--old-ref <commit>` with `bench:prepare` for another baseline, and choose a
different destination. Do not mix baselines when comparing machines: a ratio is
only comparable within one baseline.

## Validate Before Measuring

```sh
pnpm bench --profile smoke --old-root ../clouds-benchmark-old --new-root . --machine m5-pro --output test-results/benchmarks/m5-smoke.json
```

Smoke runs validate browser startup, both revisions, both renderers, timing,
settings, and rendered pixels at 640x360. They are always marked
`publishable: false`; the comparator will not derive speedup ratios from them.
Use distinct filenames for subsequent runs.

## Run On An Idle Machine

Close other GPU applications and animated browser tabs, stop other captures,
connect laptops to power, disable low-power mode, and let the machine cool to
a repeatable starting condition. Keep the benchmark Chrome window visible and
do not interact with it. The tool records the actual selected GPU; on a hybrid
Windows PC, verify that Chrome selected the intended NVIDIA GPU. Software
renderers are not accepted as hardware results.

Idle confirmation is an operator assertion, not automatic proof that the
machine is idle. The runner never terminates unrelated applications.

macOS / Linux shell:

```sh
BENCHMARK_IDLE=1 pnpm bench --profile standard --old-root ../clouds-benchmark-old --new-root . --machine m5-pro --output test-results/benchmarks/m5-standard.json
```

Windows PowerShell:

```powershell
$env:BENCHMARK_IDLE = '1'
pnpm bench --profile standard --old-root ../clouds-benchmark-old --new-root . --machine nvidia-desktop --output test-results/benchmarks/nvidia-standard.json
Remove-Item Env:BENCHMARK_IDLE
```

Use labels such as `m4-mac`, `m1-mac`, and `nvidia-desktop` on the other machines.
Keep Chrome versions, plan, revisions, and power conditions consistent. The
runner starts its own localhost servers on available ports and closes its own
servers/browser afterwards. Raw samples are checkpointed as the matrix runs;
failed cases remain visible and cause a nonzero exit.
The `.checkpoint.jsonl` journal has one metadata header followed by one record
per completed arm. It is append-only to keep long matrices from repeatedly
rewriting previous samples. Use the final `.json` report with the comparator;
an interrupted journal is diagnostic evidence, not a completed score.

## Matrices

- `smoke`: a small functional check, not performance evidence.
- `standard`: four local scenes at 1080p; all experiments off, each of five on
  separately, all on, and each one removed from all-on. Each measured run has
  64 warmup frames and 120 samples, repeated three times.
- `full`: all 32 experiment masks, 1080p and 4K, temporal upscale on/off,
  paired static/moving workloads, with scenes covering shafts and temporal
  shadows on/off. It has 12,288 arms including explicitly unsupported arms;
  3,360 arms are measured with the default old/new revisions.
  This is a long unattended run, potentially many hours rather than minutes.

The five experiments are `cloudFrontRefinement`, `computeResolve`,
`windReprojection`, `distantCloudShadows`, and `directionalSkylight`.
WebGL and old revisions do not acquire fictional experiment switches:
unsupported combinations are recorded explicitly, not measured as duplicates.

That list is the benchmark matrix's, not the library's: `plan.mjs` pins the five
in `EXPERIMENT_KEYS`, which is why `full` sweeps 32 masks rather than 64. An
experimental option added to `CloudsContext` later is outside these arms until
the key list grows, so a matrix run is not a measurement of every option the
library offers. See [EXPERIMENTAL.md](EXPERIMENTAL.md) for the current list.

Inspect the complete deterministic schedule before starting:

```sh
pnpm bench --profile full --dry-run
```

For a custom fixed matrix, take the `plan` object from a dry run, store that JSON
as a plan file, and supply `--plan path/to/plan.json` instead of `--profile` on
every machine. Scene entries specify `caseName`, `workloadId`, physical
`width`/`height`, `dpr: 1`, `motion: "static" | "shape"`, and a `settings` object.
Keep workload IDs unique for differing shared settings. Change the plan ID
when intentionally changing the experiment. Do not compare a custom plan to
the built-in plan as though they were the same test.

## Timing And Validity

The workload is repeatable, not the measured duration. The suite fixes assets,
camera, physical pixel dimensions, frame indices, and motion timestep. The
seed controls job ordering, and old/new order alternates between repetitions.
Only the selected renderer runs during sampling; the other renderer is disposed
before warmup. Network-loaded tiles are excluded. Authored Toronto/Mount Fuji
Storybook scenes remain useful for visual review, but their streamed content
is not this numeric benchmark's input.

- `gpuMs`: WebGL disjoint timer-query interval, or WebGPU first-to-last timestamp
  across the frame's render and compute passes. This is the comparison metric.
- `gpuRenderMs` / `computeMs`: WebGPU pass-duration sums for diagnostics. Passes
  can overlap on tiled GPUs; do not add these and call the result frame time.
- `renderMs`: CPU submission duration, not GPU duration.
- `wallMs`: submission to observed GPU completion. WebGL fence polling adds
  scheduling overhead; this is diagnostic, not a backend speedup metric.
- `probeMs`: the fixed ALU probe timed right after each frame (see Clock
  State). `gpuMs / probeMs` is the frame in probe units, the number the
  comparator uses whenever both sides of a ratio have it.

Warmup, requestAnimationFrame pacing, timestamp readback, screenshots, and
post-run pixel validation are outside the measured GPU interval. Every sample
waits for the previous GPU workload to complete. Consequently these numbers
measure isolated frame cost, **not sustained application FPS**. A reciprocal
of GPU milliseconds is not a promised interactive frame rate.

Missing timers remain unavailable; wall time is never substituted for GPU time.
Disjoint WebGL batches are rejected. Empty/partial sample batches, blank images,
non-finite pixels, wrong dimensions, settings that did not apply, stale or
misresolved builds, and browser errors cannot silently become valid scores.
Reports retain browser/GPU information, settings, source/build provenance, and
raw samples. An unsupported row is not evidence of zero cost.

## Clock State

The Apple M4 Mac mini's GPU runs in discrete clock states and changes state
on its own, both between runs and inside one. A frame timed in milliseconds is
therefore work divided by whatever clock that frame happened to get. This is
not noise that more repetitions average out: removing work from a frame
(a knock-out) moves the GPU into a slower state, and it moves the two renderers
by different amounts. On 2026-10-08 the same shaders gave a knock-out march
ratio of 1.34x in one harness and 0.79x after only adding a dispatch after each
frame; normalised by the clock both read 1.00-1.06x
(`perf/2026-10-08-marchcost/`).

Every timed frame is now followed by a fixed ALU probe: one dispatch of a
dependent-FMA kernel (1024 x 64 threads x 2048 iterations, about 0.40 ms in the
fast state) on its own WebGPU device, outside the measured window. The probe
also runs after every warm-up frame, so warm-up and sampling load the GPU the
same way. `examples/parity/scripts/benchmarks/clock.mjs` holds the probe and
the checks, and both `pnpm bench` (`browser.mjs`, `run.mjs`, `compare.mjs`)
and the knock-out tool (`stages.mjs`, `stages-report.mjs`) use it.

- **Probe units.** A frame over its probe is proportional to GPU cycles to the
  extent the frame scales with the ALU clock. Same work, different clock state,
  same units. The comparator's ratios use units when both rows have them and
  say `ratioBasis: "ms"` (with a warning) when they do not.
  `stages-report.mjs --markdown` prints every stage marginal in probe units
  under the millisecond rows, each frame divided by its own probe.
- **Ramp guard.** A run is unstable when the median of its last third of frames
  differs from its first third by more than 25 %, or when its probe moves by
  more than 15 % inside the run (the clock changed while it ran).
  `run.mjs` prints `UNSTABLE CLOCK` as it happens, the comparator withholds
  every ratio involving that row and lists the reasons in `warnings`, and
  `stages-report.mjs` adds an `UNSTABLE CLOCK (reps)` row.
- **Positive control.** `stages.mjs --self-test-ramp` renders every frame in
  the second half of the timed loop twice: a deliberate 2x step. The guard
  must flag every repetition of it. Run it after changing the guard or the
  probe (record: `perf/2026-10-08-clock-guard/`).

What did not work, so it is not in the tools: a filler dispatch after each
frame (on another device) did not hold the clock up, and it slowed the
reference's frame by about 2 ms. A probe only before and after a run cannot see
a state change inside it. `stages.mjs --heat-ms` and `--probe-band` still exist
and still help start a run in a known state, but they do not replace the
per-frame probe.

How to read a result: quote probe units, or show that the frames you subtract
or divide ended at the same probe value. A millisecond knock-out marginal
between two runs in different clock states is not a measurement of the stage.

## Compare Reports

Collect the matching JSON reports in one checkout:

```sh
pnpm bench:compare --out test-results/benchmarks/comparison m5-standard.json m4-standard.json m1-standard.json nvidia-standard.json
```

One input report is also valid for old/new and WebGL/WebGPU comparisons on one
machine. Outputs are `comparison.json` and `comparison.csv`. The comparator
requires matching plans and source identities, warns about browser version
differences, and refuses duplicate machine labels. Incomplete repetitions do
not receive aggregate scores. Aggregates use the median of repetition medians,
with per-frame p95 and the range of repetition medians reported separately.

Speedup ratios greater than 1 mean the row is faster than the named reference.
Ratios include new versus old, WebGPU versus WebGL baseline, experiments versus
the same-build WebGPU baseline, and each machine versus the first input machine.
Do not interpret a small difference inside run-to-run variability as a win.
Ratios are in probe units when both rows carry per-frame probes (`ratioBasis`
says which), and a row with any unstable repetition gets no ratio at all (see
Clock State). The CSV carries `gpuUnitsMedian`, `probeMedianMs`, `clockStable`
and `ratioBasis`.

## Recorded Results

One idle Apple M4 Mac mini, Chrome 154, Node 24, library `build/shared.js`
sha256 `594e08f7`, every timed run holding the machine's GPU exclusively, both
sides served from the same tree. N=5 with the order alternating every
repetition. Raw reports and the scripts that reduce them are in
`perf/2026-10-04-main/`.

These figures belong to the 2026-10-04 revision and to nothing after it. `main` moved
again shortly afterwards with further cloud-shadow work, including a change that
bounds the shadow atlas's front depth, so a re-run on a later commit is expected
to read differently on the shadow rows in particular. Re-measure rather than
extrapolate.

### Consumer path, library defaults (protocol 1)

| DPR | A (WebGL original) ms | B (port) ms | B/A |
|---|---|---|---|
| 1 | 10.20 [10.20-10.23] | 9.42 [9.41-9.43] | **0.924x** |
| 2 | 18.84 [18.83-18.93] | 20.95 [20.94-21.02] | **1.112x** |

The September 2026 figures were 0.721x and 0.733x. The per-repetition spread is
an order of magnitude smaller than the change at both DPRs.

### Parity harness, settings matched (protocol 2)

`A` against `B-atmos-lookup`, four cases at 1280x720 and 2560x1440:

| case @ size | A frame ms | B frame ms | B/A | A shadow ms | B shadow ms |
|---|---|---|---|---|---|
| baseline-medium @ 1280x720 | 8.30 | 11.44 | 1.379x | 4.72 | 7.20 |
| layers-4 @ 1280x720 | 8.93 | 12.46 | 1.395x | 3.98 | 7.01 |
| shadow-plane @ 1280x720 | 7.42 | 12.70 | 1.711x | 3.83 | 7.98 |
| sky-horizon-low-sun @ 1280x720 | 9.69 | 13.35 | 1.377x | 4.10 | 6.51 |
| baseline-medium @ 2560x1440 | 15.92 | 23.91 | 1.501x | 3.17 | 8.34 |
| layers-4 @ 2560x1440 | 16.40 | 24.05 | 1.467x | 2.63 | 6.53 |
| shadow-plane @ 2560x1440 | 16.01 | 24.15 | 1.508x | 3.28 | 8.20 |
| sky-horizon-low-sun @ 2560x1440 | 16.92 | 24.17 | 1.429x | 2.54 | 5.50 |

September's range over the same cases was 0.99x-1.17x. Both sides got slower
here, and the cloud-shadow pass is why: it read 0.16 ms on A and -0.01 ms on B in
September and reads several milliseconds on both now, because the harness no
longer pins a shadow range the reference never set. That pass is what the
matched ratio now measures. Measured as whole-frame deltas with each side's own
timer, the port's shadow march loop costs about 2x the reference's with every
shadow parameter identical at runtime. The clock-stable figures (2026-10-08,
see "Clock-stable timing" below) are 4.61 ms against 2.20 ms (2.10x) on
baseline-medium and 5.33 ms against 2.18 ms (2.45x) on shadow-plane at
1280x720, about 94 % of the port's frame excess on baseline-medium. The
2026-10-04 figure of 1.88x (8.29 ms against 4.42 ms) was taken after a
48-frame warmup, on the clock-governor plateau, and its magnitudes should not be
quoted. An earlier per-stage figure of 1.53x to 2.63x is withdrawn: on
ANGLE/Metal the reference's timer query is command-buffer granular, so it
cannot isolate one pass on side A.

The table above came from `stages.mjs` with 64 warmup frames, which is the same
plateau regime, so its absolute milliseconds are clock-governor equilibria and
not clean work costs. Its within-session ratios are what it was quoted for.
Three of its four cases (baseline-medium, layers-4, sky-horizon-low-sun) have no
shadow-casting layer, and their shadow rows predate the weather-read skip
(below).

### Clock-stable timing (2026-10-08)

On the M4 mini, a rAF-paced probe leaves the GPU idle between frames, and
the clock governor lowers the clock until the work fills the vsync. A
per-frame trace shows both sides flat for about 15 frames after a page load,
then frame times about doubling over the next 30 frames (side B plateaus near
16 ms, one vsync). Deltas taken on that plateau are non-linear. Every figure
in this section and the next is from frames 4-14 after a fresh page load
(warmup 4, 10 frames), with the GPU lock and a QUIET window, n=5 or more,
order alternating every repetition, and spreads tight. Raw data and the probe
are in `perf/2026-10-08-shadowcost/`.

The shadow march loop's cost (frame at 50 iterations minus frame at 1), each
side with its own timer:

| case | atlas | B loop ms | A loop ms | B/A |
|---|---|---:|---:|---:|
| baseline-medium @ 1280x720 | 3 x 256^2 | 4.61 | 2.20 | 2.10x |
| shadow-plane @ 1280x720 | 3 x 256^2 | 5.33 | 2.18 | 2.45x |
| shadow-cascades-2x512 @ 1280x720 | 2 x 512^2 | 15.80 | 5.56 | 2.84x |
| shadow-cascades-4x1024 @ 1280x720 | 4 x 1024^2 | 75.71 | 32.51 | 2.33x |

The ratio holds as the atlas grows to a saturated GPU, so the gap is a
throughput cost per unit of work. On both sides the loop is latency-bound on
the 2D weather-texture fetch. None of the pixel-neutral rewrites of the
emitted WGSL tried in that round moved it, and the report lists what was ruled
out.

### The shadow march skips the weather read when no layer casts

Merged as `648d3a94`. When every layer has `shadow: false`, `shadowLayerMask` is all zero
and the shadow march's weather read is multiplied by it, so the shadow graph now
drops the read. Pixels cannot change (a finite unorm sample times 0 is +0); of
the 63 pinned graph variants only the two with no caster changed their WGSL.

Side B, before against after, both builds served
side by side and interleaved, clock-stable as above. Raw data are in
`perf/2026-10-08-shadow-weather-skip/`.

| case @ size | n | before ms | after ms | change |
|---|---:|---:|---:|---:|
| baseline-medium @ 1280x720 | 7 | 7.638 | 5.667 | **-1.99 ms (-26 %)** |
| baseline-medium @ 2560x1440 | 5 | 15.221 | 10.268 | **-4.86 ms (-32 %)** |
| shadow-plane @ 1280x720 (casters) | 5 | 8.438 | 8.463 | +0.01 ms |

Scope: it applies only when no layer casts a shadow. That is the parity
harness baseline and the other cases without a caster (three of the four
protocol-2 cases above). It does not apply at library defaults, where layers 0
and 1 cast, so the consumer-path figures above are unaffected. With no caster,
the shadow march writes no optical depth on either side (collapsing it to one
iteration leaves baseline-medium's atlas unchanged), so on those cases the
reference still pays for a march whose output is empty.

### Primary march cost per sample

Sample counts are equal to three decimals on every cell (baseline-medium 1280:
2.636 against 2.635 steps per marched pixel, 921600 marched pixels on both
sides), so the per-step comparison is fair. It splits by size:

| size | per-sample march B/A, four cases | verdict |
|---|---|---|
| 2560x1440 | 1.156x, 1.192x, 1.253x, 1.387x | the port's march costs 1.2x-1.4x the reference's |
| 1280x720 | 0.486x, 0.713x, 0.918x, 1.024x | no gap; equal or cheaper |

**Superseded.** These per-sample ratios are millisecond knock-out
differences, and the knock-out frames ran in a different GPU clock state from
the full frames (see Clock State). Measured with the clock controlled on
2026-10-08, sky-horizon-low-sun reads 1.00-1.06x at 2560x1440 and 1.01-1.15x
at 4480x2520, and the port's whole-frame excess is mostly outside the primary
march (`perf/2026-10-08-marchcost/`). The table is kept as the record of what
was measured.

The 1280 march cells should not be read as a per-sample result. There the
shadow pass is 7 ms of an 11 ms frame, passes overlap on a tiled GPU, and the
knock-out's base frames swing by about 4 ms while the march marginal is 1-2 ms,
so the two sides of that subtraction are not comparable at that size. Use the
2560 cells for a per-sample claim.

### Reading these against September

- **Both sides' absolute frame times moved**, so a cross-session ratio of
  absolute milliseconds means nothing. Only the within-session paired ratios
  above are quoted.
- **A's own frame time varies by session by tens of percent** on light
  workloads. Two of the eight cells here have repetition medians more than 10 %
  apart and are reported rather than smoothed.
- **The consumer path is a wall-clock rAF mean**, not a GPU timestamp, and it
  includes whatever else the page does. It is the right number for "what does
  this feel like" and the wrong number for "which pass costs what".
- **The cross-contaminated A/B timer inside the parity capture is not used
  anywhere above.** Protocol 2 is the harness with one renderer live at a time.

## Agent Run Instructions

A cheaper agent can operate the same CLI without changing the protocol:

> Use the portable benchmark suite in this checkout. Read docs/BENCHMARKS.md.
> Verify the requested old/new revisions and run smoke first. After I confirm
> this machine is otherwise idle, run the standard matrix with its machine
> label and a new output path. Run full only when I request the longer matrix.
> Do not edit gates, change settings to improve scores, kill unrelated
> processes, or substitute wall timing for missing GPU timing. Compare the
> report, summarize failures and repeat variability, and report the raw JSON
> and CSV paths. Do not claim a performance improvement from smoke results.
> Report probe-unit ratios, list every UNSTABLE CLOCK warning, and do not
> quote a ratio the comparator withheld.
