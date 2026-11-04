# Experimental rendering options

Opt-in renderer experiments hang off `CloudsContext.experimental`, and the
table below is the whole list. Fourteen of them are `false` in a fresh context
and two, `cloudFrontRefinement` and `distantShapeDetailFade`, now ship `true`;
none of them changes a parity threshold, and none of them is on the path the
committed metrics were captured with. They exist so a renderer question can be asked against the real pass
rather than argued from the source.

`cloudFrontRefinement` and `distantShapeDetailFade` are the two promoted
defaults, and they are still listed here rather than promoted into `WEBGPU.md`:
each remains a switch a consumer may turn off, and its cost and trade-offs need
the same page as the options it is compared against. Reference mode pins both
off, so the parity ladder still runs the original's choices (see
[Reference mode](#reference-mode)).

This file is the reference for each option: what it does, what it costs, and
what it gives up. `WEBGPU.md` keeps the short version and the Storybook
comparison; the generated API reference carries the per-property JSDoc.

## Enabling them

Assign a partial object. Keys you leave out keep their current value, so this
is a patch, not a replacement:

```ts
const cloudsContext = cloudsPass.cloudsContext

cloudsContext.experimental = {
  cloudFrontRefinement: true,
  directionalSkylight: true
}
```

An unknown key or a non-boolean value throws a `TypeError` instead of being
ignored. Any real change to a value rebuilds the TSL graph and calls
`resetHistory()`, so do it at setup rather than per frame. Reading the property
gives a frozen copy of every value, which is convenient for a UI control
panel.

The options are independent. Nothing in this port requires two of them together,
and the combinations are not all interesting: `windReprojection` plus
`computeResolve` is the pairing the e2e suite exercises.

## Reference mode

`cloudFrontRefinement` and `distantShapeDetailFade` are off in the reference,
because the original has neither feature, and reference mode is what keeps that
true for consumers who want the original's behaviour rather than this port's
defaults. Applying it pins every experimental option to off, including the two
that now ship on:

```ts
import { applyReferenceMode } from 'three-clouds-webgpu'

applyReferenceMode(cloudsPass.cloudsContext) // every option off
```

`applyPortDefaults` is the way back out. It restores the library defaults,
including both promoted options, and leaves an option a caller set for itself
alone. The
reference values are written out in `src/referenceMode.ts` rather than read from
the defaults, so promoting a default can never carry the promotion into
reference mode and move the parity captures with it.

## Cloud shape options

Four small shape controls live on `clouds.cloudShape` rather than on
`experimental`, because they are magnitudes rather than switches: a coverage
boost is `0.3` or it is `0`, and there is nothing for a boolean to add. Every
one of them is neutral at zero, and zero is what a fresh context holds, so the
default render is the reference render.

```ts
cloudsContext.cloudShape = { baseShadowStrength: 1.4, horizonCoverageAmount: 0.2 }
```

Each magnitude is a **graph-time literal**, the same choice
`scatterAnisotropy1` makes (`CloudsContext.ts`): as uniforms the same
constants cost 5.7 ms against the reference's 0.4. So a change rebuilds the
march, which `checkCloudShape` arranges the same way `checkLayerStructure`
does, and `graphFlags()` carries the whole object so three cannot serve the old
program. In a panel, set the knobs at setup; dragging one rebuilds.

| Knob | Default | Cost | What you get |
| --- | --- | --- | --- |
| `baseShadowStrength` | `0` | One exponential per shaded sample | A cloud base reads darker than its top |
| `baseShadowHeight` | `0.3` | Part of the same term | The fraction of the layer the darkening spans |
| `horizonCoverageAmount` | `0` | One smoothstep and one add per marched step | Distant sky reads more overcast than the weather map alone gives it |
| `horizonCoverageStart` | `8000` | Part of the same term | Metres from the camera where the bank begins |
| `horizonCoverageRamp` | `40000` | Part of the same term | Metres over which it reaches the full amount |
| `windSkewEast` | `0` | Two cross products and a normalize per media sample | Cloud tops lean east |
| `windSkewNorth` | `0` | The same term | Cloud tops lean north |
| `erosionShape` | `0` | One add and one max per media sample | Rounded solid edges at negative values, thin wispy ones above 0 |

They are four separate settings with four separate costs, and any one of them
can be on alone.

### Darker cloud bases

#### What it does

`baseShadowStrength` multiplies the direct sun term of every shaded sample by
`exp(-strength * depth)`, where `depth` is how far the sample still has to
climb inside its layer, normalized over the bottom `baseShadowHeight` of it.
The top of a layer therefore passes the full sun and a base passes
`exp(-strength)`.

The sun march already attenuates the direct term, so what this adds is the part
that march misses: it runs on a truncated step budget
(`maxIterationCountToSun`, and a fudge factor of 0.5 when that count reaches
zero), which is why a thick base can come out flat rather than dark. This is
the analytic remainder, one exponential per sample instead of more marching.

#### Cost

One `exp`, one divide and two clamps per shaded sample, so per occupied march
step rather than per step. No extra texture reads and no extra marches. On the
p0 gate the delta is inside the frame-to-frame noise floor.

#### Trade-offs

- It darkens the base of **every** layer by the same curve, because the four
  lanes' height fractions are collapsed with their density weights. A per-lane
  strength is not implemented.
- It only touches the direct term. The ambient sky term already carries a
  height gradient (`primaryMarch.ts`), so a base keeps its ambient fill and the
  contrast is a ratio rather than a black base.
- A negative `baseShadowStrength` has no meaning and does not open the seam, so
  a scene cannot brighten a base with it.

### Horizon coverage bank

#### What it does

Every marched step adds `horizonCoverageAmount * smoothstep(start,
start + ramp, rayDistance)` to the weather density of all four lanes. Nothing
happens inside `horizonCoverageStart` metres, the full amount arrives at
`start + ramp`, and it stays there.

Two things fall out of adding it to the weather density rather than to the
media density. Distant steps cross the `minDensity` threshold they used to
miss, so more of the far sky is marched rather than skipped; and the added
density is subject to the same `coverage` remap, so it thickens cloud rather
than painting an overlay.

A negative amount thins the distance instead, which is the other half of what
distant skies do and is not a special case in the code.

#### Cost

One smoothstep and one `vec4` add per marched step, and a longer occupied run
toward the horizon, which is where the march already spends most of its steps.
Measured on the p0 gate: inside the noise floor.

#### Trade-offs

- It is a **view** effect, so it is only in the primary march. The sun march and
  the cloud shadow map keep the plain weather sample, which is right for both:
  neither has a view distance, and a shadow should not know what the camera is
  looking at.
- It is distance, not elevation, so a camera looking down sees the same bank as
  one looking at the horizon. That is the cheaper half of the effect and the
  honest one: a ray toward the horizon is the long slant path through the
  layer, and that is the geometry the term stands in for.
- The bank is global, so it cannot make one region overcast and leave the next
  clear.
- The addition lands after `sampleWeather` has zeroed the dead lanes, so the
  seam masks them itself. Without that an inactive lane would read as occupied,
  the media sample would come back with every lane at zero, and the step would
  integrate for nothing: wasted steps and a defeated empty-space skip, which
  reads as "the feature is off" rather than as a defect.

### Wind shear

#### What it does

The shape lookup for every lane is displaced horizontally before it is read,
by `windSkewEast` and `windSkewNorth` metres at the top of the layer and zero
at its base. The two numbers are metres along the local east and north, so the
lean is the same compass direction everywhere on the globe.

Height for the displacement is the density-weighted mean of the four lanes'
height fractions, because the shape lookup takes one position for all four
lanes. A lane that owns most of the density at that step is the one that sets
the height.

#### Cost

Two cross products, a length, a divide and a smoothstep per media sample, which
is per occupied step in all four marches (primary, sun, shadow map, front
refinement). No extra texture reads: it moves the coordinate of a sample that
was going to happen anyway.

#### Trade-offs

- At a pole the local east axis is undefined, so the lean fades out over the
  last 0.01 of `length(cross(up, normal))` rather than handing the shape lookup a
  NaN. A polar scene gets no lean.
- The lean displaces the **shape** lookup only. The weather map, the density
  profile and the detail volume stay where they are, so a sheared cloud is a
  sheared silhouette over an un-sheared coverage field. Shearing the weather
  uv as well would move the cloud's coverage footprint, which is a different
  feature.
- Metres, not a fraction of the layer, so a 260 m lean is 260 m whether the
  layer is 700 m or 12 km tall. A fraction would read differently across the
  presets.

### Edge shape

#### What it does

`erosionShape` scales the per-lane shape amount by `1 + erosionShape`, which is
the factor the `remapClamp` against the shape volume uses to carve an edge.
Zero is the reference. Above zero it carves harder, so edges go thin and wispy;
below zero it carves less, so they stay rounded and solid.

It reads the cloud-type morph's blended amount when `cloudTypeMap` is on, so a
type region and an edge control compose rather than overwrite.

#### Cost

One add and one `max` per media sample. Nothing else in the graph moves.

#### Trade-offs

- It scales `shapeAmount`, which is a carve, not a threshold. It cannot make an
  edge crisper, only thicker or thinner.
- Past `-1` the scale would go negative and turn the carve into an addition, so
  it clamps at zero: `-2` is no carving at all, the same as a layer with
  `shapeAmount` 0.
- Per context, not per layer. Four layers with four edge characters would need
  four amounts, which is a `vec4` on the existing layer uniforms and is not
  implemented.

## Options at a glance

| Option | Default | Cost | What you get |
| --- | --- | --- | --- |
| `cloudFrontRefinement` | `true` | Up to 4 extra density samples per cloud front | Cloud edges land on the real boundary instead of the last step that missed it |
| `computeResolve` | `false` | A compute pass in place of the resolve fragment pass, plus workgroup memory | Neighbour reads become shared-memory reads |
| `windReprojection` | `false` | One vector add and one matrix multiply per marched pixel | Cloud velocity includes the wind, so moving clouds reproject correctly |
| `distantCloudShadows` | `false` | One shadow-map sample where the sun march takes zero steps | Distant cloud shadows instead of a constant optical-depth fallback |
| `directionalSkylight` | `false` | Two indirect-luminance samples per fragment | Ambient sky light varies with direction instead of being isotropic |
| `convectiveProfile` | `false` | One 2D Perlin and one per-lane Gaussian exponential per marched step | Layer density gains a concave shoulder near its top, so a tall layer grows an anvil, and coverage concentrates into isolated columns |
| `distantShapeDetailFade` | `true` | One extra remap and two mixes per detail sample, the same frame time as the earlier fade | Distant clouds near the horizon lose part of their bright per-pixel speckle and keep the original's optical depth |
| `cloudTypeMap` | `false` | One extra texture sample per march step, plus eight blended `vec4` reads | Cloud shape parameters vary per location, so one sky holds more than one type |
| `proceduralWeather` | `false` | One 512² compute pass to fill the map, then nothing per frame | A seeded weather map in place of the baked PNG, so a scene needs no baked texture |
| `evolvingWeather` | `false` | Two extra texture samples per weather sample, plus about 20 ALU | The weather map drifts on a swirling wind and cells grow and dissipate, for as long as the clock runs |
| `rainShafts` | `false` | Four closed-march steps per fragment, one Perlin each, and one atmosphere read | Grey precipitation curtains hang under the cells that made them |
| `moonlight` | `false` | One mix, one normalize and one vec3 add per in-cloud sample, no extra light | Once the sun is 6 degrees down, the march's one light is the moon's, at the moon's phase |
| `lightning` | `false` | A 6-step secondary march per shaded step while a flash is lit, and a uniform branch while it is not | Brief flashes light a cloud from within, occluded by the cloud between them |
| `cloudEnvironment` | `false` | Six cube-face marches of `size` squared by 32 steps, every fourth frame | Reflections and IBL carry clouds, not just sky |
| `staticMode` | `false` | A CPU input snapshot check each frame | Skips cloud march, shadow pass and resolve once inputs are unchanged and every temporal history is within 0.1 % of converged |
| `cirrusDeck` | `false` | One texture read, two ray-sphere tests and one atmosphere irradiance and transfer read per march fragment | A thin streaky cirrus sheet at 10 km behind the volumetric clouds, lit by the sun through the atmosphere |
| `shadowRoundRobin` | `false` | None: it removes work, a per-update CPU check and one layer copy per reused cascade | Each shadow update marches one cascade instead of all of them, cutting the shadow march by up to the cascade count |

## `cloudFrontRefinement`

### What it does

The march steps along a ray and stops when a step turns from empty to dense.
Without refinement the first integration position is the end of that step, so
the front sits up to one full step behind where the cloud actually begins, and
the error grows with step size.

With the option on, an empty-to-dense bracket is bisected four times. Each
bisection probes the real extinction at the midpoint, so the returned distance
is the first dense sample rather than the step boundary. The dense endpoint is
kept, never the empty one: returning the empty side would let the next long skip
jump straight across the boundary that was just located.

### Cost

Up to four extra weather and media samples per occupied run, which is the same
cost as four march steps. It fires once per cloud front, not once per march
step, because the refined position is occupied and the next step does not form a
new bracket. A ray that crosses many thin layers pays for each crossing.

Under the `sampleCount` and `marchIntervals` debug views the refinement
probes are counted, so the cost is visible in that view rather than only in a
frame time.

### Trade-offs

- The integration positions move, so any picture captured with this on is not
  comparable with the committed metrics. It is the DEFAULT now, and the parity
  harness still does not see it: reference mode pins it off, so every committed
  capture ran with it off.
- Cost is inside the noise: the measurement that promoted it put every frame-time
  delta within the inert-control noise floor, at most 0.6% of a 15 ms frame.
- It buys edge accuracy, not smoothness: the interior of a cloud is unchanged,
  and a low `clouds.maxIterationCount` still shows banding because the step
  count, not the boundary location, is what limits it.
- Cost scales with the number of layer crossings, so a four-layer scene pays up
  to four times per ray.

## `computeResolve`

### What it does

The temporal resolve reads a 3x3 neighbourhood of the current frame to build the
moment statistics variance clipping needs. As a fragment pass that is nine
independent texture fetches per pixel. The compute path moves the neighbourhood
into workgroup shared memory: an 8x8 workgroup loads a tile once, barriers, then
each lane reads its nine neighbours from shared memory. The same kernel handles
cloud colour, shaft length, and the shadow-map resolve, one workgroup tile per
cascade for the last.

Both resolve modes are supported. Full-resolution TAA uses an 8x8 lane tile with
a one-texel halo; Bayer upscale reads a 2x2 stride with a three-texel halo,
which is what absorbs the bilinear footprint and the odd-resolution upscale
drift into the clipping bounds.

### Cost

A compute dispatch instead of a fragment pass, plus the shared-memory tile and
the barrier. Each dispatch covers 8x8 lanes of the resolve target, and a kernel
is built for each of the resolve and history targets so the swap always has one
ready. The shadow resolve switches with it, which changes its targets from
render targets to storage textures.

This is a performance experiment, not a visual change. Small floating-point
differences remain, because a shared-memory read is filtered over the same
footprint as the fragment read but accumulated in a different order.

### Trade-offs

- The shadow resolve writes its array layer with `textureStore()` on a layered
  storage node, the form three 0.184 reads. It emits the same WGSL on 0.185, so
  the option works on both peers with no fallback and no feature gate.
- With any debug view on, the colour path keeps the fragment resolve, so
  `debug` and `computeResolve` are mutually exclusive in practice rather than in
  name.
- Changing this flag reallocates the resolve and history targets and re-arms
  their histories.
- Measured GPU timings are device- and workload-specific. The e2e test reports
  render plus compute timestamps in an ABBA order, which is the shape of the
  comparison and not a speedup claim.

## `windReprojection`

### What it does

The resolve reprojects each pixel back through the previous frame's matrices.
That is only correct if the cloud stayed put. With a constant sky the wind moves
the cloud, so the reprojection reads a neighbouring pixel of a different part of
the cloud and variance clipping throws away valid history, which shows as a
cloud that never fully converges.

The option adds the shape-texture motion to the velocity term, so the history
fetch lands where that same parcel of cloud was. The displacement is
`(offsetToday - offsetYesterday) / shapeRepeat`, divided by the repeat because
the offset is applied to a scaled coordinate.

### Cost

One vector add and one 4x4 matrix multiply per marched pixel, once, not per
march step. On the CPU, a `WindHistory` compares and copies a handful of vectors
per frame.

### Trade-offs

History is rejected, and the frame falls back to the unaccumulated march,
whenever any of these hold:

- The detail texture moves differently from the shape texture. Compatible detail
  motion is required, and `shapeDetailAmount = 0` makes it free.
- A shape or detail repeat changes, or the weather repeat changes.
- `shapeRepeat` holds a zero or a non-finite component.
- The world-to-ECEF matrix changes.
- `time` moves backwards, or a step exceeds 0.5 seconds.

Shaft history is rejected whenever the clouds move at all, because the shafts'
motion is not the clouds' motion. This option does not advect the shadow atlas
history.

The displacement is added to a world position before the fp32 matrix multiply,
and on a globe frame that position is about 6.4e6 m from the origin, where one
fp32 ulp is about 0.5 m. At the default shape velocity the per-frame step is
therefore under one ulp and rounds to a fraction of it. Measured on the 3D Tiles
stories, that costs no visible accuracy: with shape advection on, the frame to
frame difference with the option is 0.62 % of full scale against 0.58 % without
it, and the same 0.59 % on the origin-rebasing story where the same displacement
is six orders of magnitude above one ulp. If that ever did show, the fix is to
build the reprojected position camera-relative rather than to clamp the step.

## `distantCloudShadows`

### What it does

The sun march has an iteration budget that falls to zero at high mip levels,
which is where distant samples live. With no steps available, the reference
falls back to a constant optical depth, so every distant cloud either shadows
the ground fully or not at all.

At the default settings the option is inert: it only acts on density beyond
roughly 87-100 km, and only on samples where the sun march takes zero steps.

With the option on, a sample that would take zero sun steps instead reads a
covered estimate out of the shadow map. A covered value replaces the whole
segment, not just the constant. A coverage of `-1` means the sample is outside
the map and preserves the original local-plus-coarse sum, so the option is
inert exactly where it has no data. A covered value of `0` is a valid depth of
zero, which is deliberately distinct from missing coverage.

### Cost

One shadow-map sample in place of a constant, on the samples that take zero sun
steps. Near samples run the march as usual and pay nothing. The extra work is
bounded by the distant fraction of the frame, which
`clouds.maxIterationCountToSun` controls.

### Trade-offs

- At least one layer must cast shadows for this to have any effect at all.
  With no caster the shadow map is empty and every covered read is zero
  optical depth, which is brighter, not darker.
- Outside map coverage the original fallback is preserved, so the option only
  shows up where a cascade covers the sample. A camera outside the cascade
  system sees no change, which is not a bug in the option.
- The Storybook comparison for this option sets
  `clouds.maxIterationCountToSun = 0` in both arms to isolate the fallback,
  because otherwise the sun march masks it.

## `directionalSkylight`

Stays opt-in because its effect is too small to see at default settings. It
builds and renders on hardware with no console errors, but the e2e scenario in
`examples/parity/e2e/experimentalVisibility.spec.ts` measures it at about 1.3
times its own off-vs-off noise, inside the bracket the other options clear by
66 to 558 times. That row asserts the option stays inside its bracket, so it
fails, and says to promote the option, on the day the effect becomes visible.
An earlier version of this page said `composite()` throws with it on. That came
from a CPU test stub that builds the graph without a builder context, not from
a real renderer.

### What it does

Ambient sky light on a cloud sample is directionless in the reference: the
factor is a constant. Two sky samples along the horizon, one toward the sun's
tangent and one away from it, drive a normalised angular term instead, so a
cloud facing the bright horizon is brighter than one facing away.

The kernel is a positive degree-2 zonal polynomial, and the normalisation
divides by the same weights applied to the sum of the two samples, so an
isotropic sky reproduces the constant exactly.

### Cost

Two `getIndirectIlluminance` samples per fragment, carried across the pass as
varyings. They use the same atmosphere LUTs the baseline lighting already needs,
so this adds no new data dependency.

### Trade-offs

- Two samples cannot recover an arbitrary nine-coefficient spherical harmonic.
  This is a constrained two-lobe approximation, not a reconstruction, and not a
  physically complete multiple-scattering model.
- An isotropic or black sky stays neutral by construction. The `1e-6` in the
  ratio is what keeps a black channel from producing a zero-over-zero or colour
  speckle.
- The factor is clamped to a quarter through four, so a horizon far brighter
  than the anti-horizon saturates rather than growing without bound.

## `convectiveProfile`

### What it does

Two terms, in the two places that own them.

The vertical shape law gains a concave shoulder. The shipped profile
`A*e^(B*h) + C*h + D` is convex on `[0,1]` for `A >= 0`, so it has an interior
maximum only if it is constant: it can produce a flat-topped deck, which is
what stratocumulus needs, but it can never rise and then flatten, which is what
an anvil is. This option replaces `getLayerDensity` with a new function that
computes the same four terms and multiplies them by `1 + shoulder`, where the
shoulder is a Gaussian in the layer's own height fraction. At
`anvilStrength = 0` it reproduces `getLayerDensity` exactly.

The shoulder only reaches layers over 4 km, read from the packed
`maxLayerHeights - minLayerHeights` as a per-lane uniform. That is deliberate:
`CloudLayer.height` is a plain field with no owner to notify, so a graph-time
read of it would need a poll and would go stale, whereas the packed bounds are
already uniform magnitudes updated every frame. A layer can be dragged from
700 m to 12 km with no rebuild, and the two thin decks beside a tower keep the
shipped profile.

Coverage gains concentration. One octave of 2D Perlin on the globe uv is
thresholded into isolated blobs. Outside a cell the coverage threshold goes to
1, which admits nothing the weather map holds, so the location erases every
lane at once; inside a cell the threshold drops by `cellDensity`, which is what
makes a cell a solid column rather than a wisp. That drop carries the lane's own
height weight, the same one the coverage term already has, so a cell multiplies
the coverage the lane already had by `1 + cellDensity / coverage` and adds
nothing at the two heights where that weight is zero. The mask is 2D on purpose,
so a cell runs the full depth of the layer rather than forming a layer of its
own.

The mask is a falloff, not a step, and that is worth stating because it is not
what the artefacts turned out to be. `cellSoftness` is a band in noise value, and
at the shipped defaults it gives a 10-90 transition of about 6 km on a 50 km
lattice cell, so the coverage multiplier never climbs faster than about one part
in twenty of a cell.

### Cost

Per marched step: one 2D Perlin (four gradient hashes and a bilerp) and one
Gaussian per lane, both pure ALU. No texture fetch, so nothing here depends on
derivatives and the implicit-LOD rule that makes an in-loop texture read return
zeros on Dawn has nothing to attach to.

The step budget itself does not move: this option changes no march bound, no
`maxIterationCount`, and no shadow cascade. A tall layer costs more before the
option is switched on, because a 12 km band is occupied for longer than a
700 m one and the empty-space skip has less gap to skip. Separating the two is
the point of the three arms in the PR.

The seven knobs are uniforms, not compiled state, so tuning an anvil mid-drag
costs a uniform write and no rebuild.

### Trade-offs

- There is no WebGL counterpart for any of this. The reference has no anvil and
  no way to reach one from its existing knobs, so this is new capability rather
  than a port, and the parity ladder does not cover it.
- With `cloudTypeMap` also on, the morph runs first: its per-lane deltas blend
  the four `densityProfile` terms, and this law then consumes the blended terms.
  That order is the only one both options can honour, since a per-term additive
  delta has nothing left to apply once the law has summed the terms, and it used
  to be the other way round, which silently dropped four of the morph's eight
  parameters. `convectiveCloudTypeComposition.test.ts` counts the deltas that
  reach the compiled march, so a repeat cannot pass unnoticed.
- The shoulder is multiplicative, so it scales the layer's own profile rather
  than adding to it. A layer whose profile is already zero at its top still has
  nothing there to scale, and the anvil shows as a brightening rather than a
  lid.
- The anvil reads fainter than the description above suggests. Measured on
  hardware at the shipped defaults, `anvilStrength` 0 to 1.8 moved 1.8 percent
  of the frame by a mean of 0.55 of 255. The knob is wired and live; the effect
  is small.
  The likely reason is the `saturate()` at the end of the density in
  `sampleShape.ts`: where the lane is already near full density, a larger
  multiplier has nothing left to scale and is clipped away. The CPU twin
  reproduces the same saturate, so no unit test can see this. A taller or
  thinner lane, or a lower `densityScale`, should show more of the shoulder, and
  that was not explored.
- `cellDensity` is the stronger of the two, and the figure that used to sit here
  (92.7 percent of the frame by a mean of 13.6 of 255, for 0 to 0.8) was measured
  on the pre-fix fold and no longer applies. Re-measured on the current fold, on
  the same Storybook Convection pose at DPR 2, `cellDensity` 0 to 0.8 moves 40.8
  percent of the canvas by more than 1 of 255, by a mean of 4.7 of 255. The knob
  is weaker than it was because the fold now scales with the lane's height weight
  instead of adding to the threshold, so it gives up most of its boost at the two
  ends of a layer, which is where the floor it used to paint was.
- The cell mask is global, not per-lane. A tower standing in an otherwise
  overcast sky is not towering convection, and this option erases the decks
  along with the gaps. Narrowing it per lane is the type map's job.
- `A*exp(B*h)` is written out again inside the new evaluator, so the four-term
  family exists in two places. That is the cost of leaving `DensityProfile`'s
  packed uniform layout alone, which is what keeps every snapshot that hashes
  those vectors valid.
- Known artefacts. The flat box-shaped translucent slab and the frosty, speckled
  tower edges are fixed. Both came from the cell's threshold drop being additive
  and height-independent: `shapeAlteringFunction` is zero at both ends of a
  layer, so the shipped coverage term contributes nothing there, while
  `cellDensity` still dropped the threshold and painted a floor whose faces were
  the layer's own end planes. The fold now carries the lane's height weight, so a
  cell is a pure gain of `1 + cellDensity / coverage` on the coverage the lane
  already had, and paints nothing where the lane had nothing. Measured on the
  Storybook Convection pose at DPR 2, the mean absolute Laplacian over the canvas
  went from 117.0 (flag on) to 115.5, against 114.8 for the same pose with the
  flag off; inside a tower it went from 3.18 to 0.86 against 2.23.
- Two artefacts remain, both weaker than they were and neither a hard edge. The
  rim of a cell is still a narrow band, roughly 20 device pixels at DPR 2 on that
  pose, because it is set by the shape volume's own feature size (about 300 m at
  the shipped `shapeRepeat`) rather than by anything in this option: the density
  threshold varies over kilometres and the rim follows the level set of the shape
  noise across it. Raising `cellDensity` deepens the cut into that noise and
  brings some of it back, so a lower `cellDensity` and a larger `anvilWidth` both
  quiet it. And because the mask is 2D, a cell still erases the two thin decks
  along with the gaps, which the option has always done and which the trade-off
  above records.

