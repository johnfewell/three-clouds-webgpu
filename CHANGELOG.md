# Changelog

Notable changes to `three-clouds-webgpu`, the WebGPU/TSL port of
`@takram/three-clouds`. No package has been published to npm. Versioned notes
describe candidate tarballs; earlier entries describe historical or unreleased
work.

## 0.1.0-alpha.8

- Fix the experimental `cloudEnvironment` bake weighting the sky behind the
  clouds by their opacity instead of their transmittance. A cloud-free direction
  baked black, so reflections and image-based lighting lost the sky, and the sky
  showed through clouds. The bake now composes the sky behind the layer the same
  way the screen composite does. At coverage 0 it equals a sky-only environment
  bake. Reflections under cloud are darker than before, because the clouds no
  longer let the full sky through.
- Fix experimental rain shafts lowering the layer's opacity, so a rain curtain
  let more of the scene behind it through instead of dimming it.
- Name fork release 8 (`0.19.1+fork.8` / `0.9.1+fork.8`) in the install hints
  of the fork-marker errors.

## 0.1.0-alpha.7

- Target stock **Three.js 0.187.0**, with matching `@types/three` 0.187.0. The
  `three` peer range is now `>=0.187.0 <0.188.0`.
- Update the cloud nodes and light registration for r187, with no intended
  change to cloud rendering math.
- Update the vendored atmosphere and geospatial forks to `0.19.1+fork.8` /
  `0.9.1+fork.8` for r187 type compatibility.
- Update the plain Three.js, explicit render-graph and React Three Fiber
  consumer recipes.

## 0.1.0-alpha.6

- Fix cloud-shadow cascade fitting for cameras with reversed depth. Near/far
  frustum corners now follow the camera's projection convention, preserving
  the ordinary cascade bounds, split intervals and texel sizes.
- Inherit the renderer's reversed-depth clear value when reading scene depth.
  Empty sky no longer becomes a false far-plane surface that clips cloud rays.
  Explicit clear-depth overrides remain supported.
- Add normal/reversed cascade, scene-depth and temporal-reprojection regressions,
  plus hardware midday/sunset comparisons. No defaults or presets change.
- Support stock Three.js 0.185. The `three` peer range is now
  `>=0.184.0 <0.187.0`. On 0.185 the npm builds of `@takram/three-atmosphere`
  and `@takram/three-geospatial` fail at import, so the recipes pin fork builds
  `0.19.1+fork.7` / `0.9.1+fork.7` with pnpm `overrides`. The repository no
  longer patches three.
