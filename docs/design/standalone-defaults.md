# Defaults for the standalone release

Status: **recommendation only.** The operator decides. Nothing here has been
implemented, and no default has been changed.

This document answers one question for each knob the port added that the original
does not have: **when the port ships as its own public project, is this on by
default, opt-in, or gone?** For each it records the evidence that exists today,
the cost, the risk, and a recommendation.

Every `cw-` reference in this file is internal process. The exporter
(`scripts/release/export-public.mjs`,) must rewrite or drop them;
they are the rewrite list, not prose.

## 1. The decision this informs

The port becomes a standalone project named `three-clouds-webgpu`, published as a
fresh public repository derived from this one's `main`. One
consequence drives every recommendation here:

> **As a standalone project, faithfulness to `@takram/three-clouds` is no longer
> the finish line.** It is the starting line.

A port whose only value is "the same picture, on the new API" should keep every
default identical to the original and put nothing on by default. A standalone
project that is *also* the better tool has a different job: it should ship the
defaults that make the picture better or the frame cheaper, document each one as a
deviation with its numbers, and keep a one-line way back. That is the position this
document argues for, applied case by case, and it does not argue for it
uniformly.

## 2. How the evidence is graded

Four questions, in this order. A knob that cannot answer the first two does not get
promoted, no matter how plausible it sounds.

| | Question | Why it is the question |
|---|---|---|
| **Q** | Quality: is there a *measurement* of what the on-state does to the picture? | A preference is not a default. The measurement has to be in a metric that means something — ladder SSIM against the reference, or a targeted statistic over a named image region. |
| **C** | Cost: is there a measurement of what it costs per frame? | "It should be cheaper" is not a number. A cost nobody has measured cannot be traded against a quality number. |
| **I** | Invertibility: does one documented assignment restore the original's behaviour, with no history or graph surprise? | A default the reader cannot undo is a default they will file a bug about. |
| **R** | Reference-identical off-state: with the option off, is the output the original's? | Otherwise the deviation is invisible, which is the one thing a port must never be. |

### 2.1 The one structural fact that shapes this whole document

`rg experimental examples/parity/` returns **nothing**. The parity harness never
touches the `experimental` object, so all 63 committed captures under
`parity/results/**/metrics.json` ran at *library defaults*, which means **all five
experimental options were off in every capture**. There is no parity capture, no
threshold entry, and no ADR for any of them. The only runtime evidence that exists
is `examples/parity/e2e/experimental.spec.ts`, and the receipt
(`parity/results/e2e-receipt.json`) stores `{spec, title, status}` and no values.

Two consequences follow, and both are load-bearing:

1. **The five experimental options have no quality evidence and no cost evidence.
   That is not an oversight to be noted; it is the current state.** The benchmark
   matrix that would produce the cost numbers is specified in `docs/BENCHMARKS.md`
   (`standard`: all off, each on alone, all on, each removed from all-on) and in
   `examples/parity/scripts/benchmarks/plan.mjs`, and **it has never been run**.
2. **Flipping any experimental default re-baselines all 63 committed metrics.** The
   harness inherits the defaults, so a default flip moves every case. That is a real,
   operator-visible cost and it is the main reason the recommendations below are
   conservative — except for the one option that earned its place with numbers
   (§5.1), where re-baselining is the price of admission.

The fix for (1) is §7's reference mode, and it also removes (2): if the ladder
always runs in reference mode, public defaults become free to change without
touching the parity contract.

### 2.2 What the port already changed, and what it can still change

`README.md:73-79` and `docs/MIGRATION.md` list the deviations the port ships today.
Three are defaults rather than options, and they are the template for every
recommendation here:

| Deviation | Library default | Original | Reached by |
|---|---|---|---|
| Shadow map cadence | `shadow.updateInterval = 2` | 1 | `src/qualityPresets.ts:175` |
| Light-shaft march resolution | `lightShaftsHalfResolution = true` | per fragment | `src/CloudsContext.ts:333` |
| Default jitter volume | `createJitterTexture()` (generated blue noise) | NVIDIA STBN, loaded by the caller | `src/textures/loadBakedCloudTextures.ts:145` |

The public jitter change also has a distribution reason the other two do not: it
removes a network fetch on first use, which matters far more for a public package
than it did inside this repo.

## 3. The register

Recommendation codes: **ON** (default on), **OPT** (keep opt-in, default off),
**DROP** (remove from the public surface).