## `rainShafts`

### What it does

Rain shafts are the grey curtains that hang under a storm cell and reach the
ground. Nothing in the port draws them: a cell is a coverage hole in the
weather map, so the sky under a tower is the same clear blue as the sky under a
gap.

The option adds one thin, low-albedo participating medium per cell, from the
cloud base down to the ground. Three decisions define it.

**It is placed by the cell mask `convectiveProfile` already thresholds**, not by
a field of its own. The shaft reads `cellsPerWeatherTile`, `cellThreshold` and
`cellSoftness` off `ctx.convectiveProfile`, so a shaft hangs under the tower
that made it and the two cannot drift apart. The mask term is the same smoothstep
over the same Perlin the coverage uses; the shafts add a ragged multiplier taken
from that same noise value, which is why the ragged edge costs no second sample.
With `convectiveProfile` off the shafts still work, because they read the
parameters rather than the option. In that mode they form independent rain
cells; they do not follow the clouds of a fair-weather preset. Enable both
options to use the same cell mask for convection and rain.

**It is marched in its own closed segment, not in the primary march.** For a
camera below the deck, `getRayNearFar` starts the primary march *at* the base
crossing (`second.y`, `src/march/intersections.ts:130`), so the band a shaft
hangs in is never a marched sample, and the interval skip would empty it anyway.
The segment stops at the first ground-sphere intersection, even in a sky-only
scene with no geometry depth. Scene depth and the maximum ray distance can
shorten it further. Density is zero below ground and above the cloud base.
Four fixed steps over this bounded segment is the cheap option the design allows: against up to 500
primary steps with three texture samples each, this is four steps of pure ALU.
An empty segment marches four zero-length steps and integrates to a
transmittance of 1, so no branch is needed to reject the pixels that have no
shaft in them.

