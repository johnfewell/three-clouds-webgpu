# Integrating clouds into a project

Start with a complete [vanilla recipe](recipes/vanilla/README.md) or
[R3F recipe](recipes/r3f/README.md). They include application bootstrap, package
asset URLs, renderer initialization, scene geometry, the frame loop, resize,
failure handling and cleanup. This guide explains which decisions belong to
your application and which wiring the helper handles.

The [generated API reference](docs/API.md) belongs to the same package version.
It derives signatures, public JSDoc and default tables from the implementation.
Use [WEBGPU.md](WEBGPU.md#usage) for the advanced manual graph, not as a second
initialization path to run alongside the helper.

## Compatibility before configuration

Use the exact dependency pins in the recipe first. The consumer Three.js
revision is stock **0.185.1**, with the fork builds of `@takram/three-atmosphere`
and `@takram/three-geospatial` pinned by the recipe's `overrides`. The npm builds
of those two packages fail to import on 0.185.
Use native WebGPU and a perspective camera. Keep a single resolved copy of
Three.js, `@takram/three-atmosphere`, `@takram/three-geospatial` and this package:
context providers and shader nodes must agree on constructor identity.

The recipe's TypeScript mode is ESM with browser-bundler resolution and
`skipLibCheck: true`. The latter skips upstream declaration checking, not your
application. A small NodeNext import probe does not qualify the full scene:
upstream declarations produce missing-export errors on the larger surface.
The [support matrix](README.md#install) separates consumer pins from repository
development and unverified configurations.

## One composition, one owner

Call `createCloudsIntegration` with an initialized renderer, camera, atmosphere,
scene pass, explicit lighting mode and loaded or supplied textures. The helper
returns `pass`, `context`, `aerial`, `output`, `diagnostics()`, `update(...)`,
`resetHistory()` and `dispose()`. Assign its output to your render pipeline.

The helper does not create or replace a renderer, scene, camera, scene pass,
atmosphere, animation loop, clock or scene origin. It installs the cloud and
atmosphere context providers while preserving unrelated renderer fields.
Only one active helper may own a renderer or cloud pass; dispose it before
creating a replacement. Separate renderers may have independent integrations.

For R3F, pass the existing `<Clouds>` pass as `cloudsPass`. Do not create a
second pass or dispose the adapter's pass from the composition effect. Create
the helper in an effect, clean it up in that effect, and allow StrictMode to
perform setup → cleanup → setup. The complete recipe demonstrates this path.

The helper's scene pass, depth node and camera **identities are fixed**.
Ordinary movement and projection updates on that camera are supported. If you
replace one of those objects, dispose and recreate the helper; `update()`
refuses an identity mismatch rather than pretending the aerial graph changed.
This is narrower than the low-level pass, whose `camera` and `sceneDepth`
setters support replacement and invalidate the graph/history themselves.

Keep the R3F `<Clouds sceneDepth={...}>` node referentially stable between
intentional replacements. Retain the scene pass's depth node or memoize a
derived node; do not construct one during every render. A new node identity
rebuilds the graph and resets temporal history, which can cause flicker if
React rerenders every frame.

### Replacing an integration

Pause rendering while replacing the helper and prepare `replacementOptions`
with the new camera/scene pass and the resources you still own. If you reuse
an existing Three r184 `RenderPipeline`, mark it dirty after assigning the new
output; assignment alone leaves its previous compiled graph active.

```ts
integration.dispose()
integration = createCloudsIntegration(replacementOptions)
pipeline.outputNode = integration.output
pipeline.needsUpdate = true
```

Resume rendering only after successful setup. Dispose any retired scene pass
yourself after detaching its consumers. Alternatively, dispose the old pipeline
and construct a new one with the replacement output; a new pipeline starts dirty.

## Render graph and lighting

The scene pass must write `output` and `normal` MRT attachments, alongside its
depth texture. Cloud `layerNode` and `depthVelocityNode` belong to the cloud
pass's own targets; never put them into the scene MRT.

```text
Scene MRT: color, normal, depth
          ↓
Aerial perspective: scene atmosphere + sky + cloud shadow/light shafts
          ↓
Cloud composite: destination × (1 − cloud alpha) + cloud color
          ↓
Render pipeline: tone mapping / output conversion
```

Choose exactly one lighting mode:

- `lighting: 'post'`: scene materials provide unlit albedo; aerial perspective
  performs the surface lighting. This is the first-frame recipe path.
- `lighting: 'lights'`: scene materials are already lit, and aerial
  post-lighting stays off. The helper does not install scene lights or replace
  host lighting policy. Custom cloud-shadow receivers remain explicit advanced
  wiring. Call `pass.prepareShadow(renderer, camera)` before a forward-lit scene
  capture when its receivers need the current atlas; keep sample inputs fixed
  through that capture.

Do not compute a separate background sky that aerial perspective will overwrite.
The recipe disables remote star/moon features explicitly; enabling a sky feature
can add upstream asset loading. See [night-sky wiring](docs/night-sky.md) before
enabling it in an offline application.

## Coordinates and units

- All public world distances, layer altitude and layer height are **metres**.
  The default first layer starts at **750 m** and is **650 m** thick.
- The application chooses local world coordinates and `worldToECEFMatrix`.
  Earth-centred world space and a local tangent frame are different policies;
  do not mix a local camera with an identity Earth transform accidentally.
- `sunDirection` and `moonDirection` are normalized **ECEF directions**, not
  positions or world-space light targets. A fresh context's zero sun is not a
  usable direction. Supply a real sun before the first frame.
- The helper uses its cloud context as the authoritative sun/world state and
  synchronizes atmosphere during `update()`. Do not separately maintain stale
  clones for aerial shadows. `syncCelestialDirections` is available when your
  application derives directions from a location and date.
- Atmospheric internal length scales and the cloud pass's depth-storage units
  are implementation details, not reasons to pass kilometres into public layer
  or camera settings.

## Load the four baked assets

The package ships `local_weather.png`, `shape.bin`, `shape_detail.bin` and
`turbulence.png`. Use the recipe's package asset imports with a `?url` suffix,
or copy the files to your own public asset directory and supply
those URLs. The exported `DEFAULT_*_URL` values are **page-relative**
`assets/...` strings, not package-relative URLs.

`loadBakedCloudTextures(urls, { signal })` loads all four and returns exactly
`localWeatherTexture`, `shapeTexture`, `shapeDetailTexture` and
`turbulenceTexture`. Its result has no `dispose` property, so assigning it to a
context does not overwrite that context's method.

On success, the caller owns the textures. Aborting after success does not revoke
ownership. On failure or cancellation, the loader disposes its completed and
late-arriving resources. It aborts volume fetches; image transport may continue,
but late images are ignored and disposed. Cancellation rejects with
`name === 'AbortError'`. Other failures are `CloudTextureLoadError`, with an
asset name, URL and, where applicable, HTTP status and expected/actual byte count.
An HTML fallback response with status 200 is not a valid binary volume.

Default jitter is generated from the package's own deterministic blue-noise
data. No NVIDIA data or NVIDIA download is required. An explicit caller-supplied
STBN volume is a separate asset and licensing choice.

## Configure, update and reset

All cloud settings live on `integration.context`. Useful first controls:

| Control | Meaning and mutation |
| --- | --- |
| `qualityPreset` / `applyQualityPreset` | `low`, `medium`, `high`, `ultra`, `lowEnd` (a fallback for low-end or contended GPUs, never the default); apply before individual overrides |
| `coverage` | Weather-map coverage, normally 0–1; assignment is not clamped |
| `cloudLayers[0..3]` | Four fixed lanes with metre-valued altitude/height and density profiles |
| `resolutionScale` | Cloud render-target scale, independent of renderer DPR |
| `enabled` | Disable cloud rendering without removing the composition |
| `experimental` | Port-only feature flags; inspect current defaults rather than assuming all are off |
| `debug` | Diagnostic view selection; use the union in the generated reference |

A context starts at the `high` preset. Applying a preset by construction,
property assignment or helper function has the same meaning. It copies values
without sharing mutable map-size vectors. The last-applied name remains visible
after local overrides; applying the same preset again restores its values.
Unknown names throw before mutation. Changed graph-shaping fields rebuild the
graph and reset history; equal assignments are no-ops.

Call `update({ time, frame, ... })` before rendering. Time is **seconds** and
frame is an explicit nonnegative safe-integer sample index. The helper never
advances either.
Camera transforms, world transform and celestial directions must be current
before that update. Render successive samples in separate browser animation
frames; several synchronous renders are not several FRAME-type node updates.

The atmosphere computes its initial lookup textures asynchronously during idle
callbacks. A fixed number of animation frames does not establish completion;
initial frames can still be dark. Setup diagnostics deliberately do not report
that work, shader compilation or a rendered frame as complete.

Call `resetHistory()` after camera jumps, discontinuous time seeks or other
changes for which old temporal samples are no longer useful. Do not recreate
the pass on every frame. See [default tables](docs/API.md#current-defaults) and
[experimental controls](docs/EXPERIMENTAL.md) for the larger surface.

## React lifecycle and loading

`useClouds().assets` reports `loading`, `ready` or `error`, plus an error value.
The adapter gates rendering while URL assets load or fail. `ready` establishes
CPU loading or supplied resources, not GPU upload, shader compilation or pixels.
Supplied textures and procedural generators remain caller-owned. Replacing URLs
or unmounting disposes adapter-created textures and ignores stale completions.
Omitting `stbnTexture` uses the context's lazy generated jitter without delaying
readiness when the other textures are supplied as objects. Unmount also disposes
the owned context's generated jitter, including replacements, after detaching
borrowed texture slots.

An explicit `enabled` prop wins. Without it, imperative `context.enabled`
changes survive rerenders and reloads, including writes during loading or errors.
Readiness gates the pass separately; it never overwrites `context.enabled` or
restores an older remembered value when loading completes.

The adapter preserves its pass across camera/depth changes. A composition helper
around it must still be recreated for a new camera/depth identity, as described
above. Pass and layer refs are cleared on unmount or replacement. Layer indices
are `0 | 1 | 2 | 3` and must be unique. Explicit indexes are reserved before
automatic allocation, regardless of sibling order. Automatic slots remain
stable when keyed children reorder, but move if a new or changed explicit
reservation needs their slot. A fifth layer, invalid index or duplicate explicit
index throws. See [React migration notes](docs/MIGRATION.md#react-layer-allocation-changes)
for computed indexes and validation before rendering. Removing a layer frees
its slot and restores the default, or an empty lane when
`disableDefaultLayers` is set.

## Teardown and failures

Stop the frame loop and detach the output before disposing the helper. Its
disposal is idempotent: it releases resources it created, not the supplied
renderer, scene pass, atmosphere, textures or borrowed cloud pass. It restores
only context providers that are still its own functions; later host changes
survive. Successful disposal does not undo intentional context parameter writes.
Failed setup rolls back its partial changes.

Then dispose the application's own geometry, materials, scene pass, atmosphere,
textures, pipeline and renderer as shown in the recipe. Do not dispose a shared
resource while another renderer or component still uses it.

For manual integrations, `pass.dispose()` does **not** dispose assigned context
textures. Legacy `CloudsContext.dispose()` **does** dispose assigned textures and
generators, even borrowed ones. Detach borrowed slots before calling it, and do
not dispose both a generator and its generated texture separately.

Catch renderer initialization and asset failures before starting the frame loop.
Call `assertWebGPUSupported(renderer)` after initialization, then inspect
`integration.diagnostics()` or the standalone `inspectCloudsSetup` result.
Diagnostics include stable codes, input paths and remedies. They do not render
or qualify pixels; [the readiness contract](docs/CONSUMER_CONTRACT.md) defines
exactly what each observation means.

## Auto-quality governor

Opt-in. `createQualityGovernor(context, options?)` registers a governor on
`context.qualityGovernor`; nothing changes until `governor.arm()`. The host
owns the clock: call `governor.update(frameMs)` once per frame with the delta
between two `requestAnimationFrame` timestamps. The library never reads a
clock itself.

```ts
const governor = createQualityGovernor(cloudsContext)
governor.arm()
let last: number | null = null
renderer.setAnimationLoop(time => {
  // ...update and render...
  if (last != null) governor.update(time - last)
  last = time
})
```

Levels, each written through the context's own setters, so a step rebuilds the
graph and resets the temporal history:

| Level | What it is | Values |
| --- | --- | --- |
| 0 | The context's settings at `arm()`, captured field by field | restored exactly, custom values and the preset name included |
| 1 | The perf map's c3, a shelved performance preset, as writes without a name | `temporalUpscale` true, `resolutionScale` 0.75, `lightShaftsHalfResolution` true, `haze` and `turbulence` off, `medium`'s march with `maxIterationCountToGround` 0, shadow `cascadeCount` 2, `updateInterval` 4, 256² map |
| 2 | The `lowEnd` preset | see the presets table in docs/API.md |

The defaults (`qualityGovernorDefaults`, every one an option) read vsync. A
frame is late when its interval exceeds `budgetMs` 24, which is a missed
vsync at 60 fps on a 60 Hz display (33 ms) and a three-interval frame on a
120 Hz one (25 ms). Under vsync the signal is quantised: a modestly
overloaded frame alternates between 16.7 and 33 ms rather than settling at
20, so the rules read windows, not runs. A step down follows when
`lateFraction` 0.5 of the last `stepDownFrames` 10 frames were late, which is
30 fps effective; a step up follows `stepUpFrames` 120 frames without a late
one; a step waits for at least `cooldownMs` 3000 of frame time since the
last, and the `settleFrames` 3 after a step are ignored, because the first
frame after a rebuild is unlit and slow. A frame presented on time reads the
same interval whether the GPU needed 4 ms or 16, so a clean window is not a
measurement of spare GPU time: a step up is a probe. A step down within
`revertWindowMs` 5000 of a step up doubles the next step-up wait, up to 16
times the cooldown, and a step up that holds resets it, so a level that
cannot hold is retried at 6, 12, 24 and 48 s rather than every 3 s.

Why not GPU time: three's `resolveTimestampsAsync` sums the spans of every
pass in the frame, and on a tile-based GPU those spans overlap, so it reported
about 8x the frame on an Apple M5 Pro under vsync while the interval read
16.7 ms. A host with a trustworthy per-frame GPU timer can feed that instead
and set `budgetMs` to its GPU budget; the governor does not care where the
number comes from.

`disarm()` restores level 0 and stops. `applyReferenceMode` disarms a
registered governor first, so a reference capture never runs on a stepped
context. `onStep` and `governor.events` report every change with the frame
index and the interval that decided it.

## WebGL fallback

This package needs WebGPU. The WebGL2 backend of `WebGPURenderer`
(`forceWebGL: true`) is not a fallback: it lacks 3D float texture filtering
and storage textures, `assertWebGPUSupported` refuses it, and a build on it
otherwise renders black with only a console error (see WEBGPU.md).

The fallback that works is at the application level: when `navigator.gpu` is
absent or grants no adapter, build the original `@takram/three-clouds` 0.7.6
(`CloudsEffect` and `AerialPerspectiveEffect` on a `WebGLRenderer` with
`postprocessing`) instead of this package. `recipes/webgl-fallback` is a
complete application that does this: one decision before any renderer exists,
two branches behind one handle, and one settings object for both, whose 66
keys are the WebGL property names the port kept verbatim (the rows
docs/MIGRATION.md marks ported, which a test holds the recipe to). Knobs the
port added (`time`, `frame`, `experimental`, `debug`, `cloudTypes`,
`qualityGovernor`) are ignored by the WebGL branch with one warning each.
The four baked textures and the jitter volume are plain three textures, so
`loadBakedCloudTextures` and `createJitterTexture` serve both branches.

What a consumer decides, not the recipe: the original is a different
renderer with a different look within the parity ladder's thresholds, and
without the port's opt-in features (cloud types, time of day, moonlight, rain
shafts, the cirrus deck, lightning, evolving weather, the governor, the
`lowEnd` preset). A fallback frame is a feature-reduced sky.

The Storybook Lab story `clouds/Clouds/Fallback` makes the same decision and
mounts the WebGPU Basic story or the WebGL reference's at one pose, with a
`backend` control that forces either branch.
