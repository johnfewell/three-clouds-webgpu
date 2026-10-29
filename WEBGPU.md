# three-clouds-webgpu

A WebGPU / TSL port of `@takram/three-clouds` — geospatial volumetric clouds
for three.js `WebGPURenderer`, composing with `@takram/three-atmosphere/webgpu`
and `@takram/three-geospatial/webgpu`.

## Installation

This port is not on npm. Pack a tarball from a clone and install it, as the
[install section](README.md#install) shows.

Peer dependencies:

- `three >= 0.184.0 < 0.187.0`, unpatched. Three 0.185 removed `struct().layout`, which the
  npm builds of `@takram/three-atmosphere` 0.19.1 and `@takram/three-geospatial` 0.9.1 read
  at import time, so on 0.185 they fail for every entrypoint
  ([three-geospatial#111](https://github.com/takram-design-engineering/three-geospatial/issues/111)).
  The fork builds (`0.19.1+fork.7` / `0.9.1+fork.7`, published as release assets of
  [johnfewell/three-geospatial](https://github.com/johnfewell/three-geospatial/releases/tag/fork-release-7))
  carry the upstream fix and import on stock 0.184 and 0.185. Release 3 also
  adds the `shadowNode` and `lightingMaskNode` inputs to `AerialPerspectiveNode`
  that the cloud-shadow adapter sets. Pin them with pnpm
  `overrides` in `pnpm-workspace.yaml`, as both recipes do, so exactly one copy of each
  package resolves. On 0.184 the npm builds install and typecheck only. Their
  `raySpheresIntersections` masks two lanes where the march needs four, so the package throws
  at load and names the fork build (`0.9.1+fork.7`), whose `forkBuild` marker it checks.
  On 0.186 only the fork builds from release 7 work: three r186 declares a node
  shared across branches in one branch only, which broke the atmosphere's scattering
  LUT before release 6. On r186 the package also checks that both packages'
  `forkBuild` markers set `r186Kernels` and name the same release, which only release 7's
  atmosphere build carries, and refuses anything else at load. `test/threeStructCompat.test.ts` installs the
  packed package into five consumers: fork builds on 0.184.0, 0.185.1 and 0.186.1, which import
  and typecheck, npm builds on 0.184.0, which typecheck and must refuse to load, and npm builds on
  0.185.1, which must fail at import. `test/threePeerRange.test.ts` pins the range.
- `@takram/three-atmosphere ^0.19.1`
- `@takram/three-geospatial ^0.9.1`

Use `@types/three` matching your three minor version. The packed-package checks use stock
three 0.185.1 with `@types/three` 0.185.0 and the fork builds; see the
[install section](README.md#install) for the consumer pins.
Those checks use TypeScript's `skipLibCheck: true` for upstream declaration
compatibility. This skips dependency declaration checking, not application
type checking.

## Baked assets

The tarball ships the four baked textures the loader fetches, at
`three-clouds-webgpu/assets/*`: `local_weather.png`, `shape.bin`,
`shape_detail.bin` and `turbulence.png`. They are the values behind
`DEFAULT_LOCAL_WEATHER_URL`, `DEFAULT_SHAPE_URL`, `DEFAULT_SHAPE_DETAIL_URL` and
`DEFAULT_TURBULENCE_URL`. These are document-relative `assets/...` strings,
not URLs resolved from the installed package. Serve the files at those paths
or supply your own URLs.

With a bundler supporting `?url` imports, load all four package assets:

```ts
import { clouds, loadBakedCloudTextures } from 'three-clouds-webgpu'
import localWeather from 'three-clouds-webgpu/assets/local_weather.png?url'
import shape from 'three-clouds-webgpu/assets/shape.bin?url'
import shapeDetail from 'three-clouds-webgpu/assets/shape_detail.bin?url'
import turbulence from 'three-clouds-webgpu/assets/turbulence.png?url'

const cloudsPass = clouds({ sceneDepth: null })
const cloudsContext = cloudsPass.cloudsContext
const baked = await loadBakedCloudTextures({
  localWeather,
  shape,
  shapeDetail,
  turbulence
})
cloudsContext.localWeatherTexture = baked.localWeatherTexture
cloudsContext.shapeTexture = baked.shapeTexture
cloudsContext.shapeDetailTexture = baked.shapeDetailTexture
cloudsContext.turbulenceTexture = baked.turbulenceTexture
```

Reuse this pass in the [Usage](#usage) wiring; if you already have a pass, use
its `cloudsContext` instead of creating another one.

Outside a bundler, `createRequire(import.meta.url).resolve('three-clouds-webgpu/assets/shape.bin')`
gives the path, which is what a postinstall copy script was doing by hand. Copy
them into your own `public/` only if you want them served from your origin: the
shape volume is 2 MB and the weather PNG is 680 KB. Content-hashed URLs allow
unchanged assets to retain their cache keys across rebuilds.

## Examples

The installed package includes complete [vanilla](recipes/vanilla/README.md)
and [R3F](recipes/r3f/README.md) recipes. Start there for a standalone project;
the [integration guide](INTEGRATION.md) explains the helper's ownership and
update contract. The examples below are repository development applications.

- **`examples/basic`** — the minimal consumer; its source is the Usage snippet
  below.
- **`examples/tiles`** — Google Photorealistic 3D Tiles with clouds, atmosphere,
  and cloud shadows on tiles via aerial perspective (`pnpm --filter tiles dev`).
- **`examples/r3f`** — the basic wiring through the React Three Fiber
  `<Clouds>` and `<CloudLayer>` components.
- **Storybook** — the authored Clouds stories (Basic, Custom Layers, World
  Origin Rebasing, Vanilla), Minimal Setup, and 3D Tiles over Tokyo, Fuji,
  London and Toronto, with the WebGL original's stories in the same sidebar,
  plus port-only sections: Experiments (one opt-in option per story), Cloud Types,
  Convection, Evolving Weather, Night, Cloud Environment, Custom Material
  Shadow, and the showcase stories for Lightning, Rain Shafts, Scene Presets
  and Static Mode. The [live Storybook](https://three-clouds-webgpu-demo.netlify.app)
  is available for visual review.
- **The parity showcase** — the 63-case A/B ladder (original WebGL chain
  vs this port) with SSIM/ΔE/histogram metrics per case:
  `examples/parity` (`pnpm --filter parity dev`, then `?case=<name>`).

## Usage

The canonical wiring — an MRT scene pass, the clouds
march consuming the scene depth node, a post-lit aerial perspective carrying
the cloud shadow, composite, tonemap:

```ts
// The minimal three-clouds-webgpu consumer. THIS FILE IS THE WEBGPU.md
// "Usage" SNIPPET: a test keeps the two identical, so the documented wiring
// can never drift from the demonstrated one. Canonical graph per ADR-001:
// MRT scene pass → clouds march → aerial perspective
// (post-lit) → composite → tonemap

import {
  Clock,
  Color,
  Matrix4,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  Vector2
} from 'three'
import {
  aerialPerspectiveWithCloudShadow,
  clouds,
  createCloudShadowTransmittance,
  createJitterTexture,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL,
  loadBakedCloudTextures,
  syncCelestialDirections,
  type GroundShadowExtraDeps
} from 'three-clouds-webgpu'
import {
  context,
  float,
  Fn,
  mrt,
  normalView,
  output,
  pass,
  uniform,
  uv,
  vec4
} from 'three/tsl'
import { RenderPipeline, WebGPURenderer, type Node } from 'three/webgpu'

import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import {
  depthToViewZ,
  inverseProjectionMatrix,
  inverseViewMatrix,
  projectionMatrix,
  screenToPositionView
} from '@takram/three-geospatial/webgpu'

const canvas = document.querySelector('canvas')!
const renderer = new WebGPURenderer({ canvas, antialias: false })
renderer.toneMapping = NeutralToneMapping
// explicit, as the parity harness sets it
renderer.toneMappingExposure = 1
// Without setSize the canvas keeps the HTML default 300x150, and the camera
// aspect below (from innerWidth/innerHeight) would disagree with it: the frame
// would be both tiny AND stretched
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
await renderer.init()

const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 100, 1e8)
// 2.5 km up, aimed at the horizon. From 20 km looking down, a cloud deck
// (tops ~2-3 km) is seen edge-on from far above and reads as almost nothing
// A low camera looking out shows the decks in profile against the sky
camera.position.set(0, 6378137 + 2500, 0)
camera.lookAt(6378137 * 0.35, 6378137 + 4000, 0)

// 1. Register the contexts on the renderer: every node resolves them from
// the renderer's contextNode (the atmosphere's 0.18+ contract)
const atmosphere = new AtmosphereContext()
// Read the precomputed scattering LUT (the WebGL original's method) instead of
// ray-marching it. See Performance
atmosphere.raymarchScattering = false
// The atmosphere needs the SCENE camera. Unset it falls back to the pass's quad
// camera, so cameraPositionUnit stays at the origin and the sky is integrated
// from the Earth's centre along a view-space ray: a hard wedge, one side black
atmosphere.camera = camera
// wired below
const cloudsPass = clouds({ sceneDepth: null })
const cloudsContext = cloudsPass.cloudsContext
renderer.contextNode = context({
  ...(renderer.contextNode?.value ?? {}),
  getAtmosphere: () => atmosphere,
  getClouds: () => cloudsContext
})

// 2. Scene pass writes color + normal MRT. The aerial node paints the sky over
//    every far-plane pixel, so the background is a plain clear, not a second sky
const scene = new Scene()
scene.background = new Color(0x000000)
const scenePass = pass(scene, camera, { samples: 0 })
scenePass.setMRT(mrt({ output, normal: normalView }))

// 3. The march consumes the scene depth node.
cloudsPass.sceneDepth = scenePass.getTextureNode('depth')
cloudsPass.camera = camera

// 4. The reference baked assets and the port's generated blue-noise jitter.
const baked = await loadBakedCloudTextures({
  localWeather: DEFAULT_LOCAL_WEATHER_URL,
  turbulence: DEFAULT_TURBULENCE_URL,
  shape: DEFAULT_SHAPE_URL,
  shapeDetail: DEFAULT_SHAPE_DETAIL_URL
})
Object.assign(cloudsContext, baked)
cloudsContext.stbnTexture = createJitterTexture()

// 4b. THE SUN. Without it the frame is BLACK WITH NO ERROR: both sun
// directions default to the zero vector, valid arithmetic through march, sky
// and shadow. 0.40 is local solar 09:36, and one call writes all three sinks
const timeOfDay = {
  date: new Date('2026-10-04T12:00:00Z'),
  location: { longitude: 0, latitude: 0 },
  timeOfDay: 0.4
}

// 5. Cloud-shadow transmittance: the deps mirror the march's uniforms.
const worldToECEFMatrixU = uniform(
  new Matrix4().copy(cloudsContext.worldToECEFMatrix)
)
const altitudeCorrectionU = uniform(cloudsContext.altitudeCorrection.clone())
const sunDirectionU = uniform(cloudsContext.sunDirection.clone())
const shadowDeps: GroundShadowExtraDeps = {
  viewMatrix: uniform(camera.matrixWorldInverse),
  cameraNear: uniform(camera.near),
  sunDirection: sunDirectionU,
  bottomRadius: float(cloudsContext.bottomRadius),
  ecefToWorldMatrix: uniform(
    new Matrix4().copy(cloudsContext.ecefToWorldMatrix)
  ),
  altitudeCorrection: altitudeCorrectionU,
  worldToUnit: uniform(1 / cloudsContext.bottomRadius),
  temporalJitter: uniform(new Vector2()),
  resolution: uniform(new Vector2().copy(cloudsContext.shadow.mapSize))
}
const transmittance = createCloudShadowTransmittance(
  cloudsPass.cloudShadow,
  shadowDeps,
  { enabled: true }
)

// 5b. One sun for the whole frame. A scene missing one of the three copies is
// unshadowed rather than broken, so they are written together. Call it again per
// frame with a new timeOfDay to move the sun. The library reads no clock
syncCelestialDirections(
  [
    {
      sunDirection: atmosphere.sunDirectionECEF,
      moonDirection: atmosphere.moonDirectionECEF
    },
    { sunDirection: cloudsContext.sunDirection },
    { sunDirection: sunDirectionU }
  ],
  timeOfDay
)

// 6. Aerial perspective, post-lit (ADR-001): the aerial node lights the whole
// frame. Unlit-albedo scenes use lighting = true, AtmosphereLight-lit scenes
// use CloudShadowedAtmosphereLightNode instead. Never both under one node.

// Two upstream @takram typing gaps, one small typed helper each: they come
// back as bare Node<T>, so the helpers are what let the graph below read as
// three's API. The values are a mat4 node and a vec3
interface Mat4NodeLike {
  mul: (v: unknown) => { xyz: Node<'vec3'> }
}

const toPositionView = (
  depth: Node<'float'>,
  viewZ: Node<'float'>
): Node<'vec3'> =>
  screenToPositionView(
    uv(),
    depth,
    viewZ,
    projectionMatrix(camera),
    inverseProjectionMatrix(camera)
  ) as unknown as Node<'vec3'>

const toWorldPosition = (posView: Node<'vec3'>): Node<'vec3'> =>
  (inverseViewMatrix(camera) as unknown as Mat4NodeLike).mul(vec4(posView, 1))
    .xyz

const sceneDepthTex = scenePass.getTextureNode('depth')
const aerialShadowNode = Fn(() => {
  const d = sceneDepthTex.r.toConst()
  const viewZ = depthToViewZ(d, camera)
  const posView = toPositionView(d, viewZ)
  const posWorld = toWorldPosition(posView)
  const posECEF = worldToECEFMatrixU.mul(vec4(posWorld, 1)).xyz
  return transmittance(posECEF.add(altitudeCorrectionU), float(0), float(0))
})()

const aerial = aerialPerspectiveWithCloudShadow(
  scenePass.getTextureNode('output'),
  sceneDepthTex,
  cloudsPass.cloudShadowLength,
  aerialShadowNode,
  scenePass.getTextureNode('normal')
)
aerial.lighting = true

// 7. Composite clouds over the aerial result, then tonemap.
const pipeline = new RenderPipeline(renderer)
pipeline.outputNode = cloudsPass.composite(aerial)

// 8. time/frame are plain numbers owned by the consumer (ADR-003), so no clock
// is baked into the library. resetHistory() invalidates temporal history
// (resize, seek, texture swap)
const clock = new Clock()
let frame = 0
// Temporal upscale and the shadow history converge over hundreds of frames,
// so wall-clock `time` never lets the march noise average out. 1/60 of real
// time stays converged and still looks alive, 0 gives a static frame
const TIME_SCALE = 1 / 60
void renderer.setAnimationLoop(() => {
  cloudsContext.time += clock.getDelta() * TIME_SCALE
  cloudsContext.frame = frame++
  // pipeline.render(), NOT renderer.render(): the pipeline owns
  // `outputNode` (clouds composited over aerial). A bare renderer.render()
  // throws every frame and draws nothing the pipeline composed
  pipeline.render()
})

// 9. Resize. This is the `resetHistory()` case the section above describes: the
// temporal accumulator is indexed in screen space, so reprojecting last frame's
// history into a differently-sized buffer smears until it re-converges
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  cloudsContext.resetHistory()
})

// On a backwards seek, invalidate the temporal history the same way:
// cloudsContext.resetHistory()
```

For light-source lighting instead of post-process lighting, register
`CloudShadowedAtmosphereLightNode` for `AtmosphereLight` and use
`aerialPerspective` with `lighting = false`. Do not post-light a surface already
lit by a light node. For mixed scenes, the cloud aerial adapter accepts an
optional sixth argument, `lightingMaskNode`: 1 selects post-lighting, 0 preserves
the surface's existing lighting. Intermediate values blend, clamped to [0, 1].
Atmospheric transmittance and inscatter apply regardless of the mask. Set
`lighting = true` to enable the masked post-lighting; false bypasses it entirely.
Without a mask, the original whole-frame lighting behavior is unchanged.
The node reads the mask inside its surface branch, so read a texture mask at an
explicit level (`scenePass.getTextureNode('lit').level(float(0)).r`), not with
an implicit sample.
The adapter sets `shadowNode` and `lightingMaskNode` on the fork build's
`AerialPerspectiveNode`; a hand-built node can set them directly.

For forward-lit scene captures that need the shadow atlas before the cloud
composite runs, call `cloudsPass.prepareShadow(renderer, camera)` after setting
the sample's time, frame, camera matrices, and cloud inputs. Keep those inputs
fixed through the following main render. This prepares shadows without advancing
cloud color history; the main render reuses that atlas. `resetHistory()`
invalidates the reuse. Ordinary post-process consumers need no extra call.

## Support matrix

| Backend / feature   | Status       | Notes                                                    |
|---------------------|-------------|-----------------------------------------------------------|
| WebGPU (native)     | Primary target | Rendering support is separate from feature-specific parity and experimental limitations. |
| WebGL2 (fallback)   | Unsupported | Call `assertWebGPUSupported(renderer)` — see below.         |
| Perspective camera  | **Full**    | The only projection the reference supports.                |
| Orthographic camera | Unsupported | Same as the reference — see below.                         |
| three 0.185.1, stock | Consumer baseline | With `@types/three` 0.185.0 and the fork atmosphere/geospatial builds pinned by `overrides`. Import/build checks and native installed-recipe checks are separate qualifications; workspace parity evidence does not substitute for either. |
| three 0.185.1 + npm `@takram` builds | Unsupported | The npm builds fail at import because r185 removed `struct().layout` ([three-geospatial#111](https://github.com/takram-design-engineering/three-geospatial/issues/111)). Use the fork builds. |
| three 0.184.0       | Supported | With the fork `@takram` builds (release 7) a packed consumer imports and typechecks. With the npm builds it installs and typechecks only: the package refuses to load, because their `raySpheresIntersections` masks two of the four lanes the march reads (`test/threeStructCompat.test.ts`). The recipes are qualified on 0.185.1 only. |
| three 0.186         | Supported, fork builds only | Stock 0.186.1 with `@types/three` 0.186.0 and fork release 7, which the package requires on r186. The npm builds fail at import as on 0.185. Qualified by the packed consumer in `test/threeStructCompat.test.ts`, the recipes and a hardware run of the parity ladder; the repository itself develops on 0.185.1. |
| Chrome on Apple Metal | Hardware tested | The local hardware checks use Chrome with `--enable-unsafe-webgpu`; this is not cross-browser qualification. |
| Edge / Safari / Firefox | Unverified | Native WebGPU availability alone does not establish this package's compatibility. |
| `subgroups` feature | Optional    | Only `lightShaftsHalfResolution` uses it (quad operations in the march); without it the flag is ignored and the shafts march per fragment. three requests the feature whenever the adapter offers it. |

### Orthographic cameras

Not a porting gap: the reference does not support them either, and the port
mirrors it. The ray direction is derived from a view-space position
(`clouds.vert:69-76`, ported at `cloudsFragment.ts:208-212`), which is only
valid when every ray starts at the camera origin. Under an orthographic
projection the inverse-projected point is dominated by the far plane, so every
pixel receives the same direction — and because `cameraPositionECEF` is a single
uniform, the same origin too. Measured across the full screen: a perspective
camera spreads **43.57°** of ray direction, an orthographic one **0.0436°**. The
result is a 0.04-degree pinhole, so the image can only ever be uniform.

Supporting them needs a per-pixel ray **origin** across the frustum with one
shared direction — the inverse of what the current construction provides.
Parity case 53 was retired for this reason.

## WebGL2 backend

### Refusing it

```ts
const renderer = new WebGPURenderer({ forceWebGL: true })
await renderer.init()
assertWebGPUSupported(renderer) // throws HERE, where you can catch it
```

**Call this yourself after `init()`.** `CloudsPassNode.setup()` also throws on a
WebGL backend, and that throw cannot refuse construction: `setup()` runs inside
three's node-build `try/catch`, which catches the error, re-emits it as a
`THREE.TSL: Error: …` console message, and finishes the build without the pass.

This document previously described the contract as "`CloudsPassNode.setup()`
throws at build time". That was literally true and practically false, and it was
measured: on a real WebGL2 run the message appears as
a console error with a `ContextNode.setup` stack, the page emits **zero**
`pageerror` events, the renderer reports itself as booted, and the frame comes
out **black**. A caller trusting the old wording got a silent black render
instead of an exception.

`assertWebGPUSupported` throws when it cannot read the backend at all, rather
than passing — `backend` is only populated by `init()`, so a pre-init call has
no evidence either way, and a quiet pass there is the same false all-clear in a
different place. The two failures carry different messages.


`WebGPURenderer` can run on a WebGL2 backend via
`new WebGPURenderer({ forceWebGL: true })`, and browsers without WebGPU
fall back to it automatically. TSL compiles to GLSL there.

The following features used by three-clouds-webgpu have **not been
verified** on the WebGL2 backend:

- `Data3DTexture` sampling (shape + detail 3D textures, STBN)
- MRT render targets with `count: 2` and `count: 3`
- `DataArrayTexture` render targets (shadow OD atlas)
- Integer-coordinate texture reads (STBN jitter)
- Half-float render targets
- `readRenderTargetPixelsAsync`

Rather than render incorrect output silently, the library throws a clear
error at graph-build time when the WebGL2 backend is detected:

```
three-clouds-webgpu: the WebGL2 backend of WebGPURenderer is not yet
verified. Use the native WebGPU backend, or see WEBGPU.md for the
support matrix.
```

If you need WebGL2 support and would like to help verify these features,
contributions are welcome.

## Frames

`WebGPURenderer` advances its node frame (`NodeFrame.frameId`) once per browser
animation frame, not per `renderer.render()` call. Every FRAME-type node —
three's scene `pass()`, the atmosphere LUT node and `CloudsPassNode` — runs its
`updateBefore` once per node frame, so calling `render()` several times inside
one JavaScript task re-uses the pass outputs of the first call. Consequences:

- A "warm-up" loop must yield to the browser between renders
  (`await new Promise(requestAnimationFrame)`), or only the first iteration
  marches. The parity harness (`examples/parity/src/main.ts`, `renderOnce`,
  `renderSequence`) does this; a plain `setAnimationLoop` app gets it for free.
- The first node frame after the graph is built renders the clouds pass in the
  same frame the atmosphere LUTs are computed; that frame can come out unlit.
  Render one more frame before reading anything back.
- Changing a graph-time knob (`clouds.debug`, `temporalUpscale`, …) takes
  effect on the next node frame; reading the layer target in the same task
  shows the previous graph.

## Performance

The figures in this section are **historical exploratory rAF measurements
(2026-09-04)**, not a cross-machine benchmark or proof that WebGPU is generally
faster. rAF timings are not GPU timestamps, and their reciprocals are not
measured display FPS. The reproducible old/new WebGL/WebGPU protocol, validity
checks, and hardware metadata are documented in [BENCHMARKS.md](docs/BENCHMARKS.md).
See [Known differences](README.md#known-differences) for the current
limitations. Historical timings do not qualify the installed tarball's speed.

Three settings outside this package decide a good part of a frame's cost. All
three are configured in the storybook (`examples/storybook/src/clouds/helpers/atmosphereContext.ts`,
the stories' scene setup) and measured on the Basic story at 2880×1800 on an
Apple GPU, 2026-09-04, paired in one run, rAF frame-time medians:

- **`AtmosphereContext.accurateShadowScattering` — set it to `false`.** It
  defaults to `true` in `@takram/three-atmosphere/webgpu`, a refinement the
  WebGL original does not have: with a light-shaft shadow length it takes three
  scattering lookups per pixel where the original's Bruneton runtime takes one
  shifted lookup (Eq. 17/18). `false` selects the original's model. −1.0 ms of
  a 12.0 ms frame; the frame is the same against the WebGL story either way
  (band means equal to 0.03/255) and the parity harness's shaft cases are
  identical to four decimals.
- **`AtmosphereContext.raymarchScattering` — set it to `false`.** It defaults
  to `true` in `@takram/three-atmosphere/webgpu`: the aerial perspective and the
  clouds' sun and sky lighting then ray-march the atmosphere's inscatter with 4–14
  jittered samples per pixel. `false` reads the precomputed scattering LUT,
  Bruneton's `GetSkyRadianceToPoint`, which is what the WebGL original does. This
  one was measured differently from the other two: paired GPU knockouts on the
  parity case `baseline-medium` at 1280×720 on a Mac mini (apple metal-3),
  2026-09-24, N = 5. Whole frame: **6.62 ms with the lookup,
  8.75 ms at the raymarch default**, and 38.62 ms with the parity harness's
  former 256-sample pin; the WebGL original 5.62 ms. Sample counts were
  identical in all arms. The Mac mini's GPU performance state moved light workloads
  by up to ~30 % between sessions, so read the ratios as approximate. The
  harness itself reads the LUT on every case but one, `below-deck-1km`: at
  +1000 m it sits inside the WebGPU lookup's near-ground endpoint lift (an
  upstream `@takram/three-atmosphere` behaviour) and keeps the raymarch
  ([ADR-013](docs/adr/013-atmosphere-source-of-truth.md) Amendment 6).
- **No sky on the scene background.** The aerial node paints its own sky (with
  the light shafts) over every far-plane pixel, so `scene.backgroundNode =
  skyBackground()` is computed only to be overwritten. The Usage snippet clears
  to a plain `Color` instead (alpha 1, like the sky it replaces). −0.3 ms; the
  frame is the same without it, sun disc and flare included.

Inside the package, two cost-reduction knobs are ON by default;
each has a one-line way back to the original's
behaviour (README, "Known differences"):

- **`shadow.updateInterval` (default 2; 1 is the original)** renders the cloud
  shadow map every other frame. The shadow-map optical-depth march is the largest single cloud cost at
  any resolution (~3.7 ms for 3 × 512² × 50 iterations on an Apple GPU; the
  reference pays the same), and the map is temporally accumulated over ~100
  frames, so a static frame is unchanged (band means within 0.3/255). What it
  costs: a moving camera can leave the newest sliver of the view unshadowed for
  a frame. Measured: −1.8 ms per frame on average (10.65 → 8.6 ms at 2880×1800;
  6.3 → 4.5 at 1440×900); the frame time alternates between the two modes, both
  well inside a 60 Hz budget.
- **`lightShaftsHalfResolution` (default true; `false` is the original's
  per-fragment march)** marches the light shafts' shadow length once per 2×2
  quad — see the API section. −0.6 ms at 2880×1800.

With both on, the Basic story measures **7.7 ms against the WebGL original's
9.6 ms at 2880×1800** and 4.5 against 6.5 at 1440×900, same
run, quiet machine, 2026-09-04.
## Changes from the WebGL API

The node port keeps every `CloudsEffect` knob name from
`@takram/three-clouds` 0.7.6 — the full 1:1 mapping, including the generated
knob table, lives in [`docs/MIGRATION.md`](docs/MIGRATION.md). What does **not**
carry over, each with its reason:

| WebGL | Replacement / reason |
|---|---|
| LUT texture props (`irradianceTexture`, `scatteringTexture`, `transmittanceTexture`, `singleMieScatteringTexture`, `higherOrderScatteringTexture`) | Read from the scene's `AtmosphereContext` — not clouds-object inputs. |
| `events` + `atmosphereOverlay` / `atmosphereShadow` / `atmosphereShadowLength` | Node outputs instead: `layerNode`, `depthVelocityNode`, `cloudShadow`, `cloudShadowLength`. |
| `resolution` / `setSize()` / size options (`width`, `height`, `resolutionX`, `resolutionY`) | The pass sizes itself from the frame; `resolutionScale` remains. |
| `setDepthTexture(texture, depthPacking)` + `DEPTH_PACKING` | The `clouds({ sceneDepth })` node option — WebGPU depth texture nodes are never packed. |
| `initialize()` | The pass initializes on first render. |
| `update(renderer, inputBuffer, deltaTime)` | `updateBefore` per render; `time`/`frame` are plain settable numbers on the context. |
| `skipRendering` | Intentionally dropped (ADR-003 revision) — it only skipped the effect's own composite; `enabled = false` is the supported switch. |
| `cloudsPass`, `shadowPass`, `uniforms` | Renderer internals — not public. |

Additions beyond the WebGL API: `enabled`, `time`, `frame`, `warnings`,
`resetHistory()`, `debug`, `logarithmicDepthBuffer`, `dispose()`, the node
outputs above, `aerialPerspectiveWithCloudShadow` and
`CloudShadowedAtmosphereLightNode`.

Two contract differences worth knowing (AUDIT-4):

- `AerialPerspectiveEffect.lightingMask` / `LightingMaskPass` are not ported
  as drop-in APIs. `aerialPerspectiveWithCloudShadow` instead accepts an
  optional `lightingMaskNode` for per-surface post-lighting selection, as
  described above. The caller supplies the mask and avoids double lighting.
- Cloud render-target distance channels are stored in unit space
  (`metres × worldToUnit`), not metres. Built-in consumers convert them back;
  custom readers of `depthVelocityNode` must follow the channel contract below.

A third, found later: **WGSL is strict where GL is forgiving about
screen-space derivatives.** Anything derivative-based — `dFdx`/`dFdy`, mip selection, and
*implicit-LOD texture sampling* — is undefined in non-uniform control flow, i.e.
inside a march loop, a PCF loop, or any `If`/`Break`. GLSL carries the same
formal rule, but GL drivers return usable values, so the WebGL original can do
exactly this and be correct while the faithful translation silently fails.
Dawn returns **zeros** rather than garbage, so the symptom reads as "the feature
is switched off", not "the feature is wrong": the cloud shadow went from 21 % of
pixels to 2 % with SSIM unmoved in the 4th decimal.

In the port this means an atlas read inside the march uses an explicit LOD —
`.sample(uv).level(float(0))`, i.e. `textureSampleLevel` — which is filtered
(unlike `textureLoad`) and derivative-free (unlike a bare sample), and is exactly
equivalent on a texture with no mip chain. The diagnostic fingerprint: a
top-level read such as a debug view is unaffected while the in-loop consumers
change tenfold. If those two disagree, suspect derivatives before suspecting the
data.

## API

### Units and frame inputs

World-space distances, including `CloudLayer.altitude`, `CloudLayer.height`
and `CloudsContext.bottomRadius`, are **metres**. A context starts with four
layer slots; the first has altitude 750 and height 650, so its band runs from
750 to 1400 metres above `bottomRadius` (default 6360000 metres). A standalone
`new CloudLayer()` instead starts empty, with altitude and height both zero.
Keep the four slots; set a slot's height to zero to disable it.

Atmosphere LUT coordinates use the atmosphere's `parametersNode.worldToUnit`
scale (normally metres to kilometres). That is not the cloud attachment
scale: cloud distances stored in half-float targets use `worldToUnit`, normally
`1 / bottomRadius`. In `depthVelocityNode`, `.r` is the front distance in that
scaled unit and `.gb` is UV velocity; custom readers divide the distance by
the cloud scale to recover metres. Do not scale non-distance channels.

Set `time` to elapsed seconds and advance `frame` once per rendered frame,
including when `time` is held still for a static cloud field. Both start at
zero. The library reads these inputs and never advances them for you.

### Surface summary

`three-clouds-webgpu` keeps the WebGL `CloudsEffect` property names verbatim —
the complete 1:1 mapping (generated table, drops with ADR citations,
additions) is [`docs/MIGRATION.md`](docs/MIGRATION.md). Surface summary:

- **`clouds(options: { sceneDepth })`** → `CloudsPassNode` — the only
  factory argument is the scene depth node; every knob lives on
  `cloudsPass.cloudsContext`.
- **`CloudsContext`** — all `CloudsEffect` knobs by their WebGL names, plus
  the additions: `enabled`, `time`, `frame`, `warnings`, `debug`,
  `logarithmicDepthBuffer`, `resetHistory()`, `dispose()`.
- **Outputs** — `layerNode`, `depthVelocityNode` (march MRT),
  `cloudShadow` (cascaded shadow descriptor), `cloudShadowLength`
  (light-shaft length node), and `environment` (the sky-plus-clouds cube map
  for `scene.environmentNode`, with `experimental.cloudEnvironment` on; see
  [Clouds In Reflections](#clouds-in-reflections)).
- **Shadow consumers** — `aerialPerspectiveWithCloudShadow`,
  `CloudShadowedAtmosphereLightNode`, `createCloudShadowTransmittance`, and `cloudsPass.cloudShadowAt` for your own
  materials (below).
- **Textures** — `loadBakedCloudTextures` (the same baked assets as the
  original), `createJitterTexture` (the deterministic blue-noise jitter volume the
  vanilla API defaults to, generated from an MIT void-and-cluster rank map; see
  [ADR-009](docs/adr/009-stbn-jitter-volume.md)), and
  `createHashJitterTexture` (the earlier white-noise hash, which the parity
  harness keeps).
  To sample NVIDIA's STBN exactly as the original does, load it yourself and
  assign it — the file comes from upstream's repository under NVIDIA's terms,
  nothing is bundled here:

  ```ts
  import { DEFAULT_STBN_URL, STBNLoader } from '@takram/three-geospatial'
  cloudsContext.stbnTexture = await new STBNLoader().loadAsync(DEFAULT_STBN_URL)
  ```

  The r3f `<Clouds>` also defaults to the port's generated blue-noise volume,
  with no jitter fetch. Its `stbnTexture` prop accepts an explicit URL or a
  `Data3DTexture` if you want a different volume. Either way the swap is live:
  the pass re-syncs its texture node every frame, so a replacement after the
  first build takes effect on the next frame. The generated default is not
  NVIDIA's STBN dataset.
### Cloud shadow on your own materials

The cloud shadow normally reaches the scene through the aerial-perspective post
pass, which lights the ground. A water, vegetation, particle or custom lit
material reads it directly:

```ts
import { positionWorld } from 'three/tsl'

material.colorNode = albedo.mul(pass.cloudShadowAt(positionWorld))
```

`cloudsPass.cloudShadowAt(worldPosition)` returns the **sun transmittance** in
`0..1` — `1` fully lit, `0` fully shadowed — so it multiplies a sun-facing term
rather than being added to one. It is the aerial consumer's own sampler (cascade
selection, PCF, `exp(-od)`) behind a world → ECEF conversion, so a material and
the ground beneath it agree by construction. Nothing is built until you call it,
so an unused call site cannot change a pixel.

Two optional arguments, both defaulted: `radius` (a PCF radius in shadow texels,
`DEFAULT_SHADOW_RADIUS`) and `shadowSampleCount` (taps per fetch, 8). The aerial
consumer computes a per-pixel adaptive radius with `createGetShadowRadius`
instead; pass it as `radius` to match it exactly.

`createCloudShadowNode(deps)` is the same graph as a builder, for when the nine
uniforms are yours to supply. The pass method assembles them from the pass's own
march, parameter and camera uniforms, which is why it needs no per-frame upkeep.

- **`time` / `frame` contract (ADR-003)** — plain settable numbers owned by
  the consumer; no clock or `deltaTime` is baked into the library. The
  context does not advance them; set both per frame (see Usage step 8).

## React Three Fiber

`three-clouds-webgpu/r3f` exports `<Clouds>`, `<CloudLayer>` and `useClouds()`.

`<Clouds>` owns **state and lifecycle only** — it builds the pass, keeps
`CloudsContext` in sync with props, hosts `<CloudLayer>` children, and publishes
the pass through React context. **The app composes it.** That differs from the
WebGL package, where `<Clouds>` is a `<primitive>` inside `<EffectComposer>`,
and the difference is forced: there is no `CloudsEffect` here, and no r3f
context for a WebGPU/TSL post chain to read a camera from
(`@takram/three-atmosphere` ships `./r3f` and `./webgpu`, but no `webgpu/r3f`).
Rather than invent a composer abstraction the library does not have, the pass is
handed to the app:

```tsx
import { PostProcessing } from 'three/webgpu'
import { Canvas, useThree } from '@react-three/fiber'
import { CloudLayer, Clouds, useClouds } from 'three-clouds-webgpu/r3f'

function Composite({ sceneColor }) {
  const { pass } = useClouds()
  const renderer = useThree(state => state.gl)
  useEffect(() => {
    const post = new PostProcessing(renderer)
    post.outputNode = pass.composite(sceneColor) // <- the composite call
    return () => post.dispose()
  }, [renderer, pass, sceneColor])
  return null
}

<Clouds sceneDepth={sceneDepth} coverage={0.35} time={time} frame={frame}>
  <CloudLayer altitude={750} height={650} />
  <Composite sceneColor={sceneColor} />
</Clouds>
```

Note that the reference's `<Clouds>` does not own its composer either —
`<EffectComposer>` does. The division of labour is the same; only the thing
doing the composing changed.

### `time` and `frame` in r3f

`<Clouds>` takes **no clock**. `time` and `frame` are plain props forwarded to
the context, per [ADR-003](docs/adr/003-time-frame-wind.md): `time` drives wind
as `base + velocity * time`, and `frame` drives the Bayer phase (`frame % 16`)
and the STBN slice, so a given pair renders the same pixels no matter how it was
reached.

The component deliberately does **not** advance them from `useFrame`. Doing so
would reintroduce the `offset += velocity * deltaTime` accumulator that ADR-003
exists to remove, and would make a seek non-reproducible — the same frame index
would render differently depending on how the app arrived at it. A consumer
animating clouds sets both from its own clock, which is also what makes a
deterministic capture possible.

### Not yet wired: `AtmosphereContext`

The WebGL `<Clouds>` reads `sunDirection`, `worldToECEFMatrix` and the
atmosphere textures from `@takram/three-atmosphere/r3f`'s `AtmosphereContext`,
and publishes its overlay/shadow back into that context's transient state.
Nothing in this package integrates that context yet, and the atmosphere package
has no `webgpu/r3f` entry to follow. Until it does, `<Clouds>` exposes
`sunDirection` and `worldToECEFMatrix` as ordinary props (copied onto the
context, since both are readonly there). This is a stated gap, not an oversight:
an app combining clouds with the atmosphere r3f components has to pass those two
values itself.

## Experimental Rendering

The rendering experiments live on `cloudsContext.experimental`, and most are
opt-in. `cloudFrontRefinement` and `distantShapeDetailFade` are the defaults now;
`docs/EXPERIMENTAL.md` is the reference, with the cost and the trade-offs of each
one, including which ones ship on.

Beside those switches sit two helpers that are not options: `syncCelestialDirections`
writes the sun and the moon into the atmosphere, the clouds and the shadow deps
from one place and one instant (the `Usage` snippet above uses it), and
`applyScenePreset` combines a solar time of day, a cloud-type preset, coverage and
haze in one call. Both are described in
[docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md#whole-scene-helpers-which-are-not-options).

### Compare In Storybook

The experiment stories are included on main. Run Storybook from your checkout:

```bash
pnpm build
pnpm --filter clouds-storybook dev --port 6008
```

Open `http://localhost:6008/?path=/story/clouds-webgpu-experiments--cloud-front-refinement`.
The **clouds / Experiments** stories reuse the authored Basic and Custom Layers
scenes, with one experiment selected per story. In Controls, switch
**Comparison** between **Baseline** and **Experiments**. Baseline bypasses all
the experiments without clearing the selected switches or moving the camera;
switching back restores those selections. Allow temporal history to settle
after each switch.

The same controls are available in the ordinary authored cloud stories, where
the switches start at the library defaults: `cloudFrontRefinement` and
`distantShapeDetailFade` on, the rest off. The Wind Reprojection story animates shape and
detail together at 20 m/s, with weather evolution stopped. The Distant Cloud
Shadows story sets the sun march iteration limit to zero to isolate its
fallback; that setting is held fixed in both comparison modes. Compute Resolve
is primarily a performance experiment, not an intended visual change.

With Storybook running, exercise the actual comparison controls and check
desktop/mobile canvas pixels using Chrome with WebGPU:

```bash
node examples/storybook/scripts/experimental-smoke.mjs
```

Screenshots are written to `test-results/storybook-experiments/`. Override
`STORYBOOK_URL` when using another port.

### Clouds In Reflections

`scene.environmentNode` gets whatever the environment node says, and with
takram's `skyEnvironment()` that is the sky alone, so water and glossy materials
reflect a cloudless sky. `experimental.cloudEnvironment` adds the clouds:

```ts
const cloudsPass = clouds({ sceneDepth })
cloudsPass.cloudsContext.experimental = { cloudEnvironment: true }
scene.environmentNode = cloudsPass.environment
```

`cloudsPass.environment` is a cube map of the sky with a low-resolution march of
the same clouds composited over it, at its own step budget and its own cube
camera, on the same uniforms the frame marches. It reads back `null` until the
option is on and the graph has been built, and reference mode pins it off, so
the parity ladder never sees it.

The bake refreshes every `updateInterval` frames, and immediately on the first
frame, on a graph rebuild, after a kilometre of camera movement, after a 0.1
degree sun move, or when you call `cloudsPass.environment.refresh()`. Call
`refresh()` for a change you cannot wait out the schedule for, such as a preset
the user just picked. `bakeCount` counts the refreshes, which is how the
Storybook story splits its frame times by whether a refresh landed on that frame.

For Water Pro, `WaterProCloudSky` adapts the same bake into the equirect sky
that package samples for its fog and reflections; see
[docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md#water-pro).

The example is Storybook `clouds-webgpu/Cloud Environment`: a metal sphere at
zero roughness, whose whole colour is the map, beside a plate at 0.2 roughness,
which is the blurred PMREM read a PBR scene's ambient actually uses. Turn the
option off in the library and both surfaces fall back to the sky, which is the
comparison the option is for.

The cost is six marches of `size` squared texels at 32 steps, every fourth
frame: a spike on one frame in four, not a steady tax, so it has to be measured
with the display refresh cap lifted. Measured on the hardware GPU at 1280x900,
two runs per arm of 240 frames, the option costs about 2.1 ms a frame amortised,
about 8.5 ms a refresh.
[docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md) has the table, the method and the
aliasing the fixed size costs.

### Context Options

The experiments are available on the context. `cloudFrontRefinement` and
`distantShapeDetailFade` default to `true`; all other options default to
`false`. Assigning a partial object preserves
the other settings. Each one is described with its cost in
[docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md), which is the full list; the
renderer experiments are summarised below, and the sky features (cloud types,
weather, convection, rain shafts, moonlight, lightning, static mode and the
cirrus deck) are described there only. A changed setting rebuilds the graph and
resets temporal history.

```ts
cloudsPass.cloudsContext.experimental = {
  cloudFrontRefinement: true,
  computeResolve: true,
  windReprojection: true,
  distantCloudShadows: true,
  directionalSkylight: true,
  distantShapeDetailFade: true
}
```

- `cloudFrontRefinement` (default on): four bisection steps locate an empty-to-dense
  boundary using actual extinction. This adds density lookups and changes
  the integration positions; it is not a free quality increase.
- `computeResolve`: 8x8 workgroups share neighbourhood samples for cloud
  colour, shaft length, and temporal shadow-map resolve. Both full-resolution
  TAA and Bayer upscale are supported. Colour debug views retain the fragment
  resolve. Small floating-point differences from texture filtering remain.
- `windReprojection`: shape-offset motion contributes to cloud velocity.
  Compatible detail motion is required. Weather evolution, incompatible detail,
  coordinate-domain changes, rewinds, and time steps over 0.5 seconds reject
  cloud history. Shaft history is rejected while clouds move because its
  motion differs from cloud motion. This does not advect shadow-atlas history.
- `distantCloudShadows`: a covered shadow-map estimate replaces the constant
  optical-depth fallback when the sun march takes zero steps. At least one
  cloud layer must cast shadows for this option to have an effect. Outside map
  coverage it preserves the original fallback. Valid zero optical depth is
  distinct from missing coverage.
- `directionalSkylight`: two horizon samples drive a normalized degree-two
  angular ambient term. This is a constrained two-lobe approximation, not a
  full nine-coefficient spherical-harmonic reconstruction or a physically
  complete multiple-scattering model. Isotropic and black skies stay neutral.
- `cloudEnvironment`: bakes the sky plus a low-resolution cloud march into a
  cube map for `scene.environmentNode`, refreshed on a schedule and on demand.
  See [Clouds In Reflections](#clouds-in-reflections).
- `distantShapeDetailFade` (default on): the shape-detail contribution fades out
  with mip level instead of switching off at a threshold, so small distant clouds
  keep their large-scale shape without the aliased speckle the reference's binary
  choice produces past roughly 40 km. Distant clouds then differ from the
  reference by design, which is why the ladder pins it off.

### Shape Options

Four shape controls are magnitudes rather than switches, so they live on
`cloudsContext.cloudShape` and are neutral at zero. Every magnitude is a
graph-time literal, so changing one rebuilds the march: set them at setup
rather than per frame.

```ts
cloudsPass.cloudsContext.cloudShape = {
  baseShadowStrength: 1.4,
  horizonCoverageAmount: 0.25
}
```

- `baseShadowStrength`, `baseShadowHeight`: darken the base of a layer by the
  Beer extinction of the cloud above a sample, so a base reads darker than its
  top. The sun march already attenuates the direct term; this is the part its
  truncated step budget misses.
- `horizonCoverageAmount`, `horizonCoverageStart`, `horizonCoverageRamp`: add
  coverage with distance from the camera, so a distant sky reads more overcast
  than the weather map alone gives it. A negative amount thins the distance
  instead. Only the primary march has a view distance, so the sun march and the
  shadow map are untouched.
- `windSkewEast`, `windSkewNorth`: lean cloud tops by metres at the top of a
  layer, along the local east and north. The lean displaces the shape lookup
  only, and fades out at a pole where the east axis is undefined.
- `erosionShape`: scales the shape carve, so edges go thin and wispy above zero
  and rounded and solid below it.

`applyReferenceMode` pins all four to neutral, which is where they ship, so the
parity ladder never sees them. `docs/EXPERIMENTAL.md` has the cost and the
trade-offs of each.

The four are rows in the off-versus-off bracket suite, so the run that proves
each one moves pixels past its own noise is:

```bash
PARITY_GPU=hardware pnpm e2e --grep 'every opt-in visual option'
```

These options are experimental, not new parity defaults. They do not change
the acceptance thresholds and a picture captured with one on is not the
reference contract. `cloudFrontRefinement` and `distantShapeDetailFade` ship on for
library users, and the parity ladder still runs the reference's choices because
reference mode pins both off. `directionalSkylight` stays opt-in: with it on,
building the whole pass graph throws, because the skylight term reads the
atmosphere's indirect-luminance struct and that is null without a builder
context. Run the local hardware checks with:

```bash
PARITY_GPU=hardware pnpm e2e --grep 'experimental options|compute agrees|wind reprojection follows|GPU timing includes'
```

The timing test reports both render and compute GPU timestamps using an ABBA
order. Its numbers are device- and workload-specific, not a speedup guarantee.

## Testing

```bash
pnpm test     # vitest — CPU twins + WGSL snapshots, no GPU needed
pnpm e2e      # Playwright + Chrome WebGPU on a real GPU (local; not run in CI)
pnpm gates    # oxlint complexity <= 13, Fn decision points <= 12,
              # comment audit, citations — the port's own bars
```

Unit tests live next to their modules (`*.test.ts`); every shader `Fn` ships
a CPU twin and a WGSL snapshot. Test logs land in `test-results/unit/`
(pass `TEST_LOG=1` to mirror them to stdout). The parity ladder — 63 A/B
cases against the original WebGL chain — lives in `examples/parity` with
per-case metrics; its evidence is `parity/results/` (captures need a real
GPU: `PARITY_GPU=hardware pnpm --filter parity capture`).