**It is lit by the irradiance the cloud march uses, through the marched shadow
length.** The direct term is multiplied by `exp(-0.01 * shadowLength)`, where
`shadowLength` is the cloud path the light-shaft march already measured along
the sun ray for this pixel, so a shaft under a storm cell is dark and one under
a thin edge is not. The scene behind the curtain is attenuated by the same
transmittance: alpha is opacity, so it becomes `1 - (1 - a) * transmittance`.

Three knobs, all uniforms: `strength` scales both the extinction and the
in-scatter, `density` is the extinction per metre at full strength inside a
cell, and `slant` is the horizontal lean from the base to the ground in cell
widths. The shipped `density` of `1.5e-4` is an optical depth of 0.3 over a
2 km column, which reads as a curtain rather than as fog.

### Cost

Four steps per fragment, each one 2D Perlin and a smoothstep, plus one
atmosphere irradiance read for the whole ray and the shadow-length multiply.
No texture fetch, so nothing here depends on derivatives and the implicit-LOD
rule that makes an in-loop texture read return zeros on Dawn has nothing to
attach to.

The cost does not scale with the primary march's step budget, and it does not
change any march bound, `maxIterationCount` or shadow cascade. It is the same
four steps on every pixel, whether or not that pixel has a shaft in it, which is
the price of not branching: a frame where no cell is overhead pays for four
noise evaluations per pixel anyway.

The three knobs are uniforms, so tuning a shaft mid-drag costs a uniform write
and no rebuild.

### Trade-offs

- There is no WebGL counterpart. The original has no precipitation, so nothing
  here can be checked against it and the parity ladder is unaffected: reference
  mode pins the option off and the committed captures all ran with it off.
- The sun transmittance is borrowed from the light-shaft march, so with
  `clouds.lightShafts` off there is no shadow length and the shafts stay lit
  under the deck. Turning that option on is what makes the "darkens under the
  cloud" half of this work.
- The lean direction is a constant in the mask's uv space, not the wind vector.
  `getGlobeUv` is scale invariant, so no offset of the sample position can lean
  a 2D field; a radial offset would have no effect at all. Tying the lean to
  `ctx.shapeVelocity` is the obvious next step and is not done.
- The shafts composite after the aerial perspective and before the haze. The
  first is because that perspective is measured to the cloud front and would
  over-haze a shaft in front of it; the second because haze is along the whole
  ray and belongs on top. A shaft therefore picks up the haze and not the cloud
  front's atmosphere.
- It is a veil, not a mask. Measured over `sky-horizon-low-sun` on hardware it
  changes 25% of the frame and darkens 39k of the 231k samples it changes,
  lifting the rest: a shaft in front of a cloud or a bright sky dims it, and a
  shaft in front of dark ground lifts it. That is what a participating medium
  does, and the e2e asserts that it dims something rather than that it only
  dims. The single-scattering albedo is 0.12, chosen because the first value
  tried, 0.3, in-scattered more light than it removed over the whole frame and
  read as haze rather than as rain.
- Four fixed steps over the whole band undersample a near-horizontal ray, whose
  segment can run tens of kilometres, so a distant shaft is smoother than a
  near one. The density field varies over kilometres, which is why four is
  enough to place the ragged edge rather than to resolve it.
- The band's top is the lowest layer's altitude, so a scene whose deck sits at
  8 km hangs its shafts from 8 km. A shaft is not tied to the cell that made it
  in height, only in position.
- Debug views are untouched: the shafts composite after the front-depth view's
  early return, so a debug view shows the cloud march alone.

## `distantShapeDetailFade`

### What it does