| # | Knob | Today | Q | C | I | R | Recommendation |
|---|---|---|---|---|---|---|---|
| 4.1 | `cloudFrontRefinement` | off | none | none | yes | yes | **OPT** — measure banding first; it is the strongest promotion candidate |
| 4.2 | `computeResolve` | off | threshold, no value | none | yes | yes | **OPT** — a backend swap, not a quality feature |
| 4.3 | `windReprojection` | off | threshold, no value | none | yes | yes | **OPT** — three silent failure modes; do not promote as written |
| 4.4 | `distantCloudShadows` | off | threshold, no value | none | yes | yes | **OPT** — most promotable after the second fudge is retired |
| 4.5 | `directionalSkylight` | off | none | none | yes | yes | **OPT** — smallest API if the operator wants one cut |
| 6.1 | `shadow.updateInterval` | **2** | yes | yes | yes | no | **ON** — with a re-measure as a release gate |
| 6.2 | `lightShaftsHalfResolution` | **true** | **no** | yes | yes | no | **ON** — only after the missing measurement and the `subgroups` receipt |
| 6.3 | Blue-noise jitter default | **on** | no | n/a (no fetch) | yes | no | **ON** — add one runtime smoke case |
| 5.1 | `distantShapeDetailFade` | not on main | **yes** | **yes** | yes | no | **ON**, conditional — the one promotion the evidence supports |
| 5.2 | Variety epic options | not written | none | none | yes | yes | **OPT**, and expose presets rather than booleans |
| 5.3 | Sun-march count fade | not written | partial | none | yes | yes | **OPT** if it lands; the 28 % figure is not additive |

## 4. The five experimental options

All five live in `src/experimental/options.ts`, all default `false`, all merge into a
single `experimentalFlags` bitmask that feeds the program cache key
(`src/CloudsContext.ts:696-698` → `src/CloudsPassNode.ts:444,869-875`). A changed
value bumps `graphVersion` and calls `resetHistory()`
(`src/CloudsContext.ts:288-311`). Setting a key that is not in
`experimentalDefaults` throws a `TypeError`, which is the right behaviour for a
public package.

`WEBGPU.md:683-684` already states the position this document keeps: *"These
options are experimental, not new parity defaults. The branch does not change the
existing acceptance thresholds or promote changed pictures to the reference
contract."*

### 4.1 `cloudFrontRefinement`

**What it does.** Four bisection steps locate an empty-to-dense bracket using actual
extinction (`src/march/frontRefinement.ts:28-37`), firing in the primary march before
the sample is taken (`src/march/primaryMarch.ts:617-618`) and recorded after
(`:635`).

**Evidence.** No parity metrics, no threshold entry, no ADR, no cost number. The
only runtime check is `examples/parity/e2e/experimental.spec.ts:285-332`, which
computes an RMSE, `console.log`s it, and asserts only `changed > 0`.
`src/march/frontRefinement.test.ts` covers the `Fn` in isolation (CPU twin plus a
WGSL snapshot); **nothing compiles `createMarchClouds` with the flag on.**

**Risk.** One real consequence, and one hazard that turns out to be already handled:
- `primaryMarch.ts:536-541` accumulates refinement samples into the same counters
  `DEBUG_SHOW_SAMPLE_COUNT` reads. Enabling the option would move the
  `debug-sample-count` case, which currently carries an **accepted-difference
  register entry** in `thresholds.json`. Promotion therefore forces a decision on
  that entry, not just a re-capture.
- The bisection `Loop` runs inside the march loop after `Break()` sites, i.e. in
  non-uniform control flow, which can return zeros
  on Dawn. **Checked, and clean**: `sampleWeather` reads at `.level(mipLevel)`
  (`src/density/sampleWeather.ts:73`) and `sampleShape` at `.level(float(0))`
  (`src/density/sampleShape.ts:90,104`), so no implicit-LOD read sits on the
  refinement path. Worth recording because the opposite assumption is the one those
  warnings push you toward, and getting it wrong would look like a quality bug.

**Why it matters more than the others.** `primaryMarch.ts:488` carries a live
`TODO(port)`: *"This produces banding artifacts. Possible improvement: Binary search
refinement"*. This option **is** that improvement, and the port has not shipped it
because it is experimental.

**Recommendation: OPT.** Keep it off, and measure banding before considering
promotion. Banding is measurable without a parity re-baseline — gradient energy or an
intensity histogram along the cloud front, on a fixed pose, on and off. If it shows
the step the TODO describes, this becomes the strongest promotion candidate in the
register, because it fixes a defect the original itself admits to.

