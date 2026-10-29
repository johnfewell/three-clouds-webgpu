# ADR-013 — Atmosphere as source of truth

## Context

In the WebGPU atmosphere package (`@takram/three-atmosphere/webgpu`), `AtmosphereContext` already owns per-frame uniforms for coordinate transforms (`matrixWorldToECEF`, `matrixViewToECEF`, `matrixECEFToWorld`, `matrixECEFToView`), sun direction (`sunDirectionECEF`), camera position (`cameraPositionUnit`), altitude correction (`altitudeCorrectionECEF`/`altitudeCorrectionUnit`), the WGS84 ellipsoid, and the `correctAltitude` flag. The `parametersNode` carries `worldToUnit`, `bottomRadius`, `topRadius`, and other physical parameters.

The clouds must render in the same frame as the aerial perspective, or shadows and shafts will not register spatially. Duplicating these uniforms would introduce drift.

## Decision

- `CloudsContext` reads all coordinate, sun, and altitude data from `getAtmosphere()` at setup and never duplicates them.
- For name parity with the WebGL `CloudsEffect`, `CloudsContext` exposes `sunDirection`, `worldToECEFMatrix`, `correctAltitude`, and `ellipsoid` as **pass-through accessors** (getter/setter both forward to the atmosphere context). The parity adapter's key loop works unchanged on both sides.
- `cameraHeight` is computed by `CloudsContext` per frame from `Geodetic.setFromECEF(cameraPositionECEF).height`, using the same camera the atmosphere uses (`atmosphereContext.camera ?? frame.camera`).
- **Units**: the atmosphere accessors work in "unit" space (`worldToUnit` scale); the cloud march works in ECEF metres (matching the original), converting at accessor call sites exactly as the original multiplies by `METER_TO_LENGTH_UNIT`.

## Amendment 1 (2026-08-31) — the two takram packages do not share precompute defaults

`@takram/three-atmosphere` 0.19.1 ships two `AtmosphereParameters` classes with
**different `groundAlbedo` defaults**: the WebGL class uses `setScalar(0.1)`, the
WebGPU class `setScalar(0.3)` (every other field agrees once the km-vs-metre unit
scale is accounted for). Ground-bounced light enters the irradiance and
multiple-scattering LUT precompute, so with defaults the WebGPU chain renders
+11–17 % brighter, blue-weighted, in every region — sky, ground and clouds alike
(transmittance LUTs identical, irradiance LUT
B/A ≈ 1.13/1.14/1.08).