The reference applies the shape-detail volume through a per-pixel lottery: detail
is either sampled at full strength or skipped, chosen by the jitter and the
sample's mip level. The detail volume has no mip chain, so past roughly 40 km
along a level ray one pixel spans more of it than it has texels, and the "detail"
becomes aliasing that shows up as sparse bright speckle on distant clouds near
the horizon.

With this option on, the detail fades out with the mip level toward its
expected value instead of toward nothing. The expected value has two parts.
The first is the detail modifier's mean over the baked `shape_detail.bin`
(`DETAIL_MEAN` and `DETAIL_POW6_MEAN` in `sampleShape.ts`, which a test
recomputes from the asset). The second is the lottery's own hit rate,
`clamp(1.5 - mipLevel, 0, 1)`. Distant clouds therefore keep the optical depth
the original gives them, while the per-pixel detail they cannot resolve is
removed. With the option off, the reference's lottery is compiled verbatim.

Up to 2026-10-08 the fade went to zero instead of to the mean. That removed
about 40 % of the distant optical depth, because the detail roughly doubles
thin density rather than eroding it, and it made distant clouds about 1.35x
brighter than the original, measured with a linear pixel probe of Minimal Setup.
The mean-preserving fade measures 1.008x of the WebGL original at the same
pixel, the same as the reference lottery.

The defaults are on, promoted 2026-10-02. Set the option to `false` for the
reference's lottery, or apply reference mode to pin every option off at once.

### Cost

One extra remap and two blends per detail sample. Measured frame times are
vsync-quantised and sat with the earlier fade's, within noise. That bounds
the difference rather than proving it zero.

### Trade-offs

- It removes less speckle than the earlier fade did, because part of that
  fade's reduction came from thinning the clouds. The top-hat speckle metric
  (spk>=8, 0-4 degree band, four horizon views) gives these figures:

  | view | reference lottery | fade to zero (before) | fade to mean (now) |
  | --- | ---: | ---: | ---: |
  | level | 3.09 % | 1.90 % | 2.75 % |
  | grazing | 11.31 % | 2.73 % | 6.65 % |
  | side-lit | 3.03 % | 1.88 % | 2.65 % |
  | low sun | 5.89 % | 2.81 % | 5.16 % |

- The mean statistics belong to the baked detail volume. A consumer who
  replaces `shapeDetailTexture` with a volume of a different distribution gets
  a slightly wrong far-field mean.
- A second source of distant speckle, the sun-march step count chosen per
  pixel, is not addressed here.
- The fade's knee was tuned at the four measured views.

## `cloudTypeMap`

### What it does

One low-resolution texture holds a cumuliform weight per location, and the
density samplers morph eight of their per-lane parameters along it:
`shapeAmount`, `shapeDetailAmount`, `shapeAlteringBias`, `densityScale` and the
four `densityProfile` terms. Three vocabularies sit on that axis, at 0
(stratiform), 0.5 (stratocumuliform) and 1 (cumuliform), and the morph samples
them with three tent weights that sum to one, so the blend is a convex
combination and each region reads as one cloud genus rather than a haze of
several.

The texture rides the local weather channel's own uv transform, so a type
region and a weather system share a scale with no second tiling knob. The map is
the shared extension point: every other cloud-type option blends against the
same scalar. The [flag-off crop](experimental/cloudTypeMap/above-off.webp) and
[flag-on crop](experimental/cloudTypeMap/above-on.webp) show the same scene,
from the same pixels.

### Cost

**This option roughly triples the frame. An earlier version of this section
claimed 2 to 3 ms and was wrong by about an order of magnitude, because the
baseline it measured against was a clip rather than a measurement.**

The trap: with vsync on, a frame that finishes inside the 16.67 ms refresh
quantum reports the *quantum*, not its own cost. The first version of this table
read `16.70, 16.70 ms` for the flag-off arm in every pass, which looks like a
stable baseline and is not one. `16.70` prints identically whether the true cost
is 10 ms or 16 ms, so `on - off` against it is a lower bound and the delta is
understated. A baseline that reads exactly the refresh quantum is a clip, and the
delta against it is a lower bound.

Re-measured with the refresh cap lifted (`--disable-gpu-vsync
--disable-frame-rate-limit`), headed, two passes per arm, median of 170 rAF
deltas after 90 warm-up frames at 2874x1794:

| arm | median | fps | note |
| --- | --- | --- | --- |
| above the deck, flag on | 33.20, 33.20 ms | 29.8 | uncapped, a real measurement |
| horizon, flag on | 34.60, 34.60 ms | 28.2 | uncapped |
| above the deck, flag off | 16.30 ms | 61.2 | **still floored**: ~61 fps is the present interval, not the cost |
| horizon, flag off | 16.30 ms | 61.4 | **still floored** |

Lifting the flags was not enough on its own: the flag-off arm still reported
~61 fps, so the present interval was still binding. To get under it, the same
flag-off arm was measured at **4x the pixels** (2874x1794 CSS at DPR 2, 20.6
Mpx), where it cannot hide under a 16.3 ms floor:

| arm | pixels | median | fps |
| --- | --- | --- | --- |
| above the deck, flag off | 20.6 Mpx | 46.60, 46.70 ms | 21.5 |
| horizon, flag off | 20.6 Mpx | 44.20, 45.60 ms | 22.3 |

The frame is pixel-bound between 5.16 and 20.6 Mpx (46.6 ms is 4.0x the 1x
figure), so the true flag-off cost at 2874x1794 is **about 11.7 ms** and the
flag costs **about 21.5 ms**, roughly 2.8x the flag-off frame.

Two things to be honest about. The 11.7 ms baseline is derived from the 4x run
by dividing by the pixel ratio, which assumes the scaling stays linear down to
1x; the `on` arm was not also measured at 4x to confirm it scales the same way.
And without making that assumption at all, the floor-based bound still holds and
needs no inference: the flag-on arm really does take 33.2 ms and the flag-off arm
is at most 16.3 ms, so **the flag costs at least 16.9 ms**. Read that as the
floor and 21.5 ms as the estimate.

Most of this is the two extra samples rather than the blends. The baseline is
heavier than when the option was written, because `distantShapeDetailFade` and
`cloudFrontRefinement` both now ship on, so the same two samples are a larger
share of a larger frame.

An even earlier measurement of this option found no cost at all: every arm
landed between 16.60 and 16.80 ms. That was a clip too, and it stayed a clip
after `distantShapeDetailFade` started shipping, because the baseline was still
under the quantum. Two extra level-0 samples per step out of a march that
already takes hundreds sounds negligible, and mostly is, until the frame is close
enough to the budget for "negligible" to show up.

### Trade-offs

- Two samples per step rather than one. Sharing one sample between the two
  samplers needs a new argument threaded through every march that samples
  density, which is a shared-file edit several options in flight also want.
- It does not fit in a 60 Hz frame at 2874x1794 by a wide margin: 33.2 ms
  against an 11.7 ms baseline, so about 28 fps. At a smaller canvas, or with
  fewer march steps, it should fit; that was not measured.
- The vocabulary axis is stratiform to cumuliform only. Cirrus is a different
  axis, not a point on this one, so it belongs with the cirrus work.
- Nothing happens until `context.cloudTypes.setMap()` is called, so flipping the
  flag alone renders the base look. That is deliberate: two opt-ins, the flag
  for the code path and the map for the look.
- The values are tuned by eye against the reference's defaults. There is no
  measured source for them, because the reference has no equivalent.
- Region boundaries are smooth by construction, never hard. The morph is a
  convex blend through a `saturate`d tent over a smoothly rank-equalised field,
  and the middle anchor exists so a boundary reads as a third genus rather than
  a step. That is safe, and it also means the option cannot draw a crisp genus
  edge for anyone who wants one.
- On a map with many small regions the frame reads as a smoother, hazier deck
  rather than as several types, because a view holds several regions inside one
  blend. Large regions show the effect; small ones average it away. The map
  rides the weather channel's repeat, so region size is set by
  `localWeatherRepeat` and the map's own cell count, and there is no separate
  knob.

## `proceduralWeather`

### What it does

It replaces the *contents* of the weather map, not the way the march reads it.
`CloudsContext.localWeatherTexture` is handed a `ProceduralWeather`, a
`ProceduralTexture2D` whose compute pass writes the three coverage channels from
a seed rather than reading the baked PNG. The march's own shader is untouched,
which is why the compiled WGSL of the default generator and of the march's
consumer are both unchanged when the flag is off.

A weather texture the caller assigned always wins. With the flag on and
`localWeatherTexture` already set (to the baked PNG, for example), the flag
installs nothing and the frame is unchanged. Clear `localWeatherTexture`, or
never assign it, for the generated map to take effect.

The generator is a re-seeded, parameterised reading of the reference's own
`localWeather` (localWeather.frag:12–83): an fbm of `1 - Worley` per channel,
domain-warped by value noise, with the low channel subtracting the mid one so the
two cannot stack into a solid deck. Three patterns are available per channel —
`clumps`, `bands` and `scattered` — and each gets its own threshold window,
because each field has its own range. A `gap` parameter clears contiguous regions
using a large-scale field rather than cell-sized holes.

Every parameter except the patterns and the octave counts is a uniform, so
changing one costs one refill dispatch and no graph rebuild. Patterns and octaves
unroll at graph time, so changing those means building your own generator and
assigning it yourself.

### Cost

**Unmeasured.** No frame-time or GPU-time figure has been taken for this option
on real hardware; treat the cost as unknown rather than as zero. What can be said
from the source is that the per-frame cost is unchanged: the map is a texture
either way, the march reads the same number of texels from it, and no march
bound, iteration count or shadow cascade moves. The one-time cost is a single
512² compute dispatch to fill the map, plus the memory for that texture. The
generator's own shader is substantially heavier than the baked map's — a 3x3x3
Worley neighbourhood per octave, four octaves per channel, three channels — but
it runs once per fill rather than per frame.

### Trade-offs

- Not a port. The reference has no seed, no patterns and no gap mask; this is new
  capability, so the parity ladder does not cover it and there is nothing to
  match against.
- The hash is the reference's `fract(sin(n) * 43758.5453)`, kept bit-for-bit
  because the baked textures were produced with it. It is a weak hash, and its
  precision degrades for large `n`, so a large `seed` is a less reliable way to
  get a distinct map than a small one. Measured coverage stays sane well past
  seed 10000, but the field was not audited for collisions across seeds.
- The map is generated once and then reused; it does not evolve with `time` the
  way a scrolled-and-offset weather map does. Animation comes from
  `localWeatherVelocity` advecting the finished map, not from the map changing.
- `bands` should be a multiple of 4 for the band's 0.75/1.5 stretch to land on
  the lattice. Nothing enforces it. Measured tiling error is zero for the values
  tried, so the constraint is conservative rather than load-bearing.