### 4.2 `computeResolve`

**What it does.** Replaces two fragment passes with compute kernels: the cloud colour
and light-shaft resolve (`src/experimental/computeResolve.ts`, 8×8 workgroups) and the
temporal shadow-map resolve (`src/experimental/computeShadowResolve.ts`). It also
swaps the resolve and shadow attachments to storage textures
(`src/CloudsPassNode.ts:157-178,2100-2113`).

**Evidence.** One bounded agreement test, run for both `temporalUpscale` settings:
`experimental.spec.ts:147-148` asserts `relativeRmse < 0.005` for compute-vs-fragment
and for a determinism control. **The measured value is not committed** — the receipt
records only `"status": "passed"`. No cost number anywhere;
`WEBGPU.md:664` calls it *"primarily a performance experiment"* and nothing has
measured it.

**Risk.**
- `CloudsPassNode.ts:2232` silently keeps the fragment resolve whenever
  `ctx.debug !== 'none'`. The flag still reads as on — it is in the cache key and the
  benchmark harness reads it back as `true` (`benchmarks/browser.mjs:461`) — while the
  render does nothing different. `debug` + `computeResolve` is untested.
- Every target flip disposes the history texture and forces a full temporal re-warm
  (`:2188`, `:2112`).
- `computeResolve.ts:248` sits at exactly the 12-decision-point clamp
  enforced by the quality gate, so any edit trips the gate.

**Recommendation: OPT.** This is a backend swap, not a quality feature: the only
assertion is that it does not *change* the picture, and nothing says it makes it
faster. Turning on an unmeasured performance choice by default, for every consumer of
a public package, with a silent interaction against debug views, is the wrong trade.
Two things should land first: commit the measured `relativeRmse` values so the
existing claim is checkable, and make the `debug` interaction warn rather than
degrade.

### 4.3 `windReprojection`

**What it does.** Contributes shape-offset motion to cloud velocity and reprojects
the history sample (`src/experimental/WindHistory.ts:37-58`,
`src/march/cloudsFragment.ts:406-413`), gating history validity in both resolves.

**Evidence.** The tightest assertion of the five: displacement must match
`[0.001, -0.002, 0] / shapeRepeat` to six decimals
(`experimental.spec.ts:214-217`). No value committed, no cost number. Crucially, the
same test asserts `shaftValid === false` — the option is *asserted to reject* light-shaft
history, because shaft motion is not cloud motion (`WindHistory.ts:54-55`,
`cloudsResolve.ts:297-303`).

**Risk.** Three failure modes, all silent, no warning on any of them:
- Any frame longer than 0.5 s drops all reprojection (`WindHistory.ts:39`). Untested
  at 0.5–1.0 s.
- Any non-zero `localWeatherVelocity` disables it on every frame:
  `derivedLocalWeatherOffset` is `offset + velocity × time`
  (`src/CloudsContext.ts:553-556`), so the offset advances each frame and
  `sameDomain` (`WindHistory.ts:60-71`) fails every time. The Storybook control has to
  *force weather velocity to zero* to make the feature work
  (`experimentalControls.ts:85-90`); an ordinary user animating weather gets a feature
  that silently does nothing, forever.
- A coordinate-domain change invalidates it silently (`:66`).

The context already has a `warnings` channel (`src/CloudsContext.ts:433`) and none of
these three uses it.

**Recommendation: OPT.** Do not promote as written. A default-on feature whose three
main failure modes are all silent is a bad public default even *with* quality
evidence, and it has none. Add a warning line on rejection — that is cheap, it is the
single highest-value change available for this option, and it would make promotion
possible later.

### 4.4 `distantCloudShadows`

**What it does.** Replaces the constant `0.5` optical-depth fallback with a
shadow-map estimate when the sun march takes zero steps
(`src/experimental/distantShadows.ts:52-60`), at `primaryMarch.ts:245-253`, directly
before the multi-scatter approximation.

**Evidence.** None quantitative. The one runtime test has to **force the
precondition**: `experimental.spec.ts:297-298` sets `maxIterationCountToSun = 0`,
because the shipped default is 2 (`src/qualityPresets.ts:147`) and at 2 the trigger
only fires in the deepest-mip region. So no measurement was ever taken at a production
setting.

**Risk.**
- Silently inert unless a layer casts shadows (`src/CloudLayer.ts:61`, `shadow =
  false`) and silently inert outside shadow-map coverage. No diagnostic for either.