- Support stock Three.js 0.186 on fork release 7 only. r186 declares a node shared
  across branches in one branch only. Four port sites now build such nodes per
  branch (the march mip level, the shadow-map debug tiles, the cloud environment's
  ray state and the compute resolve's tile origin), which leaves 0.185 output
  unchanged. Fork release 6 does the same for the atmosphere's scattering LUT, and
  release 7 adds a `forkBuild` marker to the atmosphere package. On r186 the
  package refuses to load unless both packages' markers declare the fix and name
  the same release.
- **Breaking:** `CloudShadowedAerialPerspectiveNode` is removed from the package
  root. Fork release 3 of `@takram/three-atmosphere` gives `AerialPerspectiveNode`
  optional `shadowNode` and `lightingMaskNode` inputs, and
  `aerialPerspectiveWithCloudShadow` and `createCloudsIntegration` now set them on
  the plain node. A hand-built aerial node sets `node.shadowNode` instead of
  constructing the subclass. The output is unchanged up to float32 rounding.
  On an atmosphere build without these inputs (npm 0.19.1), requesting a cloud
  shadow or lighting mask now throws instead of rendering without them.
- Prepare for Three.js r187 without changing the peer range: fullscreen passes
  bind their materials at construction, and the React recipe sets
  `PCFShadowMap` explicitly and voids the now-asynchronous
  `renderer.dispose()`. r187 requires these and 0.185 accepts them.

## Added

- **`experimental.staticMode`**, an opt-in static rendering mode that idles the
  GPU when scene inputs are unchanged. When camera pose and projection, sun
  direction, simulation time, context parameters, and viewport size remain
  stationary and temporal histories have converged, the pass skips the primary
  cloud raymarch, shadow map generation, and temporal resolve passes, reusing
  the previous frame's output. Rendering resumes on any camera motion, knob
  change, or texture mutation.
- **`experimental.cirrusDeck`**, an opt-in high-altitude cirrus deck rendered
  from a procedural 2D streak tile. It evaluates a ray-sphere hit at cloud deck
  altitude with cube-sphere UV mapping, analytic level-of-detail sampling, and
  atmospheric sunlight and skylight irradiance, compositing behind the
  volumetric clouds (or in front when viewed from above). Knobs on
  `ctx.cirrusDeck`: `altitude`, `strength`, tile `scale`, drift `velocityU` and
  `velocityV`, and a custom `texture`.
- **`experimental.rainShafts`**, opt-in precipitation curtains hanging beneath
  convective storm cells down to the ground. Placed by the cell mask thresholded
  by convective profiles, shafts are rendered as a thin participating medium
  illuminated by ambient irradiance and darkened by the clouds' marched shadow
  length. Knobs on `ctx.rainShafts`: `strength`, `density` (extinction per
  metre) and `slant` (lean from cell base to ground).
- **Four opt-in cloud-shape controls on `ctx.cloudShape`**: a darker base
  (`baseShadowStrength`, `baseShadowHeight`), a coverage bank toward the horizon
  (`horizonCoverageAmount`, `horizonCoverageStart`, `horizonCoverageRamp`), wind
  shear that tilts cloud tops (`windSkewEast`, `windSkewNorth`), and one
  rounded-to-wispy edge knob (`erosionShape`). The strengths default to zero
  (neutral and inactive) and compile conditionally at graph time with zero
  overhead when unused.
- **`WaterProCloudSky` adapter**, connecting `cloudsPass.environment` to
  `threejs-water-pro`. It converts real-time cloud environment cubemap bakes into
  a 2:1 equirectangular render target that Water Pro samples for water
  reflections and horizon fog tinting.
- **WebGPU Storybook showcase stories** for lightning, rain shafts, whole-scene
  presets with solar time-of-day synchronization, and static mode with a live
  on-screen GPU frame time and skip status readout.
- **`cloudsPass.cloudShadowAt(worldPosition)`**, the cloud shadow for materials of
  your own — water, vegetation, particles, anything lit in the open. It returns
  the sun transmittance in `0..1` (`1` lit, `0` shadowed) from the same cascaded
  shadow atlas and the same sampler the aerial perspective lights the ground
  with, so a material and the ground under it agree. Nothing is built until you
  call it, and the radius defaults to `DEFAULT_SHADOW_RADIUS` where the aerial
  consumer computes an adaptive one.
- **Opt-in rendering experiments**, reachable through the experimental options:
  cloud-front refinement, compute resolve, wind reprojection, distant-cloud
  shadows, directional skylight, and a distant-shape detail fade. Front refinement
  adds density sampling and directional skylight is a constrained approximation,
  not a full spherical-harmonic lighting model. Five default off; the
  distant-shape detail fade defaults on.
- **`lightShaftsHalfResolution`** (default on). The light-shaft shadow length is
  marched once per 2x2 quad instead of once per fragment, a quarter of the
  march cost. It needs the device's `subgroups` feature; where that is
  unavailable the pass ignores the flag and marches per fragment. Set it to
  `false` for the original's behaviour.
- **`shadow.updateInterval`** (default 2, original 1). Renders the cloud shadow
  map every N frames. The cascade fit is not moved by a skipped frame: the map,
  its matrices and its intervals stay the consistent set they were rendered as,
  and only the view-depth row follows the camera. A structure change, a history
  reset and the first frame all render regardless. With the map accumulated
  over roughly 100 frames the picture barely moves, and the temporal alpha
  compounds so it converges per wall-clock frame as before. A moving camera can
  leave the newest sliver of the view unshadowed for up to N-1 frames.
- **`resetHistory()` on the pass**, reachable through the R3F component refs,
  and a packed `/webgpu` type export that resolves in a consumer project.
- **An optional per-surface lighting mask** on the aerial adapter, for scenes
  that need some surfaces lit and others in shadow. Atmospheric transmission
  and inscattering are preserved; the default behaviour is unchanged.
- **A blue-noise default jitter volume.** `createJitterTexture()` now returns a
  generated blue-noise volume built synchronously from an embedded rank map, so
  the pass needs no texture download on first use. The previous hash volume
  stays available as `createHashJitterTexture()`. The Storybook's `jitter`
  option now offers `blue | stbn | hash`.
- **A migration guide** mapping every public property of the WebGL
  `CloudsEffect` onto this port as ported, dropped with a reason, or a
  documented addition. The knob table in it is generated from the parity
  adapter and compared verbatim by a test, so the document and the code cannot
  drift apart.
- **A portable benchmark suite** for comparing two revisions and both
  renderers, with deterministic matrix runs and JSON/CSV output, plus
  `docs/BENCHMARKS.md` covering macOS and Windows. GPU intervals are measured
  separately from CPU submission and completion wall time, and each run records
  the served build path, source and artifact hashes, GPU identity and applied
  settings.
- **An authored Storybook**, shaped after upstream `storybook-webgpu`, with the
  WebGL original's stories beside the port's for A/B comparison, and a
  maintainer review guide.

## Changed

- **Deduplicated texture fetches in the shadow march.** The shadow optical depth
  raymarch now samples each cloud texture volume (`shape` and `detail`) once per
  step into local variables rather than re-fetching during density evaluation,
  reducing redundant texture reads and generating cleaner shader code across the
  cascade.
- **`experimental.cloudFrontRefinement` is on by default.** An empty-to-dense
  bracket is bisected four times, so a cloud front sits on the real boundary
  instead of up to one full march step behind it. The cost measurement that
  promoted it put every frame-time delta inside the inert-control noise floor, at
  most 0.6 percent of a 15 ms frame. Set it to `false` for the unrefined walk;
  reference mode pins it off, so the parity ladder is unchanged.
- **`experimental.directionalSkylight` stays opt-in.** It was in the same promotion
  batch, and it is held back deliberately: with it on, `cloudsPass.composite()`
  throws while building the whole pass graph, because the skylight term reads the
  atmosphere's indirect-luminance struct and that is null when the graph is built
  without a builder context. That is a build-time defect to fix, not a quality
  question.
- **`experimental.distantShapeDetailFade` is on by default.** The detail term
  now fades with mip level instead of switching off at a threshold, which drops
  the bright speckle the reference's binary choice produces on small clouds past
  roughly 40 km: on four horizon views that speckle fell by 10 to 63 percent
  while a structure measure moved by -1.5 to +1.0 percent, and the frame time
  stayed inside the same vsync interval. It is the one experiment with both a
  quality and a cost measurement. Set it to `false` for the original's choice;
  reference mode pins it off, so the parity ladder is unchanged.
- **Faster by default.** The two performance knobs above became the defaults,
  so a fresh install gets them without reading the docs. On the Storybook Basic
  story the port measures about 0.72x the original's frame time at library
  defaults, and 1.0-1.17x it with settings matched in the parity harness.
  See `perf/FINAL-2026-09-24.md`.
- **The atmosphere uses its LUT lookup by default**, the method the WebGL
  original uses. The unconditional raymarch sample pin is gone; a
  `raymarchScattering` opt-in and sample-count diagnostics remain available.
- **`qualityPreset` now applies its graph-shape fields.** Setting `low` or
  `medium` previously left the high preset's per-sample sun and sky lighting
  compiled in, because the preset wrote to the plain `clouds` shorthand object
  that the compiled graph never reads. `multiScatteringOctaves`,
  `accurateSunSkyLight` and `accuratePhaseFunction` now route through their
  setters, so a preset actually changes what is compiled.
- **Cloud layers are specialised at graph time.** The layer set's structure
  (which lanes are active, whether the weather exponent is one everywhere,
  whether the density profile's exponential term is zero) is read as a graph
  flag and a cache key, so the march drops work for the default layer set.
  Changing a magnitude such as `densityScale` still rebuilds nothing.
- **One resolve pass for colour and shadow length**, as the reference does.
  Scatter anisotropy and the shadow cascade count are graph-time constants
  rather than uniforms, which the compiler can fold.
- **Examples clear the scene background** instead of drawing a second sky. The
  aerial node paints its own sky over every far-plane pixel, so a
  `skyBackground()` background node was a full sky evaluation that was always
  overwritten.
- **The README is a concise front page**: quick start that links the canonical
  wiring rather than copying it, requirements, features, and known differences
  with their decision-record links. It links a live Storybook demo, and the
  Storybook's port section is named `clouds-webgpu` to match the original's
  `clouds-webgl`, so every story names its renderer.
- **The examples run.** Three defects had made both `examples/basic` and
  `examples/r3f` unrunnable or black: imports that failed at module load, a
  context registration race that built the sky graph with no atmosphere, and an
  unset sun, which renders black without an error because the zero vector is
  valid arithmetic through the march, sky and shadow.
- **The Storybook's port stories use plain AgX**, as the WebGL stories do, so a
  low-sun scene is no longer rendered at roughly half brightness by the display
  transform. Its 3D Tiles stories gained Toronto, and their attribution line
  keeps provider credits unique, keeps the logos and links, and wraps.

## Fixed

- **Static mode now waits for all temporal histories to converge** before
  pausing rendering. The tracker waits until full-resolution colour temporal
  antialiasing and cascaded shadow atlas history have settled to steady state,
  preventing incomplete or blending frames from being frozen.
- **Static mode resume triggers expanded to all per-frame parameters.** Changes
  to density profile coefficients across all four cloud layers, cloud minimum
  thresholds, haze parameters, and procedural texture buffer refills now
  immediately resume active rendering.
- **Storybook WebGPU atmosphere parameters match the WebGL baseline.** Ground
  albedo is pinned to 0.1 in the WebGPU Storybook atmosphere helper (correcting a
  1.10x clear sky over-illumination caused by the default 0.3 albedo), and lens
  flare bloom intensity was reduced from 0.05 to 0.005 with glare spikes
  disabled to match the WebGL original's sun appearance.
- **Duplicate TSL declaration notices eliminated at the source.** Unique
  declaration names for spatio-temporal blue noise (`stbn`) and cloud type tent
  weights prevent Three.js from logging rename notices (`Declaration name already
  in use`) in the browser console.
- **A hard vertical sky seam in `examples/basic`** caused by an unassigned
  camera reference on the atmosphere context. Uniforms derived from the camera
  previously defaulted to identity and the origin, evaluating sky integration
  from the Earth's center along a view-space ray.
- **Temporal upscale streaked at render heights that are not a multiple of 4.**
  The Bayer row was mirrored by absolute row, which only matched the marched
  jitter phase when the height was a multiple of 4, so at other heights each
  fresh texel took another row's march sample and the whole cloud layer
  streaked horizontally. The mirror is now height-independent. A no-op at
  every multiple of 4.
- **The Bayer row was selected top-down where the original selects bottom-up**,
  which mirrored the Bayer phase on all 16 temporal frames in both the colour
  and shadow-length resolve paths.
- **Light shafts were inert.** The pass's shadow-length node was null until
  setup ran, but every consumer read it while wiring aerial perspective, so the
  atmosphere's no-shadow branch was taken and shafts did nothing. The node is
  now live from construction.
- **The aerial node's sky was computed and discarded**, so light shafts never
  reached sky or ground rays. The sky now goes into the returned luminance.
- **Cloud aerial perspective ignored the marched shadow length**, so clouds seen
  through shafts kept their unshadowed in-scatter. It now takes the last
  `shadowLength` of the camera-to-front ray, the way the original reads it.
- **The shadow-length attachment put the camera end of every geometry ray into
  the shadowed interval** instead of the surface end, which shadowed the wrong
  part of every geometry ray. Sky pixels now carry the march length with the
  camera end at zero.
- **Marched cloud volume reads used an implicit mip level.** Under
  non-uniform control flow that is undefined in WGSL, and the shape and detail
  volumes were sampling the wrong level. They now use an explicit level zero.
  On `layers-4-shadow` this moved SSIM from 0.728 to 0.959.
- **The shadow march clamped the denominator of its weighted depth**, so a dense
  first sample pulled the estimated cloud front kilometres toward the ray
  origin. It now preserves every positive weight. A measured case went from a
  6.5 km reported front to 15.2 km against the reference's 15.2 km.
- **Cloud-shadow PCF ran 16 taps where the original runs 8.**
- **A disabled pass left a frozen cloud shadow on the ground**, because the
  disabled frame returned before rendering the shadow maps and nothing cleared
  the atlas. A disabled frame now serves an all-zero atlas, so every consumer
  sees no cloud shadow.
- **Textures assigned after the first built frame bound to the wrong slot.**
  The shape, shape-detail, weather and turbulence textures shared placeholders,
  so a late assignment gave the detail volume the shape volume's binding and
  turbulence the weather map. Each slot now has its own placeholder.
- **The haze knobs never reached the haze march.** They were built from literals
  and never written each frame, so a runtime change to haze density, exponent
  or scattering and absorption coefficients had no effect.
- **Logarithmic scene depth was decoded four times per fragment** where the
  helper already decodes once with the scene camera.
- **Cloud history inherited opaque black on reset**, which temporal resolve
  reads as a value rather than as nothing. Both history targets are now
  explicitly zero-filled, including layered shadow history.
- **The shadow-atlas placeholder uploaded null data** instead of real zero
  texels.
- **The shadow-map debug view was vertically mirrored** relative to the
  original's own layout.
- **A nested knob passed flat applied nothing**, silently.
- **The 2D procedural texture minified with a single mip level** where the
  original blends two.

## Internal

- A pre-commit hook runs ESLint and Prettier over staged files, preventing lint
  and format failures from reaching CI. Continuous integration workflows now
  skip draft pull requests until marked ready for review.
- End-to-end Playwright tests allocate free ephemeral ports per test run,
  strictly refuse existing servers or servers serving a different checkout
  tree, and enforce `--strictPort` on all development servers.
- The compiled graph variant digest test matrix was reduced from exponential
  combinations to the all-off baseline, individual active options, and pairwise
  combinations, keeping verification times and fixture sizes bounded as
  experimental features expand.
- Tests that execute builds or inspect the shared build directory are serialized
  to prevent parallel Vitest workers from racing against empty build outputs.
- Parity tools can inspect and read back raw shadow atlas array render targets
  directly from WebGL and WebGPU pipelines, allowing texel-by-texel
  transmittance comparisons across cascade levels.
- Architectural performance investigations isolated knock-out GPU clock-state
  artefacts in raymarch benchmarks and characterized shadow march latency
  sensitivity to 2D weather texture lookups.
- Release manifest decisions recorded for public documentation guides.
- Tracking and task records synchronized between local database states and the
  repository.
- A merge-check script typechecks a pull request's merge onto current `main` in
  a throwaway worktree with its own install, because `mergeable=MERGEABLE` is a
  statement about text, not types.
- Worktree isolation tooling, including a refusal when a capture would measure
  a different tree than the one it was launched from, and provenance receipts
  that gate on the bytes a capture actually served rather than on the source it
  was launched from.
- Capture and verification tooling hardened throughout: provenance stamped into
  committed metrics, receipts read at verify time, unknown capture arguments
  refused before bench work, and the accepted-difference register made an
  executable contract rather than a comment.
- The parity harness gained 63 cases with committed metrics, a final 59 pass /
  4 expected-difference ladder, and a written known-differences register.
- A quality-gate pass restored the project's shader complexity and decision
  point bars to green after the performance work pushed several functions over,
  fixed by extraction with the emitted shaders unchanged.
- Comment and documentation conventions are now lint-enforced across the
  library, examples and plain `.mjs` scripts, with an auto-fix and a
  comment-only-change guard.
- CI runs the library gates, typecheck, lint, formatting and tests on every
  push, re-evaluates committed parity metrics against their thresholds, and no
  longer needs Git LFS: capture images are produced locally and metrics only
  are committed.
- The browser smoke half of the example-wiring gate is named a hardware gate
  rather than treated as CI-covered, since a GPU-less runner cannot run it.
- Decision records for the render graph, parity methodology, quality gates,
  jitter volume, temporal upscale, shadow encoding, layer buffer convention,
  package identity and the known shadow-resolve limitations, each mirrored on
  the project tracker.
- Many low-value and self-set tests were deleted after audit, and source-grep
  tests that could not fail were removed.