- The generator is exposed (`createProceduralWeather`, `ProceduralWeather`) so a
  caller can build a map and assign it directly, bypassing the flag. The flag is
  only the zero-configuration path.

## When an option cannot do its job

Three of these can be enabled and still do nothing, because a precondition they
depend on is not met. Each one now warns through the `warnings` channel
(`clouds.warnings`, on by default) — the same channel the stale-frame warning
uses — so the situation is reported rather than discovered later as "why does
turning this on change nothing". Each warning is emitted once per problem, and
is re-armed if the problem clears and comes back. Set `clouds.warnings = false`
to silence them.

These are documented limitations rather than defects. The port cannot make any
of them work without changing what the option means, which would make it a
different option.

### `windReprojection` with a non-zero `clouds.localWeatherVelocity`

The trade-offs above do not list this one, and it is the most likely to be hit
by accident. The option reprojects SHAPE-texture motion. Weather motion is a
different thing: the weather map is sampled at `globeUv × localWeatherRepeat +
localWeatherOffset`, so a weather step is a translation of a 2D map, not a
displacement of the marched position, and there is no world-space vector that
undoes it. The option therefore has nothing to compensate when
`localWeatherVelocity` is non-zero, and its displacement stays zero — which is
exactly what the option-off path computes, so the frame renders identically.
Set `localWeatherVelocity` to zero and animate `shapeVelocity` for the option to
do anything.

The history is deliberately NOT rejected in this case. It used to be, because the
weather offset was one of the domain terms compared with `equals()`, and that
comparison advances on every frame that `time` advances. A rejected history
skips the whole temporal resolve, so the march's per-frame jitter was never
averaged and animated weather boiled with blocky stair-stepped edges — a worse
image than the option off, from an option that claims to improve motion. Since
the displacement ignores the weather offset, that comparison could only ever
switch the history off; it never made a fetch more correct.

### `distantCloudShadows` with no shadow-casting layer

The trade-offs section above records that at least one layer must cast shadows.
The two default layers do (`shadow: true`), so the default sky is fine. Turn
`shadow` off on all four and the warning names the missing caster.

Coverage outside the shadow map is a property of the march rather than something
knowable up front, so that case is still not warned about.

### `computeResolve` under a debug view

The debug views read intermediate state the compute path does not write, so the
compute resolve is skipped whenever one is active. With a debug view on, the
option reads as enabled and is inert. Set `clouds.debug = 'none'`.

## Options that are not here

Every option in `src/experimental/options.ts` has a section above. A proposed
option that is rejected never gets a flag, and the table above does not grow
with it. The four knobs in [Cloud shape options](#cloud-shape-options) are not
options in that sense: they have no key in `experimentalDefaults`, which is why
neither the table above nor that list mentions them.

## Verifying on hardware

Nothing in this repository's unit tests can measure any of these. The GPU
evidence is the e2e suite, which is deliberately not part of CI because it needs
a real GPU:

```bash
pnpm build
export PARITY_GPU=hardware
pnpm e2e --grep 'experimental options|compute agrees'
pnpm e2e --grep 'wind reprojection follows|GPU timing includes'
pnpm e2e --grep 'every opt-in visual option'
pnpm e2e --grep 'flash|rain shafts|static mode|cirrus deck'
```

The third line measures every visual option against its own off-versus-off
noise bracket. The fourth runs the specs the newer options carry for their
visible effect and their cost.

The stories give a side-by-side view instead. See the Storybook section in
`WEBGPU.md`.

## `evolvingWeather`

### Using it

```ts
const cloudsPass = clouds({ sceneDepth })
const ctx = cloudsPass.cloudsContext

// Once: builds the graph with the evolution in it
ctx.experimental = { evolvingWeather: true }

// Any time, no rebuild. These are the defaults
ctx.evolvingWeather.windSpeed = 20 // m/s, peak of the swirling wind
ctx.evolvingWeather.windPatternSize = 500_000 // m, the wind pattern repeats
ctx.evolvingWeather.cellLifetime = 600 // s for a cell to grow and fade
ctx.evolvingWeather.lifeStrength = 0.4 // how far a cell swells, 0 to 1

// Every frame. The library reads no clock (ADR-003)
ctx.time = elapsedSeconds
```

The evolution is a pure function of `ctx.time`, so the clock's speed is the
speed control: `ctx.time = elapsedSeconds * 10` runs the weather ten times
faster, and assigning any time seeks to the frame that time gives. Net
transport of the whole sky stays `localWeatherVelocity`'s job; this option adds
the local motion and the life cycles on top of it.

### What it does

The weather map is static: one coverage field, one offset, and the only motion
is the constant `localWeatherVelocity` translation. Nothing forms, moves or
dissipates, so a long-lived scene is the same sky forever.

This option makes the weather map a function of `ctx.time`. Two things move at
once, and both are read inside the weather sample rather than baked:

- **Drift.** The map flows along `wind(texCoord)`, the curl of a scalar
  potential. A curl field has no divergence by construction, so cells rotate
  and shear and the map never bunches into sinks the way a gradient field
  would. `wind` is read from one tileable 128x128 RGBA8 texture: R and G are
  the signed wind, B is a per-cell life-cycle seed, A is that cell's period
  and its flow phase.
- **Life cycles.** The sampled coverage is scaled by `1 + lifeStrength * life`,
  where `life` rises over the first quarter of the cell's period and falls over
  the rest. A cell therefore grows fast and decays slowly, which is what makes
  it read as a life cycle rather than as a pulse. Periods vary per cell between
  half and one and a half of `cellLifetime`, so neighbouring cells are out of
  step and the map as a whole never pulses.

The drift is a two-phase flow map. Offsetting the map by `wind * time`, as the
first version did, stretches it without bound wherever the wind varies: at the
original settings the map was smeared by 150 s and folded over itself by
500 s. Instead each of two phases drifts for one flow period and then restarts,
and the two are crossfaded so a phase restarts only while its share is zero.
The period is derived from the field's steepest wind change, so a phase never
stretches the map by more than 15 % (measured at most 16 % with the phase seed's own
gradient), however long the clock runs. The phase seed staggers the restarts
over space, so the sky never pulses as a whole.

Physical units come from the weather uv being the cube-sphere face coordinate:
one face edge, a quarter of a great circle, spans `localWeatherRepeat` texture
units, about 100 km per unit at the defaults. Every operation is analytic in
`time`, with no accumulator and no feedback texture. The flow phase is reduced
on the CPU in double precision, so a long clock costs no float precision there.

### Cost

Two extra `textureSampleLevel` per weather sample, once per march step per
pass: the field, and the second flow phase's weather read. About 20 ALU
operations with no transcendentals. The life cycle is two `smoothstep`s and a
`mix` rather than a `pow` or a `cos`, which keeps it off the special-function
path in a divergent loop.

The field is 128x128 RGBA8, 64 KB, read at level 0 with `RepeatWrapping` and no
mip chain, so it stays in cache. It is built on the CPU in about 3 ms on the
first build and never again: every knob is a uniform.

Measured before the flow map (one extra sample, not two) on the hardware GPU,
Storybook `clouds-webgpu/Evolving Weather`, the Basic four-layer pose, DPR 2,
1474x1714, 110 frames per arm after a 10-frame warm-up, median frame interval
with the display refresh cap lifted:

| arm | median | p90 |
| --- | --- | --- |
| evolution off | 10.70 ms | 13.90 ms |
| evolution on | 11.40 ms | 17.40 ms |
| evolution off, `maxIterationCount` 500 | 10.60 ms | 13.60 ms |
| evolution on, `maxIterationCount` 500 | 12.20 ms | 23.60 ms |

So about +0.7 ms at the default step count and +1.6 ms with the step count at
500. The flow map's second weather read has not been re-measured. With the
refresh cap in place every arm reads exactly 16.7 ms, so only an uncapped
measurement can see this at all.

### Trade-offs

- A flow map trades travel for boundedness. A cell drifts at the wind speed for
  part of a flow period and then fades into a copy of the map a little upwind,
  so the local motion reads as flow but never carries a cloud far. Moving the
  whole sky is `localWeatherVelocity`.
- While both phases are visible the read is a blend of two copies about 3 km
  apart at the defaults, a slight softening of the map. The distance follows
  the wind pattern's size, not the wind speed.
- Changing `windSpeed` changes the flow period and so jumps the phases once.
  At 20 m/s a period is about 5 minutes; at 200 m/s about 30 s, where the
  crossfade starts to show as shimmer.
- The drift displaces the texture coordinate, while the LOD is computed from
  the undisplaced one. `localWeatherOffset` already drifts the same way, so
  this inherits the reference's behaviour.
- Growth multiplies the weather value, so cells thin as well as shrink on the
  way down. That reads as dissipation, but it is not a separate condensation
  and evaporation model.
- The life cycle divides `time` by each cell's period in the shader, in 32-bit
  float. After many days of clock the cycle quantises; the flow does not.
- Two layers sharing a channel share their growth, since growth is applied to
  the sample before the per-layer swizzle. This is why the design doc's §2.1
  keeps the type map a separate texture.

## `moonlight`

### What it does

Retargets the march's **one** light onto the moon once the sun has set. It does
not add a second light: the march already carries a light direction for its
phase function, its Beer-shadow march and its shadow cascades, and moonlight
moves that one vector.

Three things move with it, and nothing else:

- **The light direction.** `mix(sunDirection, moonDirection, blend)`, where
  `blend` is a smoothstep on the sun's elevation at the observer, from 0 at the
  horizon to 1 at 6 degrees below it (civil twilight). At `blend` 0 the mix is
  the sun's direction bit for bit, so a daytime frame is the reference's frame.
- **The irradiance.** The moon's share is added to the *direct* member of the
  sun-and-sky irradiance struct the march already reads. The sky member is the
  atmosphere's own and carries no moon, so it is untouched.
- **The cascades.** `context.updateShadowMaps` fits its cascades to the same
  light, and the shadow-map pass marches along it, so a moonlit cloud casts its
  shadow away from the moon rather than away from a sun that is under the
  horizon.

Two values on the context drive it, both plain fields that cost no graph
rebuild:

- `context.moonDirection`, the moon in the same ECEF frame as `sunDirection`.
  **The library reads no clock** (ADR-003), so this is yours to compute; the
  takram helper the storybook uses is `getMoonDirectionECI(date)` followed by
  the ECI-to-ECEF rotation, both off `AtmosphereContext`.
- `context.moonGain`, an artistic multiplier over the physical ratio, and
  `context.moonColor`.

The physical ratio is `FULL_MOON_IRRADIANCE_RATIO` = 2.5e-6, the sun's and the
moon's visual magnitudes apart (`10^(-0.4 * (m_moon - m_sun))`, the pair
`MoonNode.getLunarRadiance` cites). The phase comes from geometry rather than a
knob: the illuminated fraction is `(1 - cos(elongation)) / 2` between the sun's
and the moon's directions, which is 0 for a new moon and 1 for a full one, and
a sphere delivers that fraction of a full moon's irradiance. So the clouds go
dark on a new moon without anything being switched off.