- It fixes **one of two** sites carrying the same fudge: `primaryMarch.ts:222` is
  replaced, `secondarySunMarch.ts:77-79` is untouched. Both `TODO(port)` markers stay
  in the register, so shipping this as a default would leave the port claiming a
  fidelity it does not have.

**Recommendation: OPT.** It is the option most likely to become a default later,
because it removes a documented fudge rather than adding a look — but promotion
requires retiring or resolving the second `TODO(port)` and reporting inertness
through `warnings`. Until then the honest description is "an experiment that fixes
half of one fudge".

### 4.5 `directionalSkylight`

**What it does.** Two horizon samples of the atmosphere's indirect luminance drive a
normalized degree-two angular ambient term, clamped to `[0.25, 4]`
(`src/experimental/directionalSkylight.ts:22-43`), applied per sample at
`primaryMarch.ts:283-295`. With the option off, `skyLightModulation()` is the
constant `1` (`primaryMarch.ts:177`).

**Evidence.** None. `experimental.spec.ts:285-332` again asserts only `changed > 0`.
Its CPU twin does prove one real invariant — isotropic and black skies stay neutral
to 10 decimal places across three luminances (`directionalSkylight.test.ts:12-24`) —
but that is a correctness property, not a quality measurement.

**Risk.**
- Self-declared approximation: *"a constrained two-lobe approximation, not a full
  nine-coefficient spherical-harmonic reconstruction"* (`directionalSkylight.ts:22-24`,
  `WEBGPU.md:677-679`). `src/lighting/sunSkyLight.ts:7` still carries the
  `TODO(port)` for the SH this approximates, so this is a partial, uncredited
  implementation of a registered gap.
- It adds four `varying()`s (`:73-80`), so it changes the vertex stage. The digest
  recipe for exactly this case is written down in `docs/design/cloud-types.md:307-308`
  and unused — no vertex-stage digest test exists.
- The clamp means a physically correct answer outside `[0.25, 4]` is unreachable.
- The degenerate-axis branches (`:52-62`) are untested.

**Recommendation: OPT**, and it is the one I would cut first if the operator wants a
smaller public API. It has the weakest evidence of the five, it is the only one whose
graph change spans two shader stages, and it is an approximation of something the
port already registers as a known gap. Keeping it opt-in costs nothing; keeping it
*on* by default would make an approximation indistinguishable from the shipped path.

## 5. Options that have not landed

### 5.1 `distantShapeDetailFade` — recommend ON, conditionally

Lives on an unmerged branch at `a5648acc`; **not
on `main`**. Sixth key in `experimental/options.ts`, default false. It mixes the
shape-detail density by pixel footprint instead of by a jitter lottery:
`clamp(1 - mipLevel / 0.5, 0, 1)`. Off-state is the reference's
`clouds.glsl:186-190` condition verbatim.

This is **the only option in the register with both a quality measurement and a cost
measurement**, and I read the commit to confirm the numbers. Measured over the 0–4°
horizon band at 2874×1794 DPR 2, four poses, speckle as a 3×3 morphological top-hat:

| Pose | `spk>=8` on → off | `spk>=12` on → off |
|---|---|---|
| h1-level | 4.693 % → 3.848 % (−18 %) | 1.471 % → 1.114 % (−24 %) |
| h2-graze | 14.567 % → 5.340 % (−63 %) | 6.099 % → 1.481 % (−76 %) |
| h3-westsun | 4.670 % → 3.813 % (−18 %) | 1.537 % → 1.168 % (−24 %) |
| h4-lowsun | 6.448 % → 5.792 % (−10 %) | 2.457 % → 2.023 % (−18 %) |

Structure is retained — `structStd` moves −1.5 % to +1.0 % — and mean luma moves less
than one 8-bit step. Cost: median frame time 16.6–16.7 ms on and off at every pose,
i.e. under the resolution of the instrument.

Three conditions on the recommendation:

1. **The branch has gaps.** `EXPERIMENT_KEYS` in
   `examples/parity/scripts/benchmarks/plan.mjs` and `examples/parity/e2e/experimental.spec.ts`
   were **not** updated for the sixth key (the Storybook controls were). That is a
   follow-up whatever the default is decided to be, because those two files are the
   option set's inventory.
2. **Reproduce the numbers.** One machine, one day, September 2026. The measurement is
   strong enough to act on and old enough to want a second look.
