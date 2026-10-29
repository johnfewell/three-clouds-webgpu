# Cloud types: original design and extension contracts

These notes record the cloud-variety design from 2026-10-02. They explain the
original constraints and the proof required for an optional extension. Names,
defaults and source line numbers below describe that design snapshot; use
[EXPERIMENTAL.md](../EXPERIMENTAL.md) and [API.md](../API.md) for current behavior.

The compatibility contract is that disabling an extension preserves reference
output. Section 7 describes the compiled-shader proof of that contract.

## 1. What the port renders today, and why that is one type

`CloudLayers.DEFAULT` (`src/CloudLayers.ts:57`) is two overlapping low slabs at 750–1400 m
and 1000–2200 m, one near-invisible slab at 7500–8000 m (`densityScale` 0.003,
`shapeDetailAmount` 0), and one empty lane. That is a fair-weather cumulus sky with a cirrus
stand-in. Variety is missing for four separate reasons, and each needs a different fix:

| Limit | Where | Consequence |
| --- | --- | --- |
| One shape vocabulary | `src/density/sampleShape.ts:57` | every layer carves from the same `shapeTexture`, so a cirrus streak and a cumulus lump are the same noise at a different scale |
| One vertical shape law | `src/density/layerDensity.ts:15` | the profile is **convex on `[0,1]`** — see below. A flat-topped deck is reachable; an anvil is not |
| One coverage law | `src/density/shapeAltering.ts:8` | coverage is modulated by `1 - (2·h^bias - 1)²`, a symmetric bump. Stratiform (flat top) and cumuliform (bumpy top) are the same curve at different `bias` |
| No per-location type | `src/density/sampleWeather.ts:74` | the weather map is RGBA, and each channel is one layer's coverage. It carries no second, orthogonal signal |

The first three are reachable with existing knobs and are **the presets'** job.
The fourth needs new plumbing and is **the map's**. Cirrus, convection and evolution need
new maths.

### Why the four-term profile cannot make an anvil

This limit distinguishes a preset from a new convective profile. The
profile is `A·e^(B·h) + C·h + D` on `h ∈ [0,1]`, and with `A ≥ 0` (density is a magnitude):

- `d²/dh² (A·e^(B·h)) = A·B²·e^(B·h) ≥ 0`
- `d²/dh² (C·h) = 0`

so the sum is **convex on the whole interval**. A convex function has an interior maximum
only if it is constant, so this family can never rise and then flatten, which is exactly what
an anvil is.

This separates the existing preset controls from a new profile evaluator:

- **A flat-topped deck is reachable.** Convex increasing profiles give a hard lid, which is
  what stratocumulus and altostratus need, using existing knobs.
- **An anvil is not.** It needs a concave shoulder above the tower, which no choice of
  `A, B, C, D` produces. It needs the new evaluator in §3.3.

Also note the default is *degenerate*: `DensityProfile.DEFAULT` has `expTerm` 0
(`src/DensityProfile.ts:10-13`), which `CloudLayers.structure` detects and compiles the
exponential away entirely (`src/density/sampleShape.ts:135-138`), leaving a straight line
`C·h + D`. The default vertical profile is a ramp, not a curve.

## 2. The three constraints that will bite

Read these before designing. Each one is a hard limit of the current architecture, not a
style preference.

### 2.1 The weather map has no spare channel

`createSampleWeather` swizzles the RGBA sample by the four layers' `channel` values
(`src/density/sampleWeather.ts:12-24`, `:74-80`). Four layers on four channels uses the whole
texture. The alpha channel looks free and is not: the reference computes a 4-octave Perlin
into alpha and then overwrites it with `1.0` (`src/textures/localWeather.ts:41-43`, `:69`), so
the port writes 1 there.

**Decision: a cloud-type signal is a SEPARATE low-resolution texture, not a fifth channel.**
Do not repurpose alpha. `CloudLayer.channel` is a public WebGL-compatible name
(`src/CloudLayer.ts:46`) and changing what a channel means breaks the parity harness's
frozen-feature neutralisation. One new 2D texture, sampled once per step, preserves the meaning of the existing
weather channels.