The moon's absolute irradiance is taken from the same sun disc radiance takram's
`SkyNode` builds its moon disc from, times its solid angle. That is deliberate:
it means the moonlit clouds and the visible moon disc in one frame agree, which
is the thing a viewer actually checks.

### Cost

Nothing is added to the graph when the option is off: the light is
`marchU.sunDirection` and the irradiance is the atmosphere's own struct, so the
reference's WGSL is unchanged and the parity ladder does not move.

With it on, per in-cloud sample: one `vec3` add on the direct irradiance and
one `solarIrradiance * ratio` product, the sun's disc radiance being a chain of
uniform multiplies hoisted into one `.toVar()`. No extra texture read per sample.
The light direction is one `mix` and one `normalize` **per frame on the CPU**,
not per sample: the march reads it from a uniform, so the direction costs
nothing inside the loop. Two extra uniforms (`lightDirection`,
`moonIrradianceRatio`) and about twenty scalar operations per frame.

Measured on the hardware GPU, Storybook `clouds-webgpu/Night`, DPR 2 at
2874x1794, 90 frames per arm after a 64-frame settle, median frame interval with
the refresh cap lifted (`examples/storybook/scripts/night-stills.mjs`, the
report it writes lands in `test-results/night-stills/`). Two dates, because the
cost turned out to depend on where the light is:

| arm | moon | median | p90 |
| --- | --- | ---: | ---: |
| moon below the horizon, moonlight off | illum 0.085 | 27.3 ms | 30.1 ms |
| the same frame, moonlight on | illum 0.085 | 27.3 ms | 31.0 ms |
| moon 14.5 degrees UP and full, moonlight off | illum 0.996 | 25.5 ms | 28.2 ms |
| the same frame, moonlight on | illum 0.996 | 31.0 ms | 42.6 ms |

**So the flag is free when the light is below the horizon and costs about
5.5 ms when it is above it, and the reason is the march's existing Beer-shadow
march, not anything this option adds.** Nothing is added to the graph and
nothing is added to the loop's trip count: the per-sample work is one `vec3`
add and one product. What changes is which direction the march already marched
toward. With the light below the horizon the ray to the light leaves the deck
at once; with it 14.5 degrees up the ray crosses the whole deck before the
transmittance falls below the threshold. That is the same cost the reference
pays at a low sun, and the ladder already carries `sun-low`, `sun-horizon` and
`sun-twilight` for exactly that reason.

The honest summary is therefore: the option adds one direction and one radiance
to a march that had one direction and no radiance after sunset, and the price is
the march's own low-sun shadow cost, which is a pose property rather than a
per-sample tax. `moonGain` is not the lever, being a magnitude and not a step
count: `clouds.maxIterationCountToSun` and `shadow.cascadeCount` are.

### Trade-offs

- **`moonGain` has to be large.** The physical 2.5e-6 is four orders of
  magnitude below daylight and a fixed exposure shows nothing, which is why
  Sky Pro exposes a gain too. The story sets it explicitly; the library default
  is 1, the physical value, so the knob is visible in the numbers rather than
  hidden in a default.
- **One light means one shadow direction.** A frame with the sun still up and
  the moon already risen lights and shadows from the same vector, so there is no
  second, softer set of moon shadows in a twilight frame.
- **The phase is only as good as the moon direction.** The illuminated fraction
  is read off the elongation, so an approximate moon direction gives an
  approximate phase. It never needs a separate moon-phase setting to keep in
  step, which is the point.
- **No lunar scattering inside the march.** The moon adds irradiance, not a
  second inscattering integral. Takram's own `AerialPerspectiveNode.moonScattering`
  adds lunar inscattering to the sky and the ground, and it is the right knob
  for that; see [docs/night-sky.md](night-sky.md).
- **Haze keeps the sun's ground irradiance.** `approximateHaze` reads the
  sun-and-sky cache, which is the atmosphere's own and has no moon in it, so a
  hazy night is lit by the moon's direct light and not by moonlit haze.
## `lightning`

### What it does

Adds a transient point light inside the cloud volume to the march's shading, so
a discharge lights the cloud from within rather than washing the finished
colour. Each shaded sample gets one in-scatter term: the sun's phase function at
the angle to the flash, an inverse-square falloff, and the cloud's own
extinction between the sample and the flash.

The extinction is the part that makes it read as a light inside a medium. It
reuses the sun's own secondary march (`createMarchOpticalDepth`) with a small
iteration count, so a flash deep in a dense core is occluded by the cloud in
front of it instead of shining through. Nothing new is marched: the same
function, called toward a different direction.

The state is one plain field on the context, set and cleared by the
application, never by the library:

```ts
cloudsContext.experimental = { lightning: true }

cloudsContext.lightning = {
  position: new Vector3(...), // ECEF metres, inside the cloud volume
  intensity: 1, // 0 whenever no flash is lit
  colour: new Vector3(1, 0.9, 0.8) // linear RGB
}
```

`position` is ECEF metres because that is the space the march works in.
`intensity` is 0 while no flash is lit, which is what makes the cost zero
between strokes rather than merely small. `null` clears all three.

`intensity` is a radiance scale divided by distance **squared in metres**, so it
is large and that is not a mistake: the term a shaded sample receives is
`intensity / max(d², softening²)`, times the cloud's own transmittance toward
the flash, its phase function and 1/4π. A sample 1 km from a strike needs an
`intensity` around 1e9 to read as a flash, the same way a point light's power
is not its brightness. Multiply by the falloff you want at the range you care
about: `intensity = wantedRadiance × (range in metres)²`.

A plain field, not a setter, and deliberately: it feeds uniforms written every
frame, so striking a flash costs no `graphVersion` bump and no graph rebuild. A
setter that rebuilt the graph would put a compilation hitch in the middle of
every flash, which is exactly when a stutter would be noticed.

For a scene that wants a storm without scheduling its own, two pure helpers are
exported. `flashEnvelopeCPU(time, seed)` returns the intensity for a `time`
the caller passes, and `flashPositionCPU(index, seed, bottomRadius, altitude)`
returns a seeded strike on a shell. Both are seek-safe: the envelope is a
function of `time` alone, nothing accumulates, so scrubbing to `t` reproduces
exactly the flash a forward playthrough produced at `t`. Neither reads a clock.

### Cost

Three regimes, and they are very different. Every figure below is
`lightning.spec.ts` on hardware, at 640x360 over a deck at coverage 0.3, best of
three repeats of twelve frames.

With the option **off**, the cost is not merely small, it is zero, and that is
the claim worth making precisely: the graph builder returns an empty object, so
no node is emitted at all. `lightning.digest.test.ts` pins the primary march's
normalised WGSL digest with the option off to a literal taken from `origin/main`
at `c4a7b346`, and asserts the digest with the option on differs. Half of that
proof is not optional: a feature that never reached the shader would satisfy the
first half alone. The 2086-variant digest matrix agrees: all 1024 `lightning-`
variants digest to what their `origin/main` counterparts digest to.

With the option **on** and no discharge lit, `active` is 0 and the guard around
the secondary march is false, so the march does not run. What remains is a
uniform compare and a select per shaded step. Measured, that arm moves the plate
by an rmse of 2.8e-5 against an option-off frame, and 3.0% of pixels by more than
1e-4. It is **not** zero, and the reason is worth stating: turning the option on
recompiles the march with the guard in it, and a different instruction stream
contracts differently. Zero is the off claim above, not this one. What the number
does show is that an idle storm is an order of magnitude below the lit arm's
4.9e-4 and under the visibility floor, and the wall clock cannot see it at all:
15.17 ms against 15.18 ms for the option off, a difference inside the run's own
noise. The GPU's own medians do not settle it either at this size: the probe
reports whole-frame totals and names no per-pass entry for the march, so the lit
arm's cost is bounded by "under what this instrument can see" rather than
measured.

With a discharge **lit**, the guard is true and every shaded sample pays for a
6-step secondary march toward the flash, which at the default
`minSecondaryStepSize` of 100 and `secondaryStepScale` of 2 covers about 1.05 km.
On a 640x360 frame where the primary march is the whole cost, six extra density
samples on the quarter of pixels that carry cloud is a small fraction of it, and
at this size neither the wall clock nor the GPU's own medians resolve the
difference. So the lit cost is real work that this harness cannot price: read it
as unmeasured rather than as free. That is why the
guard is on the uniform rather than always taken: the cost is paid only while
something is lit, and a storm spends most of its time between strokes, which is
the regime measured above.

Reference mode pins the option off, so the parity ladder is unchanged and no
committed capture saw a flash.

### Trade-offs

- One flash at a time. The in-scatter is a single point source, so a
  simultaneous strike pair, which is what makes lightning read as lightning in
  wide shots, is not expressible without a second term.
- `intensity` is a radiance over distance squared **in metres**, so a useful
  value is around 1e9 and there is no way to guess that from the type. The
  formula is written out above rather than folded into the uniform, because
  folding it in changes every recorded graph digest and the honest scale is
  worth more here than the tidiness.
- The secondary march is a straight 6-step walk with the sun march's growing
  step, over roughly 1 km. Beyond that distance the extinction toward the flash
  is whatever the last step accumulated, so a flash lighting a cloud 10 km away
  is attenuated as if the cloud were 1 km away. The distance falloff dominates
  out there anyway, which is why this reads as a limit on the shape of the
  glow rather than as an error.
- The phase function is the cloud's, so a flash is forward-scattering with the
  same anisotropy the sun has. Real intra-cloud light is much more strongly
  forward-biased than that, and a consumer who wants the look can raise
  `phaseAttenuation`.
- The flash does not cast a shadow map entry, does not light the ground, and
  does not appear in the aerial perspective as its own source. It is a term in
  the march's shading and nothing else.
- `active` is a uniform, so both sides of the guard are compiled into the
  shader. The march is skipped at run time, not absent from the binary. Making
  it absent would mean a graph-time gate on the flash, which is the rebuild
  this design exists to avoid.
## `cloudEnvironment`

### What it does

`scene.environmentNode` gets whatever the scene's environment node says. With
takram's `skyEnvironment()` that is the sky alone, baked into a cube map, so a
water surface or a glossy panel reflects a cloudless sky: the clouds march into
the frame and stop at its edge, and everything the frame reflects is the part of
the world the clouds are not in.

With this option on, `cloudsPass.environment` is that same cube map with the
clouds in it. It is a second march of the same volume, at its own step budget,
into a cube target the size of the sky bake, composited per texel as the sky
behind the clouds weighted by their transmittance, plus aerial perspective on the
cloud front. Assign it to `scene.environmentNode` and reflective materials pick
up clouds; sample the node directly and you get the raw cube.

```ts
const cloudsPass = clouds({ sceneDepth })
cloudsPass.cloudsContext.experimental = { cloudEnvironment: true }
scene.environmentNode = cloudsPass.environment
```