3. **Accept the re-baseline.** Flipping this default moves all 63 committed metrics
   (§2.1). Sequence it before the final capture set, and treat the re-capture as part
   of the release.

Against: it makes the port **visibly better than the reference** at the horizon, and
the reference has the same speckle. That is a real difference a parity-minded reader
will notice, so it belongs in the README's known-differences with these numbers
attached, not in a changelog line.

The branch is also honest about what it does **not** fix:
`sunMarchIterationCount` is the same trick one level up, worth 28 % of h1-level's
`spk>=8` alone, but it shares a graph-time count with
`createDistantShadowAdjustment` (`distantShadows.ts`), so the two are not additive.

### 5.2 The variety epic options — keep opt-in, and change the shape of the surface

`docs/design/cloud-types.md` specifies five more keys (`proceduralWeather`,
`cirrusShell`, `convectiveProfile`, `cloudTypeMap`, `evolvingWeather`;
–.7). **None is written.** The design is explicit that everything is
opt-in and that the 63-case ladder does not move (`cloud-types.md:6-8`).

Recommendation: keep them opt-in, and expose the **cloud-type presets**
as the public surface rather than the booleans. Ten independent booleans with no
measurements is an API a library cannot honestly support: each one would ship as a
default-off feature with the same empty evidence the five above have today. A preset is
one named thing with a documented look, which is what a public user can actually choose
between. The booleans stay available for experimentation.

The design also flags a trap worth repeating here because it becomes a public-API
trap: adding a key to `ExperimentalCloudOptions` without adding it to
`experimentalDefaults` makes **every** consumer throw a `TypeError`
(`cloud-types.md:145-148`). That is good behaviour, and it must stay.

### 5.3 The sun-march count fade — measure the marginal effect, not the headline