### 2.2 The empty-space skip has exactly three gap slots

`packIntervalHeights` sweeps the eight layer edges and writes at most **three** gaps into
`minIntervalHeights` / `maxIntervalHeights` (`src/CloudLayers.ts:24-27`, `:219-258`). Those
gaps are the complement of the occupied bands inside the cloud shell, and
`insideLayerIntervals` (`src/march/primaryMarch.ts:125`) uses them to take a big step
(`primaryMarch.ts:672-687`). A height in a gap costs one step; a height in an occupied band
costs a full weather + shape + detail sample.

Four disjoint layers need five gaps and only three are recorded. Re-implementing
`packIntervalHeights` and counting:

| Layer set | Gaps needed | Recorded | Lost |
| --- | ---: | ---: | --- |
| `DEFAULT` (3 occupied, overlapping) | 2 | 2 | none |
| cirrus at 7–12 km overlapping the high band | 2 | 2 | none |
| 4 disjoint bands | 5 | 3 | `[0, 500]` below the deck, `[12000, ∞]` above it |

The lost gaps are the cheapest thing to give up, so **the below-deck gap is the one that
hurts**: a disjoint low layer is exactly the one that loses it, and every upward ray pays
full samples from the ground to its base. This is **correct but slow, and it gets slow
silently**: no warning, no console line, just a taller GPU number.

**Decision: keep the four layers height-overlapping.** A variety feature that needs a
disjoint band must either overlap an existing layer's altitude range or take the cost
deliberately and say so with numbers. For a cirrus shell at 7–12 km specifically: the default
high layer already occupies 7500–8000 m, so overlapping it is free and the gap count actually
*drops*. Do not add a fifth band above the existing ones.

### 2.3 Graph-time shape is polled, not settable

Anything that changes the *compiled* graph needs a `graphVersion` bump, and the existing
mechanism is a per-frame poll, not a setter (`src/CloudsContext.ts:482-534`). Setters exist
for context-owned fields (`enabled`, `haze`, `shapeDetail`); per-layer facts are polled
because `CloudLayer` is a plain property bag with no owner to notify
(`src/CloudLayer.ts:48`).

**Decision: new graph-time facts go in a poll.** Add one `checkX()` beside
`checkLayerStructure`, seed its cached value from the new state, and include the new fact in
the existing key string. Do not add a setter that mutates a `CloudLayer` field.

New facts that must NOT bump `graphVersion`, because they are magnitudes on an existing
uniform: coverage, `densityScale`, `shapeAmount`, `shapeDetailAmount`,
`coverageFilterWidth`, `densityProfile` terms, altitudes and heights. A tower 12 km tall and a
deck 700 m tall differ in `altitude`/`height`, which are uniform magnitudes, so **tall layers
need no rebuild at all** (`src/layerUniforms.ts:92-136` folds altitude/height into
`minHeight`/`maxHeight`/`shadowBottomHeight`/`shadowTopHeight` every frame).

## 3. Shared extension points

Use these names. They are additive, they live under `src/experimental/`, and none of them
requires editing a shared file to be useful.

### 3.1 `experimental` options

One boolean per feature, in `src/experimental/options.ts`, all defaulting to `false`. This is
the opt-in gate for the proposed features, and it is what the §7 digest test keys off.

```ts
export interface ExperimentalCloudOptions {
  // existing five, unchanged
  cloudFrontRefinement: boolean
  computeResolve: boolean
  windReprojection: boolean
  distantCloudShadows: boolean
  directionalSkylight: boolean
  proceduralWeather: boolean
  cirrusShell: boolean
  convectiveProfile: boolean
  cloudTypeMap: boolean
  evolvingWeather: boolean
}
```