The bake is refreshed every `updateInterval` frames, and immediately when the
camera has moved more than a kilometre from the position it was baked at, when
the sun has moved more than 0.1 degrees, when the graph has been rebuilt (a
preset or a layer change, so the map can never describe a volume the frame has
stopped showing), and whenever `cloudsPass.environment.refresh()` is called.
That last one is the hook for a scene whose clouds move faster than the
schedule: call it after a change you cannot wait for.

Both thresholds are the ones `SkyEnvironmentNode` uses, and the size is its
default 64, so this map is a drop-in for the one it replaces rather than a
different kind of object. It reads back `null` until the option is on and a
graph has been built, and `applyReferenceMode` pins it off, so the parity ladder
never sees it.

Two things are deliberately not in the bake, because they belong to a frame
rather than to a direction. The Beer shadow map is skipped, so one cloud deck
does not shadow another in the reflection, though every sample still runs the
per-sample sun march and shadows itself. Light shafts are skipped for the same
reason. Neither is reachable from a reflection's blur, so both would be cost
with nothing to show.

### Water Pro

`threejs-water-pro` samples an **equirectangular image**, which is what its
built-in `Sky` takes, so the cube cannot be handed to it as it stands.
`WaterProCloudSky` converts each bake into a 2:1 equirect render target that
Water Pro samples for its fog tint and its water reflections, with the clouds in
both:

```ts
const cloudsPass = clouds({ sceneDepth })
cloudsPass.cloudsContext.experimental = { cloudEnvironment: true }
const sky = new WaterProCloudSky(cloudsPass.environment)
water.setSky(sky)
// once per frame, after the renderer has run the clouds pass
sky.update(renderer)
```

It is a structural implementation of Water Pro's `SkyProvider`, written against
that package's published interface, so Water Pro is not a dependency of this
library and none of it is vendored here. The equirect carries the settings its
custom-sky guide requires: `EquirectangularReflectionMapping`, `RepeatWrapping`
on S to close the `atan2` seam, no mip chain, linear filtering.

Its optional `getBrightnessNode`, `getSun` and `setActive` are left off on
purpose, so Water Pro falls back to a brightness of one, keeps its own sun
authoritative rather than reading an ECEF vector it cannot place, and never asks
the provider to gate a render.

### Cost

Six marches per refresh, of `size` squared texels each, at
`maxIterationCount` steps per ray: 64 squared by 32 steps is about 786k samples
per refresh, every fourth frame. The primary march's cost is per sample and
dominated by the weather and media fetches, so that figure is the number to
multiply by the screen pass's own per-sample cost.

What that costs in a frame is not the same number, because the six faces are
drawn in one submit and the cost lands on whichever frame refreshes rather than
being spread across the interval. Measured on the hardware GPU, Storybook
`clouds-webgpu/Cloud Environment`, 1280x900 at DPR 1, the display refresh cap
lifted (`--disable-frame-rate-limit`, `--disable-gpu-vsync`), 240 frames per run
after a 30-frame warm-up, two runs per arm:

| arm | mean, run 1 | mean, run 2 |
| --- | --- | --- |
| option off | 11.52 ms | 11.41 ms |
| option on | 13.58 ms | 13.59 ms |

So about +2.1 ms a frame amortised, which is about 8.5 ms a refresh at the
default interval of four. The p90 and the maximum are the same in both arms
(about 21 ms and about 26 to 37 ms), so the spike fits inside the frame-time
spread this scene already has, and the per-frame split the story also logs is not
claimed here: its two buckets cross over between runs, which is what a spike
inside a bimodal frame time looks like. Two runs per arm, and the on arm's mean
moved by 0.01 ms between them, so the difference is not run-to-run noise.

A refresh also rebuilds the material's PMREM read, which is a prefilter of the
cube: cheap at 64 squared, and the reason the default is small. Raising `size`
to 128 quadruples the bake and visibly reduces the aliasing, so the knob is
worth reaching for when a mirror fills the frame.

### Trade-offs

- The shape volumes are sampled at mip level 0 by construction, so nothing here
  filters the cloud noise. A cube face texel at 64 pixels spans about 145 metres
  at 6 km, against about 26 metres per noise texel, so a mirror shows more
  speckle than the screen does. A larger `size` is the only filter available;
  `environmentTexelFootprint()` reports the figure so it can be budgeted rather
  than discovered.
- The map is baked for the camera's position and the sun direction at the last
  refresh, so it is a stale view of the sky rather than a live one. The
  `distanceThreshold` and `angularThreshold` are what bound the staleness, and
  they are the same 1 km and 0.1 degrees the sky bake accepts.
- It marches the volume a second time, so a scene paying for the screen pass is
  paying twice for the clouds. That is the whole trade: a reflection that carries
  clouds is worth one extra pass at one sixty-fourth the resolution.
- A frame that refreshes is longer than one that does not, so the cost is a
  periodic spike rather than a steady tax. On a display capped at the refresh
  rate it is invisible, which is also why a capped measurement cannot see it.
- `scene.environment` is untouched. This is the node form,
  `scene.environmentNode`, so a scene that sets `scene.environment` keeps the
  sky it had and nothing changes.

## `staticMode`

### What it does

Skips the cloud march, shadow pass, and resolve pass when the scene inputs have not changed from the previous frame. Camera pose and projection, sun direction, time, all CloudsContext knobs, and viewport dimensions are compared against the prior frame. Once temporal history has converged, subsequent frames reuse the last rendered output directly, eliminating cloud rendering work entirely for still cameras, paused weather, and map viewers. Any change to camera, sun, time, knobs, or viewport immediately resumes normal rendering and resets history as normal.

### Cost

Negligible CPU overhead per frame to compare camera matrices, sun direction, time, viewport size, and context knobs. With static mode active on an idle or still scene, GPU time for the cloud march, shadow pass, and resolve drops to zero, reducing frame time by the full cost of the cloud pipeline.

### Trade-offs

Static mode reuses a frame only once every temporal history it depends on has kept at most 0.1 % of its starting error (a tolerance of 1e-3). Freezing earlier keeps a still that the same inputs would have gone on to change. Measured on `baseline-medium`, the old rule (16 frames upscaled, 1 at full resolution) froze a plate up to 0.17 (linear) away from the converged one. The wait is counted in rendered frames of unchanged input, and the longest history that applies sets it:

| History | Present when | Frames |
| --- | --- | --- |
| Bayer upscale, one cell replaced per frame | `temporalUpscale` on | 16 |
| Colour TAA, alpha 0.1 | `temporalUpscale` off | 66 |
| Shadow atlas, alpha 0.01 per frame | `shadow.temporalPass` on and a layer casts shadows | 688 |

With the default shadows that is 688 frames, about 11 seconds at 60 fps, before the first skip. Any input change restarts the count. Turning `shadow.temporalPass` off, or casting no shadows, brings it down to 16 or 66 frames.

While skipping, animated effects such as procedural wind drift, changing sun angles, or moving cameras will not update until the inputs change, which automatically resumes rendering. Two inputs are not detected: scene geometry, through the depth buffer, and atmosphere parameters. After changing either under a still camera, call `resetHistory()` to resume.

## `cirrusDeck`

### What it does

Cirrus is the thin, fibrous ice cloud at 8 to 12 km. The volumetric layers
cannot draw it: their shape noise is cumulus-sized and chunky, and a layer thin
enough to read as a veil is a few samples of a march built for kilometre-deep
cloud. This option draws cirrus the cheap way, as one textured sheet.

The deck is a sphere `ctx.cirrusDeck.altitude` metres above the march's bottom
radius. Each march fragment intersects its ray with that sphere once, reads the
deck's opacity from a repeating 2D texture at the hit, and composites the result
by depth against the marched clouds: behind them from below the deck, in front
of them from above it. Nothing is marched and no march bound changes.

**The texture is ours.** By default it is a 512 by 512 single-channel tile
generated on the CPU the first time the option builds
(`src/experimental/cirrusStreaks.ts`): a patch mask over anisotropic, warped
value noise, periodic on both axes so the tile repeats with no seam. Set
`ctx.cirrusDeck.texture` to your own texture to replace it. The red channel is
opacity and the texture must repeat. It is mapped with the same cube-sphere
globe uv as the weather map, `scale` metres to a tile, and drifts at
`velocityU`, `velocityV` metres per second along the texture's own axes, read
from `ctx.time`.

**It is lit by the atmosphere at the deck's own position.** The sun and sky
irradiance come from the atmosphere LUTs at the hit point, whatever
`accurateSunSkyLight` says, because the interpolated path is a cache over the
volumetric layers' heights and would light a 10 km sheet as if it were the top
of the cumulus. The radiance is single scattering in an optically thin sheet:
opacity times the sun irradiance weighted by the clouds' own phase function,
plus the sky irradiance over 4 pi. The aerial perspective from the camera to
the hit is then applied the way the reference applies it to the cloud front,
so a deck near the horizon fades into the sky.

The crops show the deck off and on over the same sky, from the same pixels:
[noon off](experimental/cirrusDeck/noon-off.webp),
[noon on](experimental/cirrusDeck/noon-on.webp),
[low sun off](experimental/cirrusDeck/lowsun-off.webp), and
[low sun on](experimental/cirrusDeck/lowsun-on.webp).

Knobs on `ctx.cirrusDeck`, all read every frame with no rebuild: `altitude`
(10000), `strength` (0.7, an opacity multiplier where 0 draws no deck),
`scale` (40000 m a tile), `velocityU` (12 m/s), `velocityV` (0) and `texture`
(null, the bundled streaks).

### Cost

Per march fragment: two ray-sphere tests (the deck and the ground), one
cube-sphere uv, one texture read at an explicit LOD, one atmosphere irradiance
read, one phase function and one aerial-perspective transfer read. The deck runs
at the march's resolution, a quarter of the frame in each axis with
`temporalUpscale` on, and the temporal resolve upscales it with the clouds.
It does not touch the primary march, the shadow cascades or the resolve, so
the cost does not scale with any step budget.

Generating the default texture takes a one-off CPU pass over 262144 texels the
first frame the option is on.

Measured on a Mac mini, Chrome WebGPU, at 1920 by 1080 on a ground camera
looking straight up (`examples/parity/e2e/cirrusDeck.spec.ts`): 15.47 ms a
frame off, 16.26 ms on, so 0.80 ms or 5.1 %, against 0.01 ms between the two
off runs that bracket it. The path has no branch, so a pixel the ground or the
scene hides pays the same as sky: the cost follows the march's fragment count,
not how much of the frame is sky.

### Trade-offs

- There is no WebGL counterpart, so nothing here can be checked against the
  original. Reference mode pins the option off, and with it off every pass
  program compiles to the bytes main does
  (`src/experimental/cirrusDeck.digest.test.ts`), so the parity ladder cannot
  move.
