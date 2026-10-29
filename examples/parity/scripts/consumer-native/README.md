# Installed recipe native qualification

This harness consumes the **retained, passing CPU receipt** from
`scripts/release/qualify-consumer.mjs --receipt PATH --keep-projects ARCHIVE`.
It never rebuilds a recipe or modifies its source. Run on the exclusively reserved
native GPU bench, after CPU checks and archive qualification:

```sh
TMPDIR=<tmp> node examples/parity/scripts/consumer-native/run.mjs \
  <tmp>/consumer-cpu-receipt.json <tmp>/consumer-native-evidence
```

The parity workspace supplies Playwright. Installed Google Chrome is launched
headed; there is no software fallback. Every scenario uses a fresh browser
context and the actual application's single GPU device. Browser API observers
forward the original arguments and promises; they do not access library internals,
add application globals, request a second adapter, or alter recipe source.

## Required evidence

- Exact archive bytes, all installed package files, archived recipe inputs,
  consumer lockfiles, and both production build inventories are rehashed before
  and after the run. The native receipt binds the complete CPU receipt, harness
  modules, PNG decoder, Chrome flag helper, tool versions and selected device.
- Six production scenarios: vanilla helper/manual and R3F, each at root and
  nested bases. HTTP and browser response bytes must equal the CPU build manifest;
  all four real cloud asset payloads must arrive. Missing assets never get an HTML
  fallback. External requests, unexpected HTTP failures, page errors, GPU errors,
  shader warnings, software/unknown adapters, and empty input sets fail.
- One additional R3F **development** scenario uses the retained consumer's own
  Vite. Served transformed module hashes are recorded separately from production
  bytes. React and reconciler development code must actually be served. Before
  user remounts, both volume assets must show public fetch cancellation then a
  successful replacement request, observing effect cleanup/restart under the archived
  StrictMode wrapper. This does not claim an exact count of private cleanups.
  PNGs use non-abortable Image transport, so no PNG cancellation is claimed.
  Development detection parses served JavaScript for executable React diagnostics
  and the pinned reconciler's development DevTools metadata, not filename/license
  comments that Vite can remove. These syntax checks do not establish execution;
  the separate pre-remount cancellation/replacement evidence remains required.
- HTTP 304 is accepted only when its conditional request matches an earlier
  completed 200 response's ETag at the exact URL. A returned ETag must also match;
  Vite can omit it on 304. The receipt links that earlier hashed
  response, without claiming a new body or crediting another asset delivery.
  Production 200 bytes still must match the CPU build manifest. Missing prior
  bytes, changed validators, and other unsuccessful statuses fail.
- Public UI only: pause, seek, clouds on/off/on, resize and resize back, two R3F
  remounts preserving off/on intent, and idempotent final disposal. The same device
  must survive remounts, then be destroyed exactly once after final disposal.
  Completion waits for that device's observed destruction and `destroyed` loss,
  not a fixed Fiber teardown delay. Three browser animation opportunities after
  completion and again after the repeat stop click must retain the raw frame
  counter. Missing completion or animation opportunities time out and fail.
- Every pixel capture masks and excludes the HUD. Bounded convergence requires
  three raw-pixel recurrences to one fixed anchor, each separated by at least
  64 observed public frames. Discovery waits alternate 12/13 frames, with
  explicit phase-guided opportunities once a reference or anchor exists.
  Pixels must be nonflat/nonblank; on/off contribution must exceed same-state
  noise and the fixed thresholds in `pixels.mjs`. Restoration, resize/seek and
  helper/manual comparisons have separate fixed tolerances. No threshold adapts
  to a failing result, and no missing case is reported as a pass.

## Temporal measurement

Paused recipe time does not freeze the sample index. The resolve uses a 16-phase
Bayer pattern and generated jitter uses 64 slices (`src/resolve/cloudsResolve.ts`
and `src/march/jitter.ts`). The first native attempt incorrectly required
adjacent screenshots to converge to one image. Its retained evidence showed
healthy cloud pixels and a recurring four-capture orbit: adjacent raw MAE was
0.006–0.009 while corresponding recurring frames were byte-identical. This is a
measurement correction, not improved rendering or a new visual-quality claim.
The original failed receipt and PNGs must remain intact.

