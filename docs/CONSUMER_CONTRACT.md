# Consumer setup, readiness and ownership

## Inspect before rendering

After `await renderer.init()`, call `assertWebGPUSupported(renderer)` from your
own setup code, where its exception is catchable. The assertion requires an
initialized native WebGPU backend. A backend object already exists before
initialization, and an unknown backend is not a supported backend.

```ts
import { assertWebGPUSupported, inspectCloudsSetup } from 'three-clouds-webgpu'

await renderer.init()
assertWebGPUSupported(renderer)
const inspection = inspectCloudsSetup({
  renderer,
  pass: cloudsPass,
  atmosphere,
  depthMode: 'scene'
})
for (const diagnostic of inspection.diagnostics) {
  console.log(diagnostic.code, diagnostic.path, diagnostic.remedy)
}
```

The inspector reads existing objects. It does not register providers, normalize
directions, load textures, allocate the default jitter volume, build a graph or
render. It calls the registered `getClouds` and `getAtmosphere` providers once;
those callbacks must be side-effect-free. Provider exceptions become diagnostics.
`atmosphere` is optional: supplying it additionally checks provider identity.

Each diagnostic has `code`, `severity`, `path`, `observed`, `message` and `remedy`.
Use the code and path for branching, not English message text. `warnings = false`
suppresses the pass's console warnings, not explicit inspection results.
Experimental prerequisite diagnostics reuse the pass's existing warning data.

| Readiness field | What the observation establishes |
| --- | --- |
| `configuration` | `valid` means none of the inspected checks produced an error, not that every possible configuration is supported |
| `assets` | `ready` means every required slot has an appropriate texture dimensionality and positive integer dimensions, not GPU upload or valid pixels |
| `graph` | Always `unobserved`: CPU inspection does not prove TSL or WGSL compilation |
| `frame` | Always `unobserved`: CPU inspection does not prove submitted work completed or produced correct pixels |

Missing or not-yet-decoded assets produce warnings and `assets: 'not-ready'`;
they do not alone invalidate configuration. A texture in the wrong dimensional
slot is an error. The base weather and shape slots are required while clouds
are enabled. Detail and turbulence are required only when their features are on.
The generated jitter default needs no asset load. An explicit jitter volume is
checked without generating a replacement. Disabled clouds require no textures.
Supplied procedural generators count as configured resources; their GPU contents
remain unobserved. Custom texture sizes are supported: baked-loader byte counts
are not imposed on caller-supplied textures.

`depthMode: 'scene'` requires `cloudsPass.sceneDepth`. Choose `'sky-only'`
explicitly to allow `null` depth: clouds then ignore terrain/object occlusion.
The scene and atmosphere must use the explicit camera assigned to the cloud
pass. Directions must be finite and nonzero; configure normalized ECEF sun
directions in both contexts and a moon direction when moonlight is enabled.
Exactly four layer slots must remain populated, with channels `r`, `g`, `b` or
`a`; zero-height slots are valid inactive lanes.

## Resource ownership

| Resource | Owner and cleanup |
| --- | --- |
| Renderer, camera, scene, scene pass | The application; an adapter must not dispose them or replace renderer policy |
| Atmosphere context | The application when supplied; its `dispose()` releases its LUT resources |
| Created cloud pass | Its creator; `pass.dispose()` releases pass targets, materials, placeholders and pass-owned effects, not the context's assigned texture slots |
| Borrowed existing cloud pass | Its original owner; an adapter must not dispose the pass or its context |
| Loader-created textures | The loader until successful resolution, then the caller; failure/cancellation must dispose successful and late-successful owned loads |
| Supplied/shared textures and generators | Their original owner unless ownership is explicitly transferred; detach before calling legacy context disposal |
| Generated default jitter | The context that generated it; `resolvedStbnTexture` observes the cache without allocating it |
| Renderer context providers | The installing code; restore only a provider still equal to the installed function, preserving unrelated fields and later host edits |