The existing setter merges partials and throws on any key not present in `experimentalDefaults`
(`src/CloudsContext.ts:288`), so **a key added to the interface but not to
`experimentalDefaults` makes every consumer throw a `TypeError`**, not silently no-op. Add
both lines in the same hunk. It bumps `graphVersion` and resets history when the value actually
changes, so nothing else is needed to make a feature rebuild.
Keep the interface and defaults synchronized whenever a feature is added.

### 3.2 One new file per feature, nothing else

`src/experimental/cloudTypePresets.ts`, `proceduralWeather.ts`,
`cirrusShell.ts`, `convectiveProfile.ts`, `cloudTypeMap.ts`,
`evolvingWeather.ts`. Each exports pure data or pure functions plus its CPU twin.
Shader-side maths goes in `src/density/` or `src/march/` next to what it modifies, named for
the maths rather than the feature, so two features that need the same helper converge instead
of duplicating.

A helper needed by multiple features should have one implementation. Candidates are a
height-gradient profile evaluator and a type-blend evaluator (§3.3, §3.4).

### 3.3 `HeightProfile`: a per-layer vertical shape law

`DensityProfile` (`src/DensityProfile.ts:8`) is four scalars packed one-lane-per-layer into
`vec4`s (`src/layerUniforms.ts:29-32`). That packing is the constraint: four terms, four
lanes, no room for a fifth. To get an anvil you need a law the four-term family cannot
express.

**Decision: `convectiveProfile` (§3.1) turns on a separate `Fn` that
returns one `vec4`, one lane per layer, replacing `getLayerDensity` in
`sampleShape.ts:135-145` only when the flag is on.** The existing call stays byte-for-byte when
it is off, which is what makes the digest test pass. Keep the old function exported and keep
its CPU twin; the new evaluator gets its own.

Do NOT extend `DensityProfile` with new terms. It would change the packed uniform layout, the
`CloudLayer.copy` surface, `layerUniforms.test.ts`, and every snapshot that hashes the packed
vectors, for a feature that is off by default and therefore must not change any of them.

### 3.4 `CloudTypeMap`: one texture, one scalar

A separate low-res 2D texture (§2.1) holding one scalar per location in `[0,1]`: 0 is
stratiform, 1 is cumuliform. Every feature blends against that one scalar.

**Decision: define the type map and its sampler once, and let
the rest consume it.** `cirrusShell`, `convectiveProfile` and `cloudTypePresets` all want to
know "how cumuliform is it here". If each defines its own, the package ships three overlapping
vocabularies. If one owns it:

- the texture is a `ProceduralTexture2D` (`src/textures/ProceduralTexture.ts:152`) so it can
  be generated from a seed like everything else in `src/textures/generators.ts`, with a
  baked PNG as the parity-harness default;
- its accessor is a function returning `Node<'float'>` for a world position, derived from
  `getGlobeUv` (`src/density/globeUv.ts`) the same way the weather sample is, so it moves
  with `localWeatherRepeat`/`Offset` for free;
- it is sampled with an explicit `.level(float(0))` or a computed level hoisted to uniform
  control flow. **An implicit-LOD sample inside the march loop returns zeros on Dawn**, which
  reads as "the feature is off" rather than as a bug.

### 3.5 Where a cirrus shell composites

Two options are possible; compare their measured cost.

**In-march** (recommended): the shell is just another occupied band on an existing lane, with
a thin height range, its own `densityScale`, `shapeDetailAmount` 0 and a wind-sheared `vec2`
shape source. It composites for free: the march already sums the four lanes into one
extinction (`src/density/sampleShape.ts:153-166`) and the composite node already blends the
cloud layer over the scene with `dst·(1-α) + c` (`src/CloudsPassNode.ts:553-561`). It is also
inside the aerial perspective for free, because the march carries `weightedDistanceSum`
(`primaryMarch.ts:167-170`) and the cloud pass applies atmosphere to its own contribution.