Decision: this is an upstream default, not a port defect, and the library does not
override it (the WebGPU package's value is what its users get). The parity harness
pins side B to the reference value (`atmosphereContext.parameters.groundAlbedo
.setScalar(0.1)` in `examples/parity/src/sideB.ts`) so the ladder compares the
clouds under one atmosphere. Any future difference in the two precomputes is to be
checked the same way — LUT texel comparison before shading is blamed.

## Amendment 2 (2026-08-31) — the two chains integrate aerial inscatter by different methods

The packages do not merely disagree on a constant; they compute the aerial
perspective a **different way**, and only one of them is noise-free.

- **Side A (WebGL)** reads Bruneton's precomputed 4-D scattering LUT —
  `GetSkyRadianceToPoint`, `src/shaders/aerialPerspectiveEffect.frag:135`. One
  texture fetch: exact, smooth, and bit-deterministic across renders.
- **Side B (WebGPU)** ray-marches the same integral at run time and jitters each
  segment's sample point with spatiotemporal blue noise —
  `src/webgpu/multiscattering.ts:495`, `rayLength = t0 + stepSize * stbn`, over
  `mix(scatteringSampleCount.x, .y, distance/100)` = **4–14 samples**. `stbn`
  indexes the blue-noise volume by **`frameId % 64`**
  (`@takram/three-geospatial/build/webgpu.js:1270`,
  `stbnTexture.sample(vec3(screenCoordinate.xy, frameId.mod(64)) / vec3(128,128,64)).r`).

Two consequences fall out, both measured on `baseline-medium`:

1. **Side B is not deterministic across renders.** Two renders differ by
   σ = 3.34e-3 on clear pixels — 3.3 % of plate luminance — because `frameId`
   advances and re-randomises the jitter. Side A's render-to-render σ is
   **exactly 0**. The noise is 1-px salt-and-pepper and blue-weighted (Rayleigh
   dominates the inscatter), and it is suppressed under clouds by `(1 − α)`.
2. **Side B's plate carries 34 % more fine-scale detail than A's**, which is
   what capped ~20 phase-1 cases sharing the baseline pose at SSIM ≈ 0.79 —
   the untextured plate is 83 % of the frame, so SSIM's local-variance term is
   dominated by this noise rather than by the clouds (clouds-only SSIM was
   already 0.960).

Decision: as with Amendment 1, this is upstream behaviour, not a port defect —
the library does not override it. Raising the sample count is not a fudge: it
converges B's Monte-Carlo estimate onto the very integral A's LUT already
stores, so a higher count is *more* correct, not merely more similar. The
harness pins side B to `atmosphereContext.scatteringSampleCount.value.set(64, 64)`
in `examples/parity/src/sideB.ts`. Measured live SSIM, `baseline-medium`:

| `scatteringSampleCount` | render→render σ | σ as % plate luma | plate hp excess vs A | plate hp corr | SSIM |
|---|---|---|---|---|---|
| default (4, 14) | 3.34e-3 | 3.27 % | +34.7 % | 0.678 | 0.7894 |
| 14 | 2.94e-3 | 2.88 % | +22.1 % | 0.748 | 0.8413 |
| 32 | 1.19e-3 | 1.16 % | −1.1 % | 0.923 | 0.9548 |
| **64** | **5.44e-4** | **0.53 %** | **−4.6 %** | **0.957** | **0.9782** |
| 128 | 3.03e-4 | 0.30 % | −5.6 % | 0.967 | 0.9852 |

64 is the knee: it clears the 0.95 floor with margin at roughly half the cost of
128. Note the residual σ is asymptotic, not zero — it falls as ≈1/N because the
jitter remains `frameId`-driven — so side B captures stay reproducible only to
≈0.5 % on clear pixels. Pinning `frameId` itself would be needed for exact
determinism and is not available through a public three.js API; the remaining
variance is far below the acceptance thresholds and is recorded here rather than
chased.

The whole pose-sharing group moves together, and the cases that already passed do
not regress (live SSIM, default → N=64):

| case | default | N=64 |
|---|---|---|
| `baseline-medium` | 0.7895 | 0.9782 |
| `octaves-4` | 0.7916 | 0.9786 |
| `layers-2` | 0.7899 | 0.9783 |
| `wind` | 0.7895 | 0.9783 |
| `sun-noon` | 0.7909 | 0.9785 |
| `preset-high` | 0.7913 | 0.9784 |
| `turbulence-off` | 0.7899 | 0.9783 |
| `surface-up` (control, pure sky) | 0.9849 | 0.9849 |
| `coverage-070` (control) | 0.9749 | 0.9750 |
| `below-deck-1km` (control) | 0.9880 | 0.9880 |

`surface-up` is unmoved because a pure-sky frame has no surface to integrate
*to*: it renders through `skyBackground()`, not the aerial-perspective march.

## Amendment 4 (2026-08-31) — the sample count is pinned at 256, and it costs 7–11x, not 2x

Amendment 2 above records the state of belief when it was written. Three of its
statements have since been overtaken, and this amendment supersedes them rather
than editing the record.

**1. The pin is 256, not 64.** Amendment 2 says the harness pins
`scatteringSampleCount.value.set(64, 64)`. `examples/parity/src/sideB.ts:159`
sets `(256, 256)`, raised when `coverage-020` was traced to
residual Monte-Carlo speckle in the far-field plate rather than to a convention
mismatch: at 2 % coverage most of the frame is empty plate, which is exactly
where B carries a noise floor A does not, and the case went 0.8375 → 0.9762
across N = 64 → 256 while every already-passing case held.

**2. "64 is the knee ... at roughly half the cost of 128" is wrong.** That claim
was never measured; the first attempt to measure it returned N=128 as *faster*
than N=64, which should have been treated as a broken instrument rather than a
puzzle. It was: side B's GPU timer divided by 1e6 twice, so every reading was
noise at 1e-5 scale (fixed: three's `resolveTimestampsAsync`
already returns milliseconds). Re-measured on an exclusive bench with the fixed
timer, pre-touching every N so no one-off cost lands in a timed window, and
sweeping descending then ascending as a control — side B median frame ms over 48
frames, worst order-disagreement 2.9 %:

| N | `coverage-020` | vs N=64 | `baseline-medium` | vs N=64 |
|---|---|---|---|---|
| 64 | 3.00 ms | 1.00x | 3.30 ms | 1.00x |
| 128 | 6.21 ms | 2.07x | 18.87 ms | 5.73x |
| **256** | **21.30 ms** | **7.09x** | **35.83 ms** | **10.87x** |
| 512 | 40.96 ms | 13.64x | 67.63 ms | 20.52x |

What these numbers are, precisely. The parity harness renders side B through
`build/index.js`, not `src/` — so every row was measured against whichever
library build was loaded at the time. All four N values were measured in ONE page
session against that ONE build, varying only the `scatteringSampleCount` uniform,
so the **ratios are within-build and stand**. The absolute per-frame
milliseconds are a snapshot of that build and will move as the library does; do
not quote them as today's cost without re-measuring on a fresh `pnpm build`. The
decision turns on the ratio, which is why the conclusion below is unaffected.

So the pin costs **7–11x**, against the ~4x Amendment 2's reasoning implied. The
scaling is also not the clean doubling that reasoning assumed: `baseline-medium`
jumps 5.73x between 64 and 128 and only 1.9x between 128 and 256, so there is a
cliff below 128 on cloud-heavy poses that a per-doubling model does not capture.
The cost is borne by capture wall-clock only — the library default is untouched,
and nothing user-facing renders at the pinned count.

Recorded because the decision was taken on an unmeasured cost estimate that was
off by 2–3x. It does not reverse the decision: converging B's estimate onto the
integral A's LUT already stores is more correct rather than merely more similar,
and the alternative was an `accepted[]` exemption. But a future proposal to raise
it again should start from this table, and 512 should be assumed unaffordable.

**3. Exact `frameId` determinism was achieved, contradicting Amendment 2's
closing paragraph.** That paragraph states pinning `frameId` "is not available
through a public three.js API" and that side B captures "stay reproducible only
to ≈0.5 % on clear pixels". Fixing it rebases
`renderer._nodes.nodeFrame.frameId` by multiples of the STBN period before each
capture, holding `frameId % 64` fixed while the counter keeps advancing — which
three requires, since it gates FRAME-type node updates on a *changed* frameId and
caches previous-frame camera matrices against it. Measured run-to-run σ fell from
5.5e-4 to ~1e-7. The reachability is through an underscore-prefixed internal, so
"not public" was fair; "not available" was not.

## Amendment 3 (2026-08-31) — the reference's sky is mirrored against its own camera

`surface-up`'s clear-sky luminance ran opposite ways on the two sides: per-row
means gave a smooth B/A ratio of 1.29 at the top rows falling to 0.78 at the
bottom. The first reading was that
side B's `skyBackground()` reconstructs a flipped view ray.

It is the other way round, and two independent arbiters agree.

**Physics.** On `surface-up` the camera looks at the zenith, so zenith angle is
*symmetric* about the middle row band (24.1° → 1.1° → 22.2°) while angle from
the sun is *monotonic* (52.1° → 95.6°). Airmass effects must therefore be
V-shaped and sun-proximity effects monotonic, which separates them in one frame.
Side B falls monotonically with sun angle and lifts again at the last two bands
where the zenith angle grows — the expected superposition. Side A is flat to
band 7 and then *rises 36 % away from the sun*. Bands 0 and 11 sit at nearly the
same zenith angle (airmass 1.095 vs 1.079) yet side A differs between them by
33 %, which no symmetric term can produce. Rayleigh `(1 + cos²θ)` predicts band 0
brighter by ×1.37 before multiple scattering flattens it: B measures 1.248, A
measures 0.752 — the reciprocal.

**The sun disc.** Rotating the sun to 18° from zenith puts the disc itself in
frame. Camera-projected sun (558, 123); side B's disc (558, 122); side A's disc
(558, 597) = (558, 720 − 123) — the exact vertical mirror, same peak, same `x`.
Identical `x` rules out any row-mapping ambiguity in the gradient decomposition.

**Mechanism.** `SkyMaterial` is a clip-space fullscreen shader
(`gl_Position = vec4(position.xy, 1, 1)`, ray from `getCameraRay(position.xy)`)
rendered *inside* the composer's scene framebuffer. A clip-space quad inherits
the WebGL FBO y-flip that ordinary camera-projected geometry compensates for, so
the reference's sky is mirrored relative to its own clouds and ground. This is an
upstream integration quirk of using `SkyMaterial` inside an `EffectComposer`
chain, not a defect in this port and not a harness wiring error — `SkyMaterial`
takes its `inverseProjectionMatrix`/`inverseViewMatrix` from its own
`onBeforeRender`, so the harness cannot feed it a wrong camera.

Decision: **side B is physically correct; do not wrap `skyBackground()`'s ray or
uv.** Doing so would make B match A and make both wrong. No library change. The
capture path already y-flips side A at save (`examples/parity/scripts/capture.mjs`,
so committed `A.png`/`B.png` pairs are
row-comparable and in the physical orientation; `diff.png` and every metric
consume the row-aligned linear readbacks and were never affected.

There is **no residual physical tilt**. Comparing side B against side A's
row-flipped sky collapses the monotonic ratio into a non-monotonic ±10 % wobble
(1.29 → 0.78 becomes 0.83, 0.79, 0.93, 0.99, 1.02, 1.05, 0.98, 1.03, 1.08, 1.08,
0.97, 0.93), and the per-pixel clear-sky correlation rises from 0.145 to 0.399.
The whole gradient was the mirror. No accepted-register entry is needed:
`surface-up` already passes at 0.985.

## Amendment 5 (2026-09-02) — side A's readback was bottom-first, side B's cloud layer was rendered mirrored, and a third flip had been tuned to match; Amendment 3 is superseded

**Supersedes Amendment 3's display claim.** Measured with the sun-disc arbiter
Amendment 3 introduced, at two poses, with no readback convention assumed
(probe receipt sha256 `675ef9c2be83bcd7…` for the sky pose at P6/P7, and
`0399bf5047859726…` for surface-up at P8, where the layer read
`68706143d0ddd461…` at P9):

| buffer                                                    | sky pose (projected 640, 210) | surface-up (projected 634, 191) |
| --------------------------------------------------------- | ----------------------------- | ------------------------------- |
| side B `readLinear`                                       | (638, 207)                    | (632, 188)                      |
| side A displayed canvas (`toDataURL`)                     | (638, 206)                    | (632, 187)                      |
| side A `readLinear` == raw `gl.readPixels` of `linearRT` | (639, 512) = mirror           | (632, 527) = mirror             |

1. **Side A's displayed frame is physical** at both poses. Amendment 3's
   "the reference's displayed frame is mirrored against its own camera" is
   withdrawn; its measurement is most plausibly a bottom-first read of the
   default framebuffer (`readPixels`), which agrees row for row with the
   linear readback exactly as diag87 reported. Amendment 3's other finding —
   side B's sky is physical — stands, and is confirmed above.
2. **Side A's linear readback was bottom-first.** `readLinearRT` returned raw
   `gl.readPixels` rows; side B's WebGPU readback is top-first. Every consumer
   compared them row for row. `readLinearRT` now flips rows top-first
   (`examples/parity/src/readbackRows.ts`), and `capture.mjs` no longer flips
   A's canvas, because the canvas was never mirrored.
3. **Side B rendered its cloud layer vertically mirrored relative to its own
   sky and scene.** At the sky-horizon pose (12 km, every active layer at or
   below 8 km, horizon 3.5° below centre) B's cloud layer target held
   225,138 alpha pixels in the top half and none in the bottom (P9), i.e.
   clouds above a physically placed sun. Cause: the march reconstructed its
   ray as `clip = uv * 2 - 1` (`clouds.frag:833–835`, a WebGL fullscreen pass
   where v runs bottom-up); in the port's own QuadMesh passes `uv()` runs
   top-down. `src/march/cloudsFragment.ts` now uses clip y = 1 − 2v, and the
   temporal reprojection converts NDC to uv in the same sense (its GL form
   fetched history from the mirror row and, once the ray was upright, acted
   as a spatial blur: B's high-pass energy 0.0067 against A's 0.0135; 0.0131
   after). After the ray fix the layer target holds alpha in rows 389–719
   and none in the top half.
4. **Three siblings had been tuned to the mirror, and one was a
   coincidence.** With A upright and the ray upright, inside-deck-low-sun
   fell from 0.984/0.992 (full / high-pass correlation, both mirrored) to
   0.600/0.401. Each step below is one variable, with its prediction recorded
   before the run:
   - `sceneDepth.ts` flipped the depth sample's v to match the mirrored ray;
     un-flipped: 0.817/0.507 (run 9). A mirrored depth would truncate the
     deck's upper rows at the ground's near depth; every 180-row band reads
     +0.991 once the siblings below land.
   - The residual was pixel-scale noise, not structure: banding the A/B
     high-pass correlation by a pre-blur of radius 0/1/2/3/5 gave
     +0.23/+0.60/+0.75/+0.83/+0.89, and the sky pose's cloud rows 180–360
     read +0.982 at full resolution. The reference seeds its blue noise from
     `gl_FragCoord` (row bottom-up); the port used three's
     `screenCoordinate`, which `ScreenNode` makes y-down in both backends.
     At main both mirrored frames carried noise row r on image row r, so
     the jitter coincided pixel for pixel — the 0.992 was that coincidence.
     `jitter.ts` now indexes the march's STBN by (x, screenSize.y −
     screenCoordinate.y), which is `gl_FragCoord` exactly; the light-space
     shadow march keeps `screenCoordinate` because its uv→clip map is
     2v − 1 in both codebases and content row and noise row already
     coincide there. Deck 0.997/0.991, sky pose 0.998/0.976 (run 14,
     receipt `5733e324af7aac0a…`).
   - The harness's side-B ground-shadow receiver (`examples/parity/src/
     sideB.ts`) reconstructed the ground position from `(u, 1 − v)`; its own
     comment records that the flip was chosen because it matched A, the
     bottom-first A. With both mirrors gone it put every receiver on
     the mirror row: shadow-plane 0.4075, A vs B +0.80 only with B flipped,
     while B's cloud layer target correlated with A at +0.19 upright and
     0.00 flipped and both cameras' world matrices were identical (orbit
     anchor `1226432bd9527afe…`). Un-flipped: shadow-plane 0.9768 (main
     0.9457, fail), shadow-cascades-2x512 0.9593 (main 0.9334, fail) —
     physical against physical scores above anything the mirrors produced
     (run 18, `453376294c7e0b6f…`; `093811c2b3a656f7…`). The port's own
     aerial node passes `uv()` unflipped to the same helper and is physical:
     flipping it (run 17) left shadow-plane at 0.4064 and dropped the sky
     pose's surface rows from +0.961/+0.984 to +0.778/+0.960, so it was
     reverted.
5. **Why 47 ladder cases passed:** on frames with no vertical scene structure
   A's fully mirrored readback coincided with B's mirrored clouds, B's
   mirrored ground shadow and the coincident noise rows — errors cancelling
   in pairs. The top-first calibration of the readback, the receiver flip and
   the powered alignment run were all measured against that coincidence. Every
   committed A side was captured through the mirrored read: the ladder is re-captured after this amendment lands and scores move
   to their honest values; no case receives a bug-reason register entry.
6. **Guard.** `examples/parity/e2e/skyOrientation.spec.ts` asserts, from the
   linear buffers the ladder consumes and on BOTH sides, that the projected
   sun disc lands within 6 px of its row and column and that cloud high-pass
   energy (disc masked at 48 px, per-pixel cap 0.5) lies below horizon row
   407 at the sky pose. Proven on hardware (apple/metal-3): main RED (A disc
   at row 512; B energy 2202 above / 41 below), F1 alone RED (B 2202/41),
   F2 alone RED (A disc at 512), branch GREEN (A (639, 207), B (638, 207);
   energy A 107/1222, B 103/1113). Logs `d2730cd8567db2c3…`,
   `ef8058b5935cfcf4…`, `2048a6289ee2cf1c…`, `680fe2c7c31a22e7…`.
7. **Same class, not changed here.** The interleaved-gradient-noise seeds in
   both shadow samplers (`gl_FragCoord` in the reference, `screenCoordinate`
   in the port) were measured with/without on the two shadow cases: Δ SSIM
   −1.0e-6 and −1.5e-5, below the 1.1e-5 single-run floor (Amendment 7 of
   ADR-011), so they stay as they are and are named as follow-up
   (`00b547392d5ae6e2…`, `6db409e0f175a669…`). `shadowResolve.ts:71` and the
   light-space shadow march (`CloudsPassNode.ts`) write and read through one
   NDC↔uv map and are self-consistent. The "ground shadow weak" and in-scatter
   band readings were taken with B's ground shadow on the mirror row; both are
   re-measured after this lands before any mechanism is spent on them
   (candidate, not finding).

## Amendment 6 (2026-09-24, accepted) — side B reads the scattering LUT; the 256-sample raymarch becomes an opt-in, with one named per-case exception

**Status.** Drafted with the harness change it describes. The
qualification ladder (below) came back 58 pass / 4 expected-difference / 1 fail
with side B in lookup mode on every case. The one fail is handled by the single
per-case exception in Decision 3 (maintainer ruling 2026-09-24,
fallback (b)), which restores that case's pinned result. The
amendment takes effect with the combined re-capture, which must show 59 / 4 / 0
at the unchanged `thresholds.json`.

**Why.** Amendment 4's pin is the side-B frame's largest cost by far. Paired GPU
knockouts on `baseline-medium` at 1280×720 on the Mac mini (apple metal-3,
checkpoint 1, 2026-09-24, first split, N = 1), whole frame:

| Side B atmosphere | frame (ms) | vs side A (5.60) |
|---|---:|---:|
| 256-sample raymarch (the Amendment 4 pin) | 38.77 | 6.9× |
| package default raymarch (4–14 samples) | 8.70 | 1.55× |
| LUT lookup (`raymarchScattering = false`) | 6.34 | 1.13× |

Primary-march sample counts were identical in all arms. The N = 5 matrix
(benchmark results, 2026-09-24 21:34Z) has, at 1280×720, A | pinned | default |
lookup (ms): baseline-medium 5.62 | 38.62 | 8.75 | 6.62; shadow-plane 6.89 |
39.16 | 9.48 | 7.32; layers-4 6.95 | 41.65 | 10.29 | 7.99. Across sessions the
Mini's GPU performance state moves light workloads by ~25–30 %, so
ratios near 1.25× are not yet robust; the ranking is. The pin existed to
converge side B's jittered Monte-Carlo inscatter onto the integral side A's LUT
already stores (Amendments 2 and 4). Reading that LUT gets there directly: it is
side A's method, and it is deterministic, so it carries no per-frame speckle.

**Decision (on qualification).**
1. The parity harness sets `raymarchScattering = false` on side B (the
   `reference` atmosphere profile, `examples/parity/src/atmosphereProfile.ts`).
2. The 256-sample raymarch stays available as the opt-in profile `raymarch-256`.
   As a URL/diagnostic profile (`e2e=1`), a capture with it writes only outside
   `parity/results` (`--atmosphere-profile raymarch-256 --out …`).
3. **One standing per-case exception: `below-deck-1km` (case 4) keeps the
   256-sample raymarch on side B.** It is declared in its case definition
   (`CaseDefinition.atmosphereException`, with the reason) and nowhere else;
   `cases.test.ts` pins the register to this one case. Measured reason: it is
   the only case the lookup fails, histDist 0.0998 raymarched vs 0.1001 in
   lookup against its 0.1000 bar (SSIM 0.993468 → 0.993456, deP95 unchanged).
   The camera sits at +1000 m, inside the WebGPU lookup's near-ground endpoint
   lift described below: upstream behaviour in `@takram/three-atmosphere`,
   with an upstream report drafted against the atmosphere package.
   Thresholds are
   untouched. Adding a case to this register needs a further amendment.
4. The library does not own the atmosphere mode; the consumer's
   `AtmosphereContext` does, and `@takram/three-atmosphere` defaults to the
   raymarch. The examples (r3f, basic, storybook) set the lookup, and WEBGPU.md
   and the README recommend it. Changing the package default is upstream work.

**What still differs from side A's method.** Both read Bruneton's
`GetSkyRadianceToPoint` over precomputed scattering and single-Mie LUTs. But
side B's LUTs come from the WebGPU package's own precompute (with
`groundAlbedo` pinned per Amendment 1). And its runtime lifts both segment
endpoints to at least bottomRadius + 1 % of the atmosphere's thickness (about
600 m), then rescales radiance and transmittance by the length ratio
(three-atmosphere `runtime.ts`, the `!raymarchScattering` branches). Whether
side A has an equivalent near-ground guard was not verified. Any correction
there belongs upstream in the atmosphere package, not in a clouds workaround.

**Measured: the qualification ladder** (2026-09-24 21:45Z; side B in
`lookup-both` on all 63 cases, served build digest recorded with the captures,
63/63 capture logs confirm `raymarchScattering=false`):
- 58 pass / 4 expected-difference (the same cases and ADRs as pinned) / 1 fail
  (`below-deck-1km`, above).
- 54 cases improve beyond the 1.1e-5 cross-session floor (median ΔSSIM
  +0.001016), 6 are within it, 3 are worse beyond it: orbit-140km −0.000670
  (with histDist 0.0327 → 0.0085 and deP95 −0.64), debug-front-depth
  −0.000040, below-deck-1km −0.000012. histDist falls on nearly every case.
- The near-ground set moved as predicted: surface-up histDist 0.0497 → 0.0501
  and haze-on 0.0498 → 0.0503, both under their bars; below-deck-1km crossed
  its bar.
- The pin's own reason improved: coverage-020 0.993779 → 0.995309.
- Floors: layers-4-shadow 0.971489 → 0.973788 (ADR-015 floor 0.971478);
  procedural-textures 0.696664 → 0.696658 (ADR-014 floor 0.696443).

**Consequences for the evidence.** Every committed capture was taken with the
pin, so qualification is followed by a full re-capture and a fresh e2e receipt
under the lookup, as its own evidence commit. Amendment 4's measurements stand
as the record of the pin; its decision is superseded by this one.

## Amendment 7 (2026-10-01, DRAFT) — the shadowed view ray resolves through one branch, as on side A

**Status.** Drafted with the harness pin it describes, with the
re-capture of the three affected cases and a paired-arm frame-time measurement
behind it. The one thing those captures are not backed by is a green unfiltered
e2e receipt, which this machine cannot produce; see the last paragraph.

`AtmosphereContext.accurateShadowScattering` (default `true`,
`@takram/three-atmosphere/src/webgpu/AtmosphereContext.ts:87`) chooses how the
airial perspective resolves a **shadowed** view ray. With it on,
`getIndirectRadianceToPointLookup` emits two extra branches and picks between
three formulas; with it off, every pixel takes `scatteringBranch1`, the single
Bruneton branch that shortens the ray by the shadow length
(`runtime.ts:488-580`). Side A has no such choice: it evaluates
`GetSkyRadianceToPoint` once, over the whole view ray, with the shadow length
folded in (`aerialPerspectiveEffect.frag:135`). So on a shadowed pixel the two
sides were computing the same integral two different ways.

Decision: the parity harness pins `accurateShadowScattering = false` in
`configureAtmosphereProfile`, so every profile and every case gets it, and the
library default is untouched. The capture log states what side B ran, next to the
profile it already reported: `B accurateShadowScattering=false`, with
`<- PIN NOT APPLIED` if a refactor ever leaves the context on the library
default. A log that omitted it would read the same whether or not the pin
applied, which is the failure this line exists to make visible. Same class as Amendment 1's `groundAlbedo` pin:
an upstream default that would otherwise make the ladder compare two methods.
The diagnostic raymarch profiles are unaffected, since the flag is read only on
the lookup path.

**What it can change, enumerated.** The package reads the flag in two places
and both are unreachable without a shadow length. In
`getIndirectRadianceToPointLookup` it selects between the three formulas only
where `hasShadow && shadowFlags.z`, that is `shadowLength.x > 0 &&
distanceToPoint > shadowLength.x + shadowLength.y` (`runtime.ts:566-580`); in
`getIndirectRadiance` it only picks the `.Else` of
`If(shadowLength.x.equal(0), ...)` (`runtime.ts:322`, `:340`), so a zero shadow
length takes the `If` body either way. And `shadowLength` is `vec2(0, 0)` unless
light shafts are on and clouds are enabled
(`src/shadow/CloudShadowLengthNode.ts:32-34`, gated from
`src/CloudsPassNode.ts:800`). So the reachable set is exactly the cases that
switch shafts on: 38 `shafts-low-sun`, 39 `shafts-inside-deck`, 61
`shafts-sky-horizon`. Every other committed case executes the identical branch,
and the extra branches cost register pressure only.

"That is bit-identical" is a claim about the 16 commits between the two capture
sessions, not about the pin alone, and the served digest did move across them
(`9fb077d075b4` → `0154da705d7a`). Two things changed that a parity case can
reach, and neither reaches a pixel: `0babe796` moved the parity sides from
`createJitterTexture()` to `createHashJitterTexture()`, and the two are the same
`data[i] = lowbias32(i) & 0xff` loop with only the texture construction factored
into `jitterVolume(data)`, so the parity jitter bytes are unchanged; `0edb729a`
added `showLitShadowAtlas`, whose call sits under `if (!ctx.enabled || camera ==
null)` (`src/CloudsPassNode.ts:946`), which no parity case takes. The rest is
comment rewords.

**Measured so far: static.** Compiling the harness's aerial node both ways
(`compileWGSL`, no GPU) gives 978 WGSL lines and 26 `textureSample` sites with
the default, 910 and 18 with the pin. Same direction as the composite figures
earlier composite figures recorded (1012 → 1328 lines, 33 → 65 sample
sites), smaller because
this is the aerial node alone.

**The prediction, and how it landed.** Stated before any run: all three cases
move, on shaft-covered pixels only, with ssim / deP95 / histDist in the 3rd-4th
decimal; direction not predicted, because LUT provenance and the near-ground
lift still differ; every other case bit-identical. The direction call was right
and the magnitude was wrong by two orders: the movement is in the 5th decimal,
1e-5, not 1e-3. The re-capture says so, and a control re-capture of case 61 on
main in the same session reproduces the committed digits exactly, so the 1e-5 is
signal rather than run-to-run noise.

| case | ssim | deP95 | histDist | plate.B cloudFraction |
|---|---|---|---|---|
| 38 `shafts-low-sun` | 0.982655 → 0.982661 | 1.08 → 1.08 | 0.007852 → 0.007892 | 0.165141 → 0.165141 |
| 39 `shafts-inside-deck` | 0.966299 → 0.966304 | 1.69 → 1.69 | 0.022940 → 0.022956 | 0.403410 → 0.403410 |
| 61 `shafts-sky-horizon` | 0.982391 → 0.982381 | 1.84 → 1.84 | 0.041132 → 0.041145 | 0.252751 → 0.252751 |

All three still pass, wide of the phase-3 bars (0.95 / 5.0 / 0.1). Two cases
move a hair toward A and one a hair away, so **the pin is not a parity gain**:
its case is method alignment, and the picture consequence is a wash at 1e-5.
`deMean`, `deP95`, `maxDiffDelta` and cloud fraction are unchanged to printed
precision, and side A's plate is bit-identical, as it should be.

**Frame time, paired arms** (`scripts/benchmarks/run.mjs`, plan seed 33679486,
5 repeats, ABBA by repetition parity, 1920x1080 dpr 1, WebGPU side only, in a
`quiet.sh` window at load ~10):

| case | old (main, no pin) | new (pinned) | delta |
|---|---|---|---|
| `baseline-medium` (shafts off) | 10.491 ms (10.43-10.62) | 10.318 ms (10.30-10.34) | −0.173 ms, −1.65 % |
| `shafts-sky-horizon` | 14.018 ms (13.83-14.46) | 13.296 ms (13.23-13.39) | −0.722 ms, −5.15 % |

The arms do not overlap on either case, and the pinned arm's within-arm spread
is the tighter of the two. The shafts case gains roughly what was measured at
retina, and the shafts-off case gains a little as well, which the static
analysis does not predict (the extra branches never execute there), so
part of that 1.65 % is register pressure or scheduling rather than work removed.
One caveat to read before trusting the arms: the change is harness-side, so both
arms serve a **byte-identical library** (`build/shared.js` c7259e0c) and the
discriminator is the source hash over `examples/parity/src`, which does differ.
A receipt comparing library bytes could not tell these two arms apart.

**What the captures are not backed by.** They were taken with
`PARITY_SKIP_E2E_RECEIPT=1`, the capture runner's own sanctioned override, which
logs loudly and exists for exactly this case: this machine cannot produce a green
unfiltered receipt, because p4's debug-view test 6b overruns its 60 s budget on
main as well (`Test timeout of 60000ms exceeded`, a quiet
window, re-run alone). **No green receipt is claimed**, and each capture's own
stamp says so in the artifact: `provenance.e2e.verdict "partial"` with
`overrideArmed true`, which `verify-results.mjs` reports as a note and not as a
failure. The committed receipt is not overwritten.

**Which suite ran, and at what load.** The unfiltered suite was run on this tree
and is the real evidence: 125 passed, 3 failed, all three
`Test timeout ... exceeded` and none an assertion, on an otherwise idle
machine. That is **not** a clean run, and nothing below should be read as saying
it is. The captures were taken on that same idle machine, which is why the frame
times above are worth reading, and an earlier attempt on a loaded machine was
discarded rather than reported.

**What the committed captures' own e2e stamp says.** `verdict "stale"`,
`overrideArmed true`, detail `receipt is for inputs 15416e0e8d56, this tree
hashes e1eab6a6f4c5`: the committed receipt predates the disclosure edits, which
touched `examples/parity/src`, so it no longer keys to this tree and the runner
reports the mismatch rather than a pass. A verdict is not a green one here, and
the artifact says which of the three it is. A filtered run now names the tests
that ran (capped at three), so the next capture on a tree whose receipt is
current will read `partial` with the gate's own test named in it rather than a
bare count.

**The tree the captures measured.** `PROVENANCE` is built once at module scope
(`examples/parity/scripts/capture.mjs:122`), long before any `metrics.json` is
written, so each `capture --case` process stamps the tree **as it found it**,
including whatever the earlier processes in the same session left behind. Only
the first case of any run can therefore read `dirty 0`, and the counts climb by
what each finished case wrote. That is exactly what the six committed logs say:

| case | first capture (`5cae6b92`) | re-capture (`1daccc9a`) |
|---|---|---|
| 38 `shafts-low-sun` | `dirty 2` | `dirty 0` |
| 39 `shafts-inside-deck` | `dirty 5` | `dirty 2` |
| 61 `shafts-sky-horizon` | `dirty 8` | `dirty 4` |

The first run climbed by 3 per case, because all three of its output files
changed (`metrics.json`, `capture.log`, `metrics.json.env`); the re-capture
climbed by 2, because `metrics.json.env` came out byte-identical. So `dirty 2`
in the re-capture is case 38's `metrics.json` and `capture.log`, and `dirty 4` is
those two files for cases 38 and 39 — every entry under `parity/results/3/`, all
of it evidence this session wrote. `gitState`
(`examples/parity/scripts/captureProvenance.mjs:25-33`) records a count and not
the paths, so that reading is from the session record and not from the artifact;
recording the paths is the follow-up this paragraph is asking for.

What settles it does not depend on the count. All six captures report
`built == served == 0154da705d7a`, which is also what a clean build of `main`
produces, and `atmosphereProfile.ts` has not changed since `cb4f76a8`, so the
pin was committed content in every one of them. Whatever the entries were, the
bytes measured were the committed bytes, and the two sessions agree on every
metric to the last printed digit.

The other two suite failures in that run were durations too: p2's 16-frame Bayer
test passes alone in 2.8 min against its 180 s budget, and p4's 3.2b receiver
test passes 3 of 3 alone on this branch (1.1 / 1.0 / 1.0 min) and 3 of 3 on main,
so it straddles its budget on both arms. If a later run shows a parity
regression on any of the three cases, the pin is the thing to re-open, not the
thresholds: side A is the reference.

## Consequences

- `CloudsContext` implements the pass-through aliases.
- `CloudsContext.cameraHeight` carries the altitude correction.
- No per-frame uniform is duplicated between atmosphere and clouds contexts.
- The parity adapter can iterate property names without branching on renderer type.

## References

- `reference/atmosphere-webgpu/AtmosphereContext.ts:15–140`
- ADR-004 (context injection pattern)
- `@takram/three-atmosphere/src/webgpu/multiscattering.ts:463–495` (jittered march)
- `@takram/three-atmosphere/src/shaders/aerialPerspectiveEffect.frag:135` (reference LUT lookup)
- `@takram/three-geospatial/build/webgpu.js:1270` (`stbn` indexed by `frameId % 64`)
- `@takram/three-atmosphere/src/webgpu/AtmosphereContext.ts:87` and `runtime.ts:488-580` (Amendment 7 — the shadowed-ray branch choice)
- `src/shadow/CloudShadowLengthNode.ts:32-34` (Amendment 7 — the gate that bounds the affected set to the shafts cases)
- `examples/parity/src/sideB.ts:159` (the 256 pin itself)
- `examples/parity/src/readbackRows.ts`, `src/march/cloudsFragment.ts:246` (Amendment 5's two changes)