`CloudsContext.dispose()` is the legacy ownership-transfer operation: it disposes
every texture or generator still assigned to its slots, including resources
supplied from elsewhere. It also releases every jitter volume it generated,
even if that volume is no longer assigned. Assign borrowed
slots to `null` before using that operation. `pass.dispose()` does not call it.
Do not dispose a generator and its resolved texture separately.

`loadBakedCloudTextures(urls, { signal })` retains its four-texture result, safe
for `Object.assign(cloudsContext, baked)`. Cancellation rejects with `AbortError`;
successful resolution transfers ownership, so a later abort does not dispose
the returned textures. Image transport may continue after cancellation; late
results are ignored and disposed. In R3F, `useClouds().assets` reports
`loading`, `ready` or `error`. That readiness covers CPU loading/decoding only;
borrowed resources count as supplied, not GPU-validated.

The React adapter owns its pass and context. On unmount it detaches borrowed
slots before disposing the context and every jitter volume generated by that
context. Omitted jitter uses the lazy context default and does not delay initial
object-input readiness. Asset readiness gates rendering separately from the
public `enabled` value: imperative writes during loading remain effective once
assets become ready, unless an explicit `enabled` prop overrides them.

Composition adapters must allow at most one active integration per renderer and
per pass. Separate renderers may have independent integrations. Reject duplicate
ownership before changing providers or allocating resources. Cleanup must be
idempotent, release only created resources, preserve borrowed resources including
later host replacements, and release ownership for sequential reuse. These are
adapter requirements, not behavior added to low-level `clouds()`.

## Rendering policy stays explicit

### Canonical composition helper

`createCloudsIntegration` takes an existing initialized native WebGPU renderer,
perspective camera, atmosphere context, scene pass, explicit `lighting` mode and
texture slots. It returns `pass`, `context`, `aerial`, `output`, `diagnostics()`,
`update()`, `resetHistory()` and `dispose()`. Assign `output` to your own
`RenderPipeline.outputNode`. It creates no renderer, scene, clock or animation
loop, installs no scene lights, and changes no tone mapping or sky policy.

```ts
const integration = createCloudsIntegration({
  renderer,
  camera,
  atmosphere,
  scenePass,
  lighting: 'post',
  textures: { ...baked, stbnTexture: jitter },
  sunDirection
})
pipeline.outputNode = integration.output
integration.update({ time: elapsedSeconds, frame: sampleIndex })
pipeline.render()
```

In `post` mode the caller must configure the scene pass with
`mrt({ output, normal: normalView })` before construction. In `lights` mode
the helper only disables aerial post-lighting: the application's lights and
advanced cloud-shadowed receivers remain its responsibility, including
`prepareShadow()` before the scene pass when those receivers need the atlas.

Pass `cloudsPass: existingPass` for the R3F `useClouds().pass` path; the helper
does not create a second cloud pass. A new pass requires explicit `sunDirection`.
A borrowed pass may seed its existing finite, nonzero sun direction. Initial
world/sun values are copied into `integration.context`, which becomes the
authoritative state. Mutate that context or pass replacement values to
`update({ time, frame, sunDirection?, moonDirection?, worldToECEFMatrix? })`;
merely mutating a vector supplied during construction is not another input
channel. Every update copies the context's celestial directions and world
transform into the atmosphere. Directions are not normalized for you.

