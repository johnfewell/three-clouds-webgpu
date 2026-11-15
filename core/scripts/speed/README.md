# The per-pass and knob-sweep bench (`core/scripts/speed/`)

A browser bench for the three package (parity side B) that times every GPU
pass and sweeps clouds knobs over it. It answers two questions the parity
harness cannot: which pass a frame's GPU time goes to, and what an existing
setting buys in milliseconds.

## What it measures

- **Per pass, exclusive GPU ms.** An init script puts a timestamp pair around
  every render and compute pass, on either page, and names each pass by the
  first pipeline set on it. Tiled-GPU passes overlap, so a pass is charged by
  end order: from the later of its own start and the previous pass's end.
  Labels that repeat in a frame (shadow cascades) are summed.
- **Fast-clock ms.** The M4's GPU changes clock state on its own, so every
  timed frame is followed by a fixed ALU probe on its own device and the frame
  is quoted as `frame / probe x 0.40`, the probe's fast-state cost. 0.40 is
  this bench's constant, not the probe's reading; raw ms and probe ms are both
  in the JSON. See `docs/BENCHMARKS.md` "Clock State".
- **Knob arms.** One arm is a named quality preset and/or a list of dotted
  paths into `CloudsContext` (`shadow.updateInterval`, `clouds.minStepSize`,
  ...), applied on top of the case's own parity state and read back, with the
  graph version recorded so an arm that did not apply is visible.
- **A vsync confirmation.** `--vsync` runs a real `requestAnimationFrame` loop
  for a measured window and reports the display's refresh, frames shown,
  frames dropped and the longest interval. This is the only mode whose result
  is a frame rate rather than GPU work.

## Commands

Both run from the checkout root, need `pnpm build` first (the pages import the
package by name), and open Chrome themselves; `gpu-window.sh` holds the fleet
GPU lock and takes an agent name.

```sh
# per-pass map: 40 warm-up frames and 30 timed frames per arm, per scene
sh core/scripts/speed/gpu-window.sh <agent> -- node core/scripts/speed/sweep.mjs \
  --out sweeps/sweep.json --cases baseline-medium,shafts-low-sun \
  --arms base,lightShafts-off --reps 3 --size 2880x1800@2
node core/scripts/speed/sweep-report.mjs sweeps/sweep.json --markdown

# combinations from a JSON file of {id, preset?, set?} arms
sh core/scripts/speed/gpu-window.sh <agent> --quiet -- \
  sh core/scripts/speed/sweep-combos.sh <agent>
# the same three arms with the display's vsync, 8 s each
sh core/scripts/speed/sweep-vsync.sh <agent>

# the five priority groups of the 2026-10-08 sweep into sweeps/STATUS.md
sh core/scripts/speed/sweep-groups.sh <agent> sweeps
```

`--quiet` is for a result that is a TIME (rule: QUIET is never taken for a
correctness run). The scripts pass it themselves where that is true.

Every run prints the number of cases, arms and repetitions it is about to
time, and refuses a zero input. A run whose arm logged a browser error is
excluded from the tables and counted in a line above them.

## Reading the tables

`sweep-report.mjs --markdown` prints, per scene, each arm's frame in
fast-clock ms, its range over repetitions, the saving against the `base` arm,
and which passes the saving came from. The pass attribution is approximate
when an arm changes pass order (temporal upscale does): a pass absent from
some frames, such as a shadow pass on `updateInterval 2`, is averaged over all
frames with 0 for its absent frames, so its cost reads as its share of a
frame, not its own duration.

`passes.mjs`, `summarise.mjs` and `run.mjs` read reports from the older
three-versus-core comparison (`core/scripts/emit-runtime.mjs` emits the
descriptions they need). `sweep.mjs` does not need an emitted description.

## How its numbers relate to `docs/BENCHMARKS.md`

`BENCHMARKS.md` documents three protocols: the consumer path, the A/B ladder
and per-stage knock-out. This bench is a fourth method, and it should not be
mixed with them:

- It uses **the page's own pass timers**, not the capture harness's frame
  timing. The three package here has `trackTimestamp` off and the timestamp
  query is the init script's, so a number from this bench is `three
  GPUCommandEncoder` work, not a capture's reported frame time.
- It quotes **fast-clock ms derived from the same ALU probe** as
  `BENCHMARKS.md`, so a ratio between two arms in one run is comparable to a
  ratio from the other protocols. An absolute ms is comparable only when the
  probe reading matches (about 0.40-0.45 ms); otherwise it is a different GPU
  clock state.
- A cross-check from 2026-10-08 found whole-frame totals within 0.99-1.03 of
  the three package's own totals in all 8 cells (see
  `perf/2026-10-08-perfmap/perfmap.md`, Method).

## Caveats the tool cannot remove

- Background load moves the GPU clock; the ramp guard flags a run whose last
  third differs from its first by more than 25 % or whose probe moves by more
  than 15 %, so an UNSTABLE row is not evidence of a saving.
- Other agents share the bench's GPU. A timed comparison needs the lock, a
  calm machine, and ideally the other project's own lock idle
  (`~/ride-gpu2/.lock`).
- The bench runs a visible Chrome on the desktop session; it will not produce
  the same numbers headless.