proposes the matching fade for `sunMarchIterationCount`, and correctly
notes its own headline (28 % of h1-level's `spk>=8`) is measured against a baseline
that already includes the detail fade, and that it shares a graph-time count with
`createDistantShadowAdjustment`. Recommendation: keep opt-in if it lands, and do not
promote on the 28 % figure. If the detail fade is promoted by default, this option's
marginal value is what needs measuring, on top of the new default.

## 6. The three port-only defaults that already deviate

These are not options. They are the deviations a public user inherits on first use,
and they are where the standalone project actually differs from the original today.

### 6.1 `shadow.updateInterval` (default 2, original 1) — recommend ON

**Quality.** Two independent measurements, both pointing the same way and both small:
- `docs/MIGRATION.md:135`: parity ladder `shadow-temporal` SSIM 0.966 at interval 1 →
  0.954 at interval 2, against a 0.95 floor.
- `docs/adr/015-layers-4-shadow-temporal-shadow-resolve.md:66-70`: pinning B to 1
  moves `layers-4-shadow` from 0.970221 to 0.971488, **+0.0013, about 13 % of that
  case's remaining gap**, each arm captured twice.

**Cost.** The shadow-map optical-depth march is the largest single cloud cost at any
resolution (~3.7 ms for 3 × 512² × 50 iterations on an Apple GPU, and the reference
pays the same). Measured saving: **−1.8 ms per frame on average**, 10.65 → 8.6 ms at
2880×1800 and 6.3 → 4.5 ms at 1440×900 (`WEBGPU.md:436-440`). The temporal alpha
compounds to `1 − 0.99^N` so the map still converges per wall-clock frame
(`src/CloudsPassNode.ts:307-313`).

**Risk.** A moving camera can leave the newest sliver of the view unshadowed for up to
N−1 frames, and the map accumulates half as many jittered samples per update. Both are
in `README.md:73-79` already.

**Recommendation: ON, with a re-measure as a release gate, and a stated flip-back
condition.**

- The cost is the single largest lever in the library and the quality price is
  measured, small, and does not threaten the 0.95 floor. That is a good trade for a
  default.
- **But the number is stale.** It is one M4 Mac mini, September 2026, and
  `perf/FINAL-2026-09-24.md` lists six merged changes since that altered the frame —
  #194 took `baseline-medium` 1280 from 8.75 to 6.62 ms and #197 from 6.23 to 5.81 ms,
  so the shadow march's share of the frame has moved twice since. Re-measure before
  release.
- **Flip-back condition, stated now so it cannot be argued later: if the re-measure
  shows the saving has fallen below roughly 0.5 ms per frame, set the default to 1.**
  A port that is not measurably faster should not pay a fidelity cost, and this is the
  one default where that trade has actually been quantified.

### 6.2 `lightShaftsHalfResolution` (default on) — recommend ON, after two fixes

**Cost.** −0.6 ms at 2880×1800 (`WEBGPU.md:442-444`); the march runs once per 2×2 quad
with each lane taking every fourth sample, so a quarter of the shaft march's cost
(`docs/MIGRATION.md:136`, `CHANGELOG.md:18-22`).

**Quality.** **None.** There is no parity case that isolates it, no twin case with it
off, and no threshold anywhere. The ladder runs it **on by default** on all four
`shafts-*` cases (`parity/results/3/`). `src/CloudsContext.ts:332` claims it is
*"indistinguishable from the reference"* and **no number backs that claim.** The one
test (`CloudsPassNode.test.ts:2998-3051`) is a program-selection bookkeeping test, not
a pixel comparison.

**Risk — and this is the part that matters.** The flag needs the `subgroups` feature
and **is silently ignored without it** (`WEBGPU.md:293`,
`CloudsPassNode.ts:448-455`). No warning, and **no shipped receipt records whether
`subgroups` was present**. So every capture in this repo, and every receipt a public
user could produce, is ambiguous between "quarter-cost shaft march" and "full-cost
per-fragment march". This is the same failure shape as the derivative-in-non-uniform-
flow class: the feature reads as on and may be doing nothing, and the
evidence cannot tell the difference.

**Recommendation: ON, conditional on two things that must land before release.**
1. **Measure it.** One capture of the four `shafts-*` cases with the flag off versus
   on, relative RMSE reported and committed. If the difference is visible at DPR 1,
   the default flips off and consumers opt in — that is a one-line change and it
   should be made before the README repeats the "indistinguishable" claim.
2. **Record the effective path.** Add `subgroups` present/absent to the e2e receipt, so
   a green receipt distinguishes the two paths instead of being compatible with both.

Until (1) lands, soften the claim in `src/CloudsContext.ts:332` and in the README.
An unbacked "indistinguishable from the reference" is the single most likely thing in
this document to be quoted back at the project by a user.

### 6.3 The blue-noise jitter default — recommend ON, with one smoke case

`createJitterTexture()` now returns a synchronously generated blue-noise volume
(`src/textures/loadBakedCloudTextures.ts:145`, ADR-009), replacing a first-use
download. `createHashJitterTexture()` remains.

**Evidence gap, and it is deliberate.** The parity harness selects the **hash** volume
on *both* sides (`examples/parity/src/sideA.ts:297`, `sideB.ts:270`) so the jitter
source cannot confound the port comparison. That is correct method and **must not
change**. The consequence, stated plainly: **the shipping default is the one jitter
state the ladder never renders.**

**Recommendation: ON.** It removes a network fetch from a public package's first use,
which is worth more outside this repo than inside it, and its generation is covered by
ADR-009. Add one runtime case — not a parity case — asserting the blue-noise volume
renders finite, occupied pixels, so the default is exercised somewhere. Reference mode
selects the hash volume.

## 7. Reference mode

Reference mode is the piece that makes every other recommendation cheap. It is not a
quality tier; it is a switch that puts the port on the original's behaviour.

### 7.1 It used to exist, in four places, assembled by hand

**Implemented** as `src/referenceMode.ts`, with `REFERENCE_MODE` as
the single written copy of the pin values, consumed by the parity harness and by the
Storybook's Baseline. The table below is the "before" picture, kept because it is the
evidence for why the mode was worth building.

| Site | What it restored |
|---|---|
| `examples/parity/src/parityState.ts` | `shadow.updateInterval: 1` — hardcoded, with no comment saying why |
| `examples/parity/src/sideA.ts:297`, `sideB.ts:270` | `createHashJitterTexture()` on both sides |
| `examples/parity/src/parityState.ts:28-38` (`NEUTRALISED_KNOBS`) | later-phase graph features off: `haze`, `maxIterationCountToGround`, `cloudLayers[i].shadow`, `lightShafts`, `temporalUpscale`, `accuratePhaseFunction`, `debug` |
| `examples/storybook/src/clouds/controls/experimentalControls.ts` | a Baseline/Experiments radio that bypassed only the experiments |

**The Storybook's "Baseline" was not the reference.** It bypassed the experiment
switches and left `updateInterval = 2` and `lightShaftsHalfResolution = true` in place,
so a reader comparing "Baseline" against the original was comparing against something
that already deviated. `applyComparisonMode` now pins or unpins both.

Two pins stay deliberately **outside** reference mode. The jitter volume is a harness
measurement choice (one volume on both sides, so the jitter source cannot confound the
comparison) rather than a default the library owns, and `NEUTRALISED_KNOBS` is §7.4's
separate list.

### 7.2 The design

**Write-through, not an override layer**, and a module function rather than a
`CloudsContext` property:

```ts
applyReferenceMode(ctx: CloudsContext): boolean // pins; returns whether it moved
applyPortDefaults(ctx: CloudsContext): boolean // the way back out
referenceModePins(ctx: CloudsContext): ReferenceModePins // what it holds now
```

The pins are plain assignments, so reference mode is *exactly the set of writes a user
could have made by hand*: reviewable, testable, and no consumer has to learn which
layer wins. Each write goes through the property's own setter, so `graphVersion` and
`resetHistory` happen once per changed property rather than being re-implemented here.

The function rather than a property is a deviation from the sketch above, for three
reasons. A getter-only property is a one-way door with no setter, which is worse than
a named function. A function works on the stub contexts the harness tests with, which
a `CloudsContext` property cannot reach. And it leaves `src/CloudsContext.ts` alone
apart from naming the half-resolution default, which four other agents are editing.
Leaving reference mode is `applyPortDefaults`, which reads the library's own defaults
instead of restoring a remembered copy, so a default change moves it.

**The invariant test that makes it impossible to forget.** Reference mode is a
behavioural dependency list, and the failure mode of such a list is a new port-only
default landing and silently not being in it. So the test compares in **both**
directions: `REFERENCE_MODE_PORT_ONLY_PATHS` declares the paths, a recording proxy
captures what `applyReferenceMode` actually writes, and the two sets must be equal.
Deleting a pin fails it; declaring a path nothing writes fails it. This is the
technique the migration table already uses — generated from the parity adapter and
compared verbatim by a test, so document and code cannot drift
(`CHANGELOG.md:41-44`). Reuse it.

### 7.3 What reference mode must not claim to restore

Stating this is more useful than pretending. Reference mode restores the original's
**knobs**, on the port's **compiled path**. It cannot restore:

- **The original's compiled local-weather path.** ADR-014 records that the original's
  compiled Worley loop differs from its own source and the port follows the source. No
  knob returns the compiled behaviour; a capture can only pin the baked texture.
- **NVIDIA's STBN jitter.** The reference loads it; the port's parity harness uses the
  hash volume on both sides, and that choice stays in `sideA`/`sideB` rather than in
  reference mode, because it is a measurement decision shared by two sides rather than
  a default the library owns. STBN is a caller action with a licence boundary
  (`WEBGPU.md:519-530`).
- **The atmosphere.** `raymarchScattering` and the `raymarch-256` profile belong to
  `AtmosphereContext`, not `CloudsContext`
  (historically measured at 34.46–34.53 → 8.51–9.17 ms).
  Reference mode cannot reach it; say so rather than imply coverage.
- **Debug views**, which are never pixel-parity (ADR-011 Amendment 6).
- **A claim about the fudges.** Keeping `distantCloudShadows` off is what leaves the
  `0.5` fudges in place, and that is the faithful state. Reference mode's correctness
  here comes from the experiments all being off.

### 7.4 The list that must NOT be merged into it

`NEUTRALISED_KNOBS` and reference mode look similar and are not:

> **`NEUTRALISED_KNOBS` turns off features the original *has*. Reference mode turns
> off deviations the port *invented*.**

`haze = false`, `lightShafts = false`, `cloudLayers[i].shadow = false` are
phase-scoped harness decisions (ADR-011 frozen-feature neutralisation). Merging them
would make the Storybook's Baseline strip features the original genuinely has, and
would make a future default change invisible to the ladder in the wrong direction. The
harness should call reference mode for what it can reach and keep `NEUTRALISED_KNOBS`
for what it cannot.

### 7.5 What building it bought, and what it cost

1. **Public defaults become free.** With the ladder always in reference mode, flipping
   any default — including §5.1's promotion — stops re-baselining 63 committed metrics.
   That is the largest single saving in this document and the reason reference mode
   should land *before* the default decisions are executed, not after.
2. **The benchmark matrix becomes runnable.** The `standard` matrix in
   `docs/BENCHMARKS.md` (`all off, each on alone, all on, each removed from all-on`) is
   exactly an experiment-vs-reference sweep. It has never been run; reference mode is
   its missing half.
3. **The evidence gap in §2.1 has a channel.** Every recommendation above that says
   "no measurement" is waiting on the same thing: a cheap, repeatable
   experiment-vs-reference comparison. §5's proof recipe
   (`cloud-types.md:§7`) is the pattern.

**Cost, as built.** One module, one declared path list, one exit function, four test
files touched, and three one-liners of attribution bookkeeping (two attribution
registries name glue files explicitly, and adding an export means the expected-export
list moves with it). No GPU: the re-capture list rests on compiled WGSL rather than a
capture, because `lightShaftsHalfResolution` with `lightShafts` off was proved to emit
byte-identical shader text and with it on was proved to differ.

**What it did not buy.** The 63 committed metrics under `parity/results/**` are still
recorded against the *old* behaviour for the three cases reference mode moves, and
`scripts/verify-results.mjs` re-evaluates committed numbers without re-rendering, so
it will stay green while those three are stale. Wiring
`referenceModeRecaptureList` into that gate is the obvious follow-up and is not part
of this change.

### 7.6 Sequencing

Reference mode is built and adopted in the harness, so the default decisions can now
be executed without re-baselining: §5.1's promotion and §6's flips change what the
library ships and leave the ladder alone. The §6 re-measures are also straightforward
now, because a reference-mode capture is the baseline arm for every one of them.

## 8. What would change these recommendations

Stated as falsifiable triggers, so the next agent does not have to re-derive the
reasoning:

| Finding | Recommendation it changes |
|---|---|
| A banding measurement for `cloudFrontRefinement` shows the step `primaryMarch.ts:488` describes | Promote to ON; resolve the `debug-sample-count` register entry first |
| The `shafts-*` off/on capture shows a visible difference at DPR 1 | `lightShaftsHalfResolution` flips to OFF (off by default, opt-in) |
| The `shadow.updateInterval` re-measure shows under ~0.5 ms saved | `updateInterval` default flips to 1 |
| A wind-reprojection rejection warns, and a quality measurement lands | `windReprojection` becomes promotable; without the warning, it never should be |
| The benchmark matrix runs and `computeResolve` shows a real win with no quality cost | Promote to ON, after the `debug` interaction warns |
| `distantShapeDetailFade`'s numbers do not reproduce | §5.1 reverts to OPT and the branch's premise needs re-examining |
| A consumer-facing need for fewer knobs appears | `directionalSkylight` is the cut (§4.5) |

## 9. Measurements this document could not make

CPU-only machine, no GPU, per the operating rules. Everything above is read from
committed evidence; nothing here is a new measurement. For the Mac mini fleet:

```bash
# The existing experimental suite (records pass/fail only; add value logging first)
PARITY_GPU=hardware pnpm e2e --grep 'experimental options|compute agrees|wind reprojection follows|GPU timing includes'

# §6.2: the missing lightShaftsHalfResolution twin, four cases, flag off vs on
PARITY_GPU=hardware pnpm --filter parity capture --case shafts-inside-deck
PARITY_GPU=hardware pnpm --filter parity capture --case shafts-low-sun
PARITY_GPU=hardware pnpm --filter parity capture --case shafts-orbit-off
PARITY_GPU=hardware pnpm --filter parity capture --case shafts-sky-horizon

# §6.1 and §5.1: the updateInterval re-measure and the horizon speckle reproduction
# (docs/BENCHMARKS.md, perf/FINAL-2026-09-24.md for the harness)

# §2.1: the benchmark matrix that has never been run
# (docs/BENCHMARKS.md `standard`; examples/parity/scripts/benchmarks/plan.mjs)
```

The first item on that list is the one worth fixing before running it: the suite
`console.log`s its RMSE and commits nothing, so running it again as-is produces the
same empty evidence.

## 10. Summary

- **Promote one option to default on:** `distantShapeDetailFade`, on numbers, and
  conditionally on the branch gaps being closed and the numbers reproducing.
- **Keep all five experimental options opt-in.** None has quality or cost evidence,
  and three of them fail silently.
- **Keep the three port-only defaults**, with two measurement gates
  (`lightShaftsHalfResolution`'s missing twin, `shadow.updateInterval`'s stale number)
  and one honesty fix (the "indistinguishable" claim).
- **Build reference mode first.** It is what makes the rest of this document cheap to
  execute, and it is the only way public defaults stop costing a 63-case re-baseline.