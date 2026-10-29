# Parity E2E Tests

End-to-end tests for the parity harness using Playwright + Chromium with WebGPU.

## GPU Modes

Controlled by `PARITY_GPU` env var:

- **`software`** (used only by the manual CI `e2e` job, which asserts that the harness gate refuses it: a GitHub runner has no GPU): Bundled Chromium headless with SwiftShader — WebGPU on a software rasterizer. Renders at 320x180 with `qualityPreset = 'low'` and `maxIterationCount = 64`. `timestamp-query` is unavailable.
- **`hardware`** (local default): System Chrome (`channel: 'chrome'`) with real GPU. Used for captures and full-resolution scenarios.

## Running

```bash
# All e2e tests
pnpm --filter parity e2e

# Phase 0 only
pnpm --filter parity e2e --grep p0

# With explicit GPU mode
PARITY_GPU=software pnpm --filter parity e2e --grep p0

# From repo root
pnpm e2e
```

## Ports and which tree answers

Every checkout used to pin 4173 / 5199 / 5200 with `reuseExistingServer: true`,
so a server another worktree left listening was adopted silently and the run
measured **that** tree.

- **Ports are per run.** `PARITY_E2E_PORTS=parity,basic,r3f` when set, otherwise
  an OS free-port probe. A malformed or partial override refuses rather than
  falling back. Resolved once at config load and published as
  `PARITY_HARNESS_URL`, `PARITY_BASIC_URL`, `PARITY_R3F_URL`.
- **`reuseExistingServer` is false everywhere**, so a run starts its own servers
  or fails. `--strictPort` is set too: without it Vite walks to the next free
  port, so a server can come up where nothing is checking.
- **A served-tree gate refuses the rest.** `globalSetup` asks each server over
  HTTP whether this tree's root is inside what it serves. Vite answers
  `/@fs/<abs>` with 200 inside `fs.allow` and 403 outside, so our root reads
  200 and another checkout's reads 403. An absent answer refuses too.

Specs never hardcode an origin; they read the three env vars, so a diagnostic
names the port that actually answered.

## Adapter Check

Every run asserts `navigator.gpu.requestAdapter()` resolves. No adapter = failed run. Set `E2E_ALLOW_NO_GPU=1` to skip instead of fail on machines without any GPU path.

## Probe API

With `?case=<name>&e2e=1` the harness exposes `window.__parity`:

| Method | Returns | Description |
|--------|---------|-------------|
| `errors` | `string[]` | Console errors since load |
| `warnings` | `string[]` | Console warnings since load |
| `set(partial)` | `void` | Apply partial state to both sides |
| `renderOnce(side, {time, frame, warmup?})` | `void` | Render one frame with pinned time/frame |
| `readLinear(side)` | `{width, height, data: Float32Array}` | Full pre-tonemap composite: WebGL readPixels on A, async render-target readback on B |
| `readSceneLinear(side)` | `{width, height, data: Float32Array}` | Full pre-tonemap scene/atmosphere plate; refuses the read unless clouds are disabled on that side |
| `readLayer()` | `{width, height, data: Float32Array}` | Side B layer RT readback (rgb + opacity) |
| `readDepthVelocity()` | `{width, height, data: Float32Array}` | Side B depth/velocity RT |
| `stats(side)` | `{frame, time, targets[]}` | Render target metadata |
| `regions(side)` | `{sphere, plane}` | Screen-space bounds from case camera |

Every probe call logs `[parity][<case>][<side>] <call> <k=v...> ms=<n>`.

Side A readbacks use `gl.readPixels` (atomic with render in same evaluate call).
Side B canvas readback uses Playwright element screenshots — `drawImage` from a WebGPU
canvas returns zeros in headless Chromium because the canvas texture expires after GPU
command submission. RT readbacks (`readLayer`, `readDepthVelocity`) use
`readRenderTargetPixelsAsync`.

## Phase 0 Scenarios (`p0.spec.ts`)

All on `baseline-medium` unless noted:

1. **boots** — both sides ready; `errors` empty
2. **non-blank** — both canvases have luminance variance > 0
3. **layer encoding** (`orbit-140km`) — opacity in [0,1]; sky pixels = 0; shell pixels > 0
4. **enabled=false** — B's composite loses its cloud contribution when clouds
   are disabled (0.009481 → 0.003485) and still renders the scene. It asserted
   only "non-black", which would pass whether or not `enabled` did anything — and
   it did not.
5. **resolutionScale** — layer target resizes at 0.5 vs 1.0
6. **struck: post-lighting runtime toggle** — `lighting` is a
   case-construction mode (`'post' | 'lights'`), not a probe `set()` key. The
   former test rendered `baseline-medium` twice and only asserted that both
   reads were non-black, so it could not detect a lighting change. Static mode
   wiring is covered in `sideB.test.ts`; case-level pixel coverage belongs to
   the phase-3 lighting cases.
7. **no double sky** — sky pixel luminance unchanged by cloud disable
8. **punch-through** (`inside-deck`) — sphere pixel has layer opacity 0
9. **camera trap** — moving camera changes shell readback
10. **jitter alive** — frame 0 vs 1 differ; frame 0 twice is identical
11. **side A frame pin** — `renderOnce('A', {frame:3})` twice is identical; frame 3 vs 4 differ
12. **enabled round-trip** (`baseline-medium`) — BOTH sides lose most cloud
    structure when clouds are disabled and regain it exactly when re-enabled
    (A 0.010005 → 0.003373, B 0.009481 → 0.003485). Side B went unasserted
    first: its runtime toggle bumped `graphVersion` and rebuilt nothing, so
    asserting it earlier would have pinned a dead instrument as a passing test.

    Not `baseline-low`, and not "scene agreement". `readLinear` returns the
    scene, not a cloud-only composite, so "disabling empties the plate" was
    false by construction.

    `baseline-low` rendered side A pure black at the time, and my first two
    explanations for that blamed the camera and were both wrong — it looks
    straight down, but so do `baseline-medium` and `orbit-140km`, which work.
    The cause was the SUN: azimuth 90 put it below the horizon at that pose
    (resolved Y −0.3979), so the case was posed at night. The case is fixed and
    renders now, and this test stays on `baseline-medium` because the
    round trip does not need a second pose to be meaningful.

    The scene-agreement intent needs a scene-pass readback added to the probe
    and is tracked separately.

## Height-Residue Invariant (`heightResidue.spec.ts`)

Every committed case is 1280×720 or 320×180, heights ≡ 0 mod 4, and the
temporal upscale's Bayer row phase once mirrored the absolute row, correct only
at heights divisible by 4. That streaked every real browser window
while the ladder and 1531 unit tests stayed green. This spec renders
`sky-horizon-low-sun` with the temporal upscale on at 1280×720 and again at
heights 717/718/719 and widths 1277/1278/1279 through the harness's
`?w=&h=` override (`routing.ts`; both sides, capture never sets it), and
asserts the directional gradient ratio mean|Δy| / mean|Δx| over the frame
interior moves by at most 0.10 from the 720-row value — on side B, and on
side A as the positive control that the statistic is size-invariant on a
correct renderer. Red-proved against the reverted fix: B moved +0.27 /
+0.24 / +0.22 at the three height residues and ≤ 0.01 elsewhere; the fixed
build moves ≤ 0.013 everywhere. The case matters: on `baseline-medium`
(straight down, grain-dominated) the same revert moved it only 0.03.

The width sweep found a second defect on the way: three 0.185 returns WebGPU
readbacks with 256-byte row padding, which every harness consumer indexed as
tight rows — invisible at 1280 and 320 columns (multiples of 16), a 3 px/row
shear at 1277. `src/readback.ts` (`unpadRows`) strips it at every readback.

## Artifacts

On failure: `test-results/e2e/runs/<run id>/<scenario>/A.png`, `B.png`, trace,
and log. Each run gets its own `<run id>` folder (an ISO timestamp, or
`PARITY_E2E_RUN_ID` when set), because Playwright empties its output folder at
the start of every run and used to delete the previous failure's trace. Old run
folders are not pruned automatically.
On success: log only.

Reporters: `list` + `junit` (`test-results/e2e/junit.xml`) + `html` (`test-results/e2e-report/`).

Page loads: specs open parity cases through `loadCase` in `pageLoad.ts` and
import `test` from it. When a page never publishes `window.__parity`, the error
and a `page-load-diagnostics` attachment report the last boot stage the harness
logged, document visibility, whether `requestAnimationFrame` still fires,
pending requests and GPU device loss. The attachment is also written when the
test timeout fires mid-load.

## Adding a Scenario

1. Add a `test(...)` block in the appropriate `pN.spec.ts`
2. Use `loadCase(page, 'case-name')` to navigate with `?e2e=1`
3. Use the `probe(page)` helper for all readbacks
4. Always set explicit `time` and `frame` through the probe — never depend on wall-clock time
5. Use linear readbacks, not `canvas.toDataURL` (which is tone-mapped)

## SwiftShader Caveats

- `timestamp-query` and large workgroup limits are absent
- `rgba16float` MRT and `Data3DTexture` sampling work (core WebGPU)
- Per-frame cost at 320x180 low preset should stay < 2s
- If a scenario exceeds the 60s timeout, reduce that scenario's `maxIterationCount`

## Opt-In Visibility (`experimentalVisibility.spec.ts`)

Nothing in the unit suite can see an experimental option render nothing:
`compileWGSL` on a bare pass node is an 814-byte stub, so the composite path is
out of reach, which is how cirrus shipped inert and how `directionalSkylight`
was misreported. This spec renders `sky-horizon-low-sun` at 640×360 with
`time = 12.5`, `frame = 0` and 32 warm-up frames from cold history, THREE arms
per option: flag off, flag off again, then flag on. The off-vs-off pair is that
configuration's own noise floor (temporal accumulation, fp16 attachment
rounding, the readback path), and the assertion is `on - off > 4 × floor` plus
an absolute floor, so an option that moves nothing inside its own bracket fails
instead of passing. Every row also asserts the on arm read back as on, that no
console errors appeared, and that the arm holds cloud pixels.

Measured on hardware (`PARITY_GPU=hardware`, ratio = delta rmse / noise rmse):

| option | noise rmse | delta rmse | ratio |
| --- | --- | --- | --- |
| `convectiveProfile` | 0 | 1.357e-2 | n/a (floor is zero) |
| `proceduralWeather` | 0 | 1.163e-2 | n/a (floor is zero) |
| `evolvingWeather` | 2.794e-5 | 1.560e-2 | 558× |
| `cloudTypeMap` | 2.794e-5 | 1.364e-2 | 488× |
| `distantCloudShadows` | 9.548e-5 | 6.340e-3 | 66× |
| `cloudTypePreset:overcastSheet` | 9.548e-5 | 3.695e-2 | 387× |
| `scenePreset:hazy` | 4.476e-5 | 3.531e-2 | 789× |
| `directionalSkylight` | 2.794e-5 | 3.547e-5 | 1.3× (excluded) |

Two rows carry settings their preconditions need, and the settings go on ALL
three arms so the flag is still the only difference. `distantCloudShadows` is
documented inert at defaults, acting only beyond ~87-100 km and only where the
sun march takes zero steps, so the row sets a shadow-casting layer and
`clouds.maxIterationCountToSun = 0`. `proceduralWeather` is a NO-OP on this
harness and the reason is not a wiring bug: `syncProceduralWeather` returns early
when a caller has set `localWeatherTexture`, because a caller-set texture always
wins, and `sideB.ts:258` always assigns the baked PNG. Measured with the flag
alone the plate was BIT-IDENTICAL (delta exactly 0), so the row clears the
caller texture on every arm. Its off arms are then a sky with no weather map,
which is the state the flag is defined against, so only the on arm is required
to hold clouds.

`scenePreset:hazy` is a whole-scene preset rather than a flag, so its row has
`flag: null` and an `arm` that calls `applyScenePreset`, which writes cloud type,
coverage, haze and the sun in one call. The sun is part of what that row measures,
and the row resets the sky to the default in `prepare` because the harness does
not reset between rows and the row before it leaves the overcast sky behind.
Note that `ctx.cloudLayers.reset()` is NOT the default sky: it copies
`CloudLayer.DEFAULT` into all four lanes, and the default is `CloudLayers.DEFAULT`.
The first version of this row used `reset()` and its off arms came back with zero
cloud pixels, which the guard caught.

`directionalSkylight` is excluded with the documented reason
(`docs/EXPERIMENTAL.md` keeps it opt-in because `cloudsPass.composite()` throws
while building the whole pass graph) and the measurement, and the exclusion
asserts the OTHER way round: the option must stay inside its own bracket, so the
day it starts working the row fails and says to promote it out of the excluded
set. Red-proved by short-circuiting `buildDistantShadowExperiment` to return
`undefined` even with the flag on: `distantCloudShadows` went from 6.340e-3 to
exactly 0 and the spec failed on "did not clear its noise bracket".