`createPhaseSampler` from `sampler.mjs` is also available to independent consumer
exercises. Construct it once per state, then call `push({ image, name, before,
after })` for each decoded raw PNG. `image` has the `decodeScreenshot` shape;
`before`/`after` are public rendered-frame counters read immediately around the
capture. They bracket the observation, not an assertion of the compositor's exact
sample phase. The sampler reports raw adjacent differences, fixed-anchor identity,
every recurrence index and conservative frame gap, and a terminal `ready` flag.
Stop pushing after `ready`; a second completed push is refused.

History is bounded to 64 captures. The first eligible recurring image becomes a
fixed anchor; three later matches must each remain within the original raw
0.001 mean-difference bound and be at least 64 frames after the previous matched
capture's upper bracket. An anchor with no match for 64 captures expires, resetting
all its hits. Comparing to a sliding previous frame cannot hide gradual drift.
No spatial filtering, averaging, post-hoc noise calibration or tolerance increase
is applied. This witnesses a recurring observable image, not every possible
temporal phase or a full-cycle average.

Optional `{ reference, referenceLimit }` constrains every eligible candidate to an
immutable original image. Only the existing 0.001 same-state or 0.002 restoration
limits are accepted. On-repeat uses the original on image; restore, resize-return
and remount use the original on/off state; manual composition uses the completed
helper image for the same base. These still independently require three fixed-
anchor recurrences. All raw samples and rejected adjacent differences remain in
the receipt. The global 90-second state deadline still fails missing recurrence.

`createPhaseCadence` in `cadence.mjs` schedules observations, never acceptance.
Call `plan({ currentFrame, iteration, hint, lastMatch })`, wait until the public
frame counter reaches `waitUntil`, capture, then call `observe(plan, capture)`.
The hint supplies a previous capture's `before` counter; only its residue modulo
64 is used, so resetting the recipe clock does not inherit an old absolute
deadline. The most recent matched capture supplies `lastMatch.after`.

An independent app may expose separate monotonically increasing rendered-frame
and resettable sample-frame counters. In that case, keep the monotonic counter
for recurrence gaps, but translate a saved sample-phase hint into the current
monotonic timeline after a seek. Reusing its old monotonic residue can miss the
reference phase indefinitely. Record both observed counters; the hint still
only schedules captures and cannot make a pixel comparison pass.

The planner reserves a whole-64-cycle target beyond the last guided/matched
upper bracket plus 64 frames. Nonzero screenshot spans therefore normally make
guided captures at least 128 frames apart. Observed wait-to-capture overhead is
used to request the next observation slightly earlier; the actual brackets and
any miss remain recorded. This does not infer an exact GPU/compositor phase.
Raw recurrence and original-image bounds still decide every pass or failure.

Ordinary discovery captures continue between guided opportunities. This matters
for a transient anchor: waiting several cycles between every single capture
would delay the existing 64-capture expiry past the state deadline. The planner
instead avoids a discovery capture whose observed duration would straddle the
next guided opportunity. It changes neither the fixed-anchor sampler nor its
expiry, three-match requirement, frame gaps, visibility checks or pixel limits.

`receipt.json` is written after each scenario and on failure. PNGs and response
hashes are supporting evidence, not committed fixtures. These are display-space
8-bit RGB/RGBA screenshots, not linear HDR readbacks or a quality-parity claim.
The existing PNG decoder deliberately refuses other PNG formats.

This is installed-recipe acceptance, not the whole epic: integrated public-API
native tests cover camera/world/sun/shadow changes and low-level depth updates;
CPU ownership tests prove individual resource disposal boundaries. A separate
unfamiliar-agent exercise covers archive-only discoverability and deeper pinned
peer API work. Production StrictMode markup alone is never replay evidence.

## CPU guard tests

```sh
pnpm exec vitest run test/consumerNative.test.ts
```

Tests deliberately reject stale/extra/escaping files, empty measurements,
software/unused devices, absent development cleanup/restart evidence,
HUD-only differences, blank output, noisy baselines and failed restoration.
They exercise validated 304 revalidation, delayed disposal signals, mismatched or
missing disposal, and unchanged frame samples without sleeping for Fiber cleanup.
They also run the exact-base HTTP server against real temporary files. They do
not launch Chrome or claim GPU success. On this machine use `TMPDIR=/tmp` to avoid
the separately diagnosed macOS temporary-ancestor Vite config startup slowdown.