Camera movement, rotation and projection changes work on the original camera.
Update the camera's projection matrix after changing projection parameters.
Camera object, scene-pass and depth-node identities are fixed: dispose and
recreate the integration when replacing them. `update()` refuses changed camera
or depth identities rather than leaving the aerial graph bound to an old camera.
When reusing an already-rendered Three r184 pipeline, assign the replacement
`output` and set `pipeline.needsUpdate = true` before rendering again. Otherwise
the pipeline keeps its previously compiled graph. See the complete
[replacement sequence](../INTEGRATION.md#replacing-an-integration).
Textures and cloud quality/shadow settings remain configurable on `context`.
Use `resetHistory()` after discontinuous changes, not a hidden time heuristic.

Construction rejects invalid configuration or required assets that are not yet
CPU-ready before installing providers. `diagnostics()` inspects the current
state, not a construction-time snapshot; its graph/frame fields remain
`unobserved` even after rendering. A pass with an existing live `.composite()`
is rejected. The helper uses that same composition method; disposing its output
releases the cached entry, so a borrowed pass supports setup/cleanup/setup.

Successful `dispose()` is idempotent. It releases its composition, generated sky
resources, and any pass it created; it never disposes supplied textures,
procedural generators, renderer, scene pass, camera or atmosphere. A created
context owns every jitter volume it generates lazily, including replacements
after `stbnTexture = null`; context disposal releases those volumes even after
their slot has changed again. Explicitly supplied replacement textures remain
caller-owned. A borrowed pass and its context remain owned by their original
creator, including any jitter that context generates. Borrowed/current texture
slots are detached before legacy context disposal.

Provider cleanup restores only functions still equal to those installed by the
helper, preserving unrelated fields and later host replacements. Successful
cleanup does not undo intentional cloud or atmosphere parameter writes. Failed
construction restores borrowed input values and releases its partial resources
and ownership lease. Callers must stop rendering the disposed output; other
methods then throw a disposed-integration error.

The exposed `aerial` allows explicit sky policy before the first render. Upstream
sky nodes can fetch star assets by default. An offline daytime recipe must
disable its `SkyNode.showStars` and `showMoon`, and choose the atmosphere's
`raymarchScattering` policy explicitly rather than assuming the helper prevents
upstream network requests. Replacing the sky node does not transfer its ownership
to the helper.

The helper builds one `AerialPerspectiveNode` (the fork build, which takes
`shadowNode` and `lightingMaskNode`). The post path sets `shadowNode` to the
cloud-shadow transmittance with post-lighting on; the lights path leaves it null
with post-lighting off. Cleanup
captures the created sky and its sun/moon/stars children, because the supported
upstream sky node does not recursively dispose those children. Later replacements
are borrowed, not adopted.

The scene MRT contains scene color and normal, never the cloud pass's own
targets. Compose scene → aerial perspective → clouds → tone mapping. In `post`
lighting mode, aerial lighting handles unlit scene albedo; in `lights` mode,
scene materials are already lit and aerial post-lighting stays off. Do not light
the same surface twice. Forward-lit cloud shadow receivers need the current
shadow atlas prepared before the scene pass; `prepareShadow()` does not advance
cloud color history.

The caller owns time in seconds and an integer frame/sample index. The library
reads no clock and starts no animation loop. Update camera/world/sun inputs before
rendering and reset history after discontinuous seeks or camera jumps. Every
browser frame must be a separate animation frame for three's FRAME-type updates;
multiple synchronous renders do not imply multiple completed samples.

## Supported consumer boundary

Use ESM with a browser bundler and native WebGPU. The package's declared Three.js
range is `>=0.187.0 <0.188.0`; on r187 the `@takram` packages must be the fork builds
pinned with `overrides`, because the npm builds fail at import there. The complete
recipes pass TypeScript bundler resolution on stock r187. The existing NodeNext smoke test
covers a smaller surface and uses `skipLibCheck: true`; it does not qualify the
complete recipe under NodeNext, which encounters upstream missing-export errors.
Use the packed recipe checks for the exact dependency and compiler matrix rather
than inferring support from one successful import.

## Archive documentation and source

Archive verification rejects private maintenance identifiers and macOS user-home
paths in shipped Markdown. This is a consumer-documentation check, not a promise
that the source has been redacted. Shipped source and source-map contents retain
their original attribution, citations and historical annotations so provenance
can compare the exact source bytes. Those annotations are not prerequisites for
using the package; the bundled guides define the consumer contract.