- The globe uv is a cube-sphere map. Each of its six faces holds the streaks
  at its own orientation, so near a cube edge, about 10000 km apart on the
  globe, the streak direction turns, and the drift axes are the face's rather
  than east and north. The weather map shares this limitation.
- The deck is lit by the sun only. With `moonlight` on, the volumetric clouds
  take the moon's light after sunset but the deck stays dark.
- The volumetric clouds do not shadow the deck, and the deck does not shadow
  them or the ground: it is an image on a sphere, not a medium.
- Composited at the march's resolution, a moving camera reprojects the deck
  at the scene or far depth rather than the deck's, so under fast translation
  it can smear for the frames the history takes to converge.
- The LOD is analytic, from the pixel angle and the slant at the hit, so the
  read is defined anywhere in the shader and does not alias across the cube
  seams the way a derivative-based mip would. Near the horizon it blurs to the
  last mips, which the aerial perspective mostly hides.

## `shadowRoundRobin`

### What it does

The cloud shadow map is an atlas of cascades, three by default, and each shadow
update marches every one of them. With this option each update marches only
one cascade, in turn, and the others keep the map they last rendered together
with the matrices they were rendered with, so a lookup still lands where that
map was drawn. With the default `shadow.updateInterval` of 2 and three
cascades, each cascade is refreshed every sixth frame.

The temporal shadow history follows each cascade on its own: the cascade that
was marched resolves against its own last update, and every other layer is
carried over with an exact copy, never blended again against a march that did
not run. The blend weight is rescaled so each cascade converges at the same
rate per wall-clock frame as before.

Every cascade is marched again, as without the option, on the first update, on
a history reset, when the cascade count changes, when the sun turns more than
0.25 degrees since a cascade was drawn, and when the camera moves far enough
that a reused cascade's fresh fit would sit more than 0.25 clip units off the
centre of its old map. `computeResolve` resolves every layer in one dispatch,
so with it on this option does nothing.

### Cost

It removes work rather than adding it. Each update runs one cascade's march
instead of all of them, plus one texture copy per reused cascade when the
temporal pass is on, and a few matrix products on the CPU to check the reuse
limits. The march dominates the shadow pass, so the saving approaches two
thirds of the march at three cascades.

Measured on an Apple M4 Mac mini at 2880x1800, whole-frame GPU time, five
paired repetitions per arm in frames 4-14 after a load (before the GPU clock
governor settles lower). Frame time with the option off and an update every
frame, then the change with each setting:

| scene | off | on | `updateInterval` 2, off | `updateInterval` 2, on |
| --- | ---: | ---: | ---: | ---: |
| baseline, no caster | 14.25 ms | -0.38 ms | -0.27 ms | -0.45 ms |
| horizon, low sun, no caster | 20.19 ms | -0.50 ms | -0.16 ms | -0.58 ms |
| light shafts, low sun | 67.91 ms | -3.80 ms | -2.59 ms | -4.29 ms |
| four layers casting | 24.80 ms | -3.92 ms | -2.89 ms | -4.79 ms |

At the library default of `updateInterval` 2, turning the option on saves a
further 0.2 to 0.4 ms where no layer casts and 1.7 to 1.9 ms where layers do.
Raw data are in `perf/2026-10-08-shadow-round-robin/`.

### Trade-offs

A reused cascade is up to `cascadeCount x updateInterval` frames old. Under a
moving camera or a moving sun its shadows lag the scene by that many frames,
until the cascade's turn comes or a reset forces all of them. The reset limits
bound how far that lag can drift, but slow continuous motion stays under them
by design, so a long pan shows the lag as a slight crawl at the edges of each
cascade. Off by default, and pinned off by reference mode.

## Whole-scene helpers, which are not options

Two helpers sit beside the option table and are deliberately not in it. Neither
is a boolean and neither reads a clock: they are arithmetic over values the
caller already owns, so nothing here moves a parity capture. The sun sync never
changes the compiled graph. A scene preset changes it only through the switches
it names, `haze` and, for the two storm presets, `convectiveProfile`, so
applying one rebuilds the graph like setting those yourself would. `defaultOutputDigest.test.ts` is the proof that the default
render is untouched, and the helpers' own tests are the proof that they do what
their names say.

### The sun sync

Every consumer needs the same vector and none of them share a store. The
atmosphere reads `atmosphere.sunDirectionECEF`, the clouds read
`cloudsContext.sunDirection`, and the shadow dependencies read a uniform the
caller built from a clone. Set two of the three and the frame is not broken, it
is wrong: the sun is up for the sky and down for the shadows, and nothing says
so.

`syncCelestialDirections` takes a place, an instant, and every sink, and writes
both bodies into all of them:

```ts
syncCelestialDirections(
  [
    {
      sunDirection: atmosphere.sunDirectionECEF,
      moonDirection: atmosphere.moonDirectionECEF
    },
    { sunDirection: cloudsContext.sunDirection },
    { sunDirection: shadowDeps.sunDirection }
  ],
  { date: new Date(), location: { longitude: 0, latitude: 51.5 } }
)
```

A sink is anything with a `sunDirection` field, which is either a `Vector3`
(`cloudsContext.sunDirection`) or a uniform wrapper
(`atmosphere.sunDirectionECEF`), so a consumer changes nothing to take part. A
sink with no `moonDirection` gets the sun and nothing else.

The astronomy is `@takram/three-atmosphere`'s `celestialDirections`, which wraps
`astronomy-engine`: this port computes nothing. The observer position is passed
through, so the result is topocentric rather than geocentric, which matters for
the moon and for a low camera.

The optional `timeOfDay` is a fraction of a day in LOCAL SOLAR time, so 0.5 is
local noon for every longitude. Without it the date's own UTC time is used,
which is what a UTC-driven consumer wants. Solar rather than civil time,
because civil 18:00 is the observer's timezone and not where the sun is.

Calling it again with a new instant moves the sun, which is how an animated
scene gets its clock. The library never reads one: there is no `Date.now()`
anywhere in this path, and the same request twice returns the same sun.

Cost: nothing per frame. The directions are two unit vectors in ECEF, computed
on the CPU by the same code the atmosphere package ships, and writing them is
three `Vector3.copy` calls into uniforms the frame already uploads.

Trade-offs:

- Only the sun and the moon are synced. Dawn colour, exposure and the aerial
  perspective's own tuning are the caller's, so a "correct" sun can still be
  paired with a fog colour from another hour.
- The clouds are shaded from the sun direction only unless
  `experimental.moonlight` is on, which retargets the march's light onto the
  moon after sunset (see [`moonlight`](#moonlight)). It reads
  `cloudsContext.moonDirection`, so give the clouds sink a `moonDirection`
  field as well and this helper writes both bodies there.
- `timeOfDay` needs a longitude to become an instant and ignores any timezone in
  the `Date`. That is deliberate (solar time) and it means the same preset
  number is not the same clock reading in two timezones.
- Moon phase, and therefore whether the moon is up at all, comes from the date.
  A night preset at the wrong phase is a new-moon night.

### The scene presets

`applyScenePreset` is the whole-scene version: cloud type, per-preset layer
overrides, coverage, haze, scattering and shape knobs, the experimental options
the sky needs, and then the sun and moon for its time of day at the caller's
place. One call, because a preset applied halfway is a different sky and the
missing half is the half nobody looks at.

```ts
applyScenePreset(cloudsPass.cloudsContext, 'stunningSunset', {
  date: new Date('2026-03-02T12:00:00Z'),
  location: { longitude: 30, latitude: 35 },
  sinks: [
    {
      sunDirection: atmosphere.sunDirectionECEF,
      moonDirection: atmosphere.moonDirectionECEF
    },
    {
      sunDirection: cloudsPass.cloudsContext.sunDirection,
      moonDirection: cloudsPass.cloudsContext.moonDirection
    }
  ]
})
```

Each preset starts from a cloud-type preset (the `applyCloudTypePreset` table
above) and overlays its own four-lane `layers` tuple, solar time of day,
coverage, exposure multiplier, haze settings, `cloudShape` / `convectiveProfile`
/ `cirrusDeck` parameters, and scattering scales:

| preset | cloud type | solar time | coverage | exposure | haze | extra |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `partlyCloudy` | fairWeatherCumulus | 0.624 | 0.49 | 1.00 | yes | |
| `fluffy` | stratocumulusDeck | 0.624 | 0.60 | 1.00 | yes | `erosionShape: -0.18` |
| `pixar` | mixedSky | 0.624 | 0.47 | 1.00 | yes | `cirrusDeck` |
| `stunningSunset` | fairWeatherCumulus | 0.736 | 0.47 | 1.46 | yes | |
| `moonlitNight` | fairWeatherCumulus | 0.168 | 0.60 | 1.00 | no | `moonlight` |
| `hazy` | overcastSheet | 0.452 | 0.50 | 1.00 | yes | `cirrusDeck`, `hazeDensityScale: 3.2e-4` |
| `thunderstorm` | overcastSheet | 0.452 | 0.64 | 0.52 | yes | `convectiveProfile`, `baseShadowStrength: 1.2` |
| `stormyEvening` | overcastSheet | 0.452 | 0.65 | 1.00 | yes | `baseShadowStrength: 0.5` |

The three preset-managed experimental flags (`convectiveProfile`, `moonlight`,
and `cirrusDeck`) are reset before merging the preset's own `experimental`
choices into the caller's other flags (such as `cloudTypeMap` or
`cloudEnvironment`), so switching from `moonlitNight` or `thunderstorm` to
`partlyCloudy` never leaves a stale experiment enabled.

Cost: the preset moves numbers, so the cost is whatever those numbers cost.
`convectiveProfile` is one 2D Perlin and one per-lane Gaussian per marched step,
`cirrusDeck` is one analytic spherical-shell intersection and texture lookup
behind the march, and `haze` is an analytic fog integral. Each is priced in its
own section; a preset that asks for one has asked for that cost by name.

Trade-offs:

- A solar time of day is a fraction, not a clock reading, so what the sun does
  with it depends on the observer's latitude and the date. 0.736 (17:40) is a
  low golden-hour sun near the equinox at mid-latitudes.
- `moonlitNight` enables `experimental.moonlight` and configures `moonGain` and
  `moonColor` on the clouds context, while the caller's sky pass (`SkyNode` with
  `showMoon`, `showStars`, and `moonScattering`) draws the moon disc and star
  field behind the clouds. Pick a date near full moon so the sun-moon elongation
  illuminates the disc.
- `exposure` is a relative tone-mapping exposure multiplier (1.00 for standard
  daylight, 1.46 for `stunningSunset`, 0.52 for `thunderstorm`). The library
  owns no tone-mapping pass, so the host multiplies its baseline exposure by
  `preset.exposure`.
- A preset that changes `experimental`, `haze`, or active layer structure
  rebuilds the graph and resets history. Do it at setup or preset selection.
  `applyReferenceMode` afterwards pins every option back off, which is the way
  to take the options without the sky.