**Separate pass**: only worth it if the shell must be visible *through* gaps in the
volumetric layers or lit by a different phase function than the march can express. The cost is
a whole extra fullscreen pass, its own history/TAA participation, and its own aerial
perspective, because the composite above has already had the scene's atmosphere applied to
`dst` and a separate pass would need to re-derive it.

Whichever you pick, note that `CloudLayer.channel` selects the weather channel, so a shell that
does not want to consume one of the four must overlap another layer's altitude range (§2.2)
and reuse its channel.

### 3.6 Ice and water phase

The march shades with one phase function for all four lanes (`src/lighting/phaseFunction.ts`),
mixed by anisotropy knobs on `CloudsContext`. Cirrus wants a strong forward lobe plus a halo
that water drops do not have. Adding an ice phase is a **lighting** change, not a layer
change, so it is per-context, not per-lane: a single ice fraction applied to the whole layer
is the cheapest thing that reads correctly. Do not try to make the phase function per-lane
through the `mediaWeight` vec4; it is a mixing weight, not a parameter vector.

### 3.7 March bounds and the step budget

`maxRayDistance` is 2e5 m and `maxIterationCount` 500 with `minStepSize` 50 / `maxStepSize`
1000 (`src/qualityPresets.ts:138-141`). A 12 km tower at a shallow view angle is well inside
the distance cap but competes for the 500-step budget, and it makes the gap-skip in §2.2
matter more because the taller band is occupied for longer. Report the step cost, not just
the wall clock.

### 3.8 Shadow cascades and tall layers

Cascades split the **view frustum along the ground**, not by height
(`src/shadow/CascadedShadowMaps.ts:353-361`), so a 12 km tower needs no cascade change. What
it needs is ground **range**: `shadow.maxFar` is 5e4 m (`qualityPresets.ts:162`) and a tower
shadow at low sun is long. At 15° elevation a 12 km top casts about 45 km of shadow, which
just fits; at 8° it does not. `shadowTopHeight` / `shadowBottomHeight` come from the layers
every frame (`src/layerUniforms.ts:92-136`) and gate the Beer-shadow and ground-bounce
branches below the shadow top (`primaryMarch.ts:235`, `:269`), so those already follow a tall
layer for free.

**Decision: raise `shadow.maxFar` as part of the convective preset, not as a library
default.** It is a preset field, already per-preset, and changing the default would move the
parity ladder.

## 4. Feature guidance

| Feature | Do this | Do not |
| --- | --- | --- |
| presets | pure data over existing knobs; one `experimental` key only if you add a knob that does not exist | touch `CloudLayers.DEFAULT`; "fix" the default cirrus layer |
| procedural weather | `ProceduralTexture2D` in `src/textures/`, seeded, with CPU twin + WGSL snapshot | replace the baked default; the harness must keep reading the PNG |
| cirrus | §3.5 in-march, §3.6 ice fraction, reuse the 7500–8000 m band | add a 5th disjoint band (§2.2) |
| convective | §3.3 `HeightProfile`, §3.7 and §3.8 measurements | change `DensityProfile`'s shape (§3.3) |
| type map | §3.4, own the definition, let the rest consume | add a fifth weather channel (§2.1) |
| evolution | offset + coverage from `ctx.time` only, seek-safe | bake a clock or a `deltaTime` |

## 5. Storybook

`examples/storybook` already exists with the WebGPU stories in `src/clouds/`
(`Clouds.stories.tsx`, `Experiments.stories.tsx`). Follow
`src/clouds/controls/experimentalControls.ts`: one `experimentalArgs()` / `experimentalArgTypes()`
per feature, with `experimentMode: 'baseline' | 'experiments'` so the off state is one click
away and is what the stills should show beside the on state.

Use an available development-server port and stop the server after the review.

## 6. Keeping changes focused

`src/CloudLayer.ts`, `src/CloudLayers.ts`, `src/CloudsContext.ts`, `src/CloudsPassNode.ts`,
`src/experimental/options.ts`, `src/index.ts` connect many features. When editing one:

- one hunk, smallest possible, no reformatting of neighbours;
- new export lines grouped at the end of the existing block;
- no new import unless the module genuinely cannot live under `src/experimental/`;
- re-read the file immediately before editing; another change may have landed since you read it.

## 7. The byte-identical-off proof

Each optional extension uses the same proof so its effect can be checked independently.

Digest the compiled WGSL, not a screenshot. `test/helpers/compileWGSL` compiles TSL to WGSL
with no GPU, so this is a unit test.

```ts
import { compileWGSL, normalizeWGSL } from '../helpers/compileWGSL'
import { createHash } from 'node:crypto'

const digest = (wgsl: string) =>
  createHash('sha256').update(normalizeWGSL(wgsl)).digest('hex')
```

**Use `normalizeWGSL`**, not the raw string: it already replaces `nodeVar3`-style counters
with a fixed `nodeVarN` (`test/helpers/compileWGSL.ts:190`). Without it the digest moves
whenever an unrelated node is added to the graph upstream, which is exactly the false
failure that would train everyone to ignore this test. `compileWGSL` returns
`{ vertex, fragment, boundTextures }`; digest `fragment` (and `vertex` if your feature can
reach it) separately so the failure message says which shader moved.

Build the graph twice from one context, once with the feature off and once on, and assert

1. the **off** digest equals a digest literal committed from `main`, and
2. the **on** digest differs.

Both halves matter. (1) alone is satisfied by a feature that never reaches the shader; (2)
alone is satisfied by a feature that leaks into the default path. If your feature adds a
branch under an `if (flag)`, (1) holds for free and you are asserting the guard is real.

`compileWGSL` **throws on `THREE.TSL` console errors**, so it also catches a graph that fails
to build.

Getting a digest literal from `main` means compiling on `origin/main` and printing the digest.
Do it once per feature and commit the literal with a comment naming the `main` commit.

## 8. Sources

Every URL below is either already cited in this repository or was checked when this doc was
written. Each entry names the decision it is meant to inform. `reference/clouds/README.md`
carries the upstream list; this is the subset that bears on variety.

- [Nubis: Authoring Realtime Volumetric Cloudscapes with the Decima Engine](https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine)
  — towering convective clouds, and why authoring them needs a vertical shape control a
  fixed-thickness slab does not have. Bears on the convective profile in §3.3.
- [The Real-time Volumetric Cloudscapes of Horizon Zero Dawn](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn)
  — several cloud types out of one noise vocabulary, via height-gradient profiles and a
  weather channel that varies per location. This is the closest existing precedent to §3.4,
  and the reason a shared type map can support several cloud shapes.
- [Convincing Cloud Rendering: An Implementation of Real-Time Dynamic Volumetric Clouds in
  Frostbite](https://odr.chalmers.se/items/53d0fe07-df09-4cd1-ae7d-6c05491b52bf)
  — the practical write-up of the above, including how cloud types are selected per region.
- [Physically Based Sky, Cloud and Atmosphere Lighting (Frostbite, EGSR 2015),
  paper PDF](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf)
  — energy-conserving analytical scattering integration and transmittance-weighted cloud
  depth. Already cited at `src/march/primaryMarch.ts:168`; the reason §3.5 says an in-march
  cirrus shell gets its aerial perspective for free. The EA news post for this paper is gone
  from `ea.com/frostbite/news`, which is why the PDF is linked directly.
- Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*,
  EGSR 2020, [PDF](https://sebh.github.io/publications/egsr2020.pdf), DOI
  [10.1111/cgf.14050](https://doi.org/10.1111/cgf.14050) — the multiple-scattering LUT this
  port already uses. Background; not a variety input.
- [Physically Based and Scalable Atmospheres in Unreal Engine](https://blog.selfshadow.com/publications/s2020-shading-course/hillaire/s2020_pbs_hillaire_slides.pdf)
  — the same model as course slides, including the analytic multiple-scattering
  approximation. Background.
