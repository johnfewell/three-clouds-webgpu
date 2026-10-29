# Migration guide — WebGL `CloudsEffect` → WebGPU `CloudsContext` / `clouds()`

A 1:1 key audit of `@takram/three-clouds` 0.7.6's `CloudsEffect` public surface
against this port's `CloudsContext` + `CloudsPassNode` + `clouds()`. Every public property/behaviour is mapped as **ported**
(same name), **dropped** (with reason), or a documented **addition**.

## Knob surface — generated, do not hand-edit

The table below is generated from `PARITY_KEYS` by
`examples/parity/src/parityState.test.ts` and compared verbatim by the
`final migration table matches docs/MIGRATION.md verbatim` test — the
document and the adapter can never drift apart.

<!-- MIGRATION-TABLE:BEGIN -->
| Key | WebGL | WebGPU | Status |
|---|---|---|---|
| coverage | true | true | ported |
| scatteringCoefficient | true | true | ported |
| absorptionCoefficient | true | true | ported |
| turbulenceDisplacement | true | true | ported |
| skyLightScale | true | true | ported |
| groundBounceScale | true | true | ported |
| powderScale | true | true | ported |
| powderExponent | true | true | ported |
| scatterAnisotropy1 | true | true | ported |
| scatterAnisotropy2 | true | true | ported |
| scatterAnisotropyMix | true | true | ported |
| correctAltitude | true | true | ported |
| resolutionScale | true | true | ported |
| temporalUpscale | true | true | ported |
| lightShafts | true | true | ported |
| shapeDetail | true | true | ported |
| turbulence | true | true | ported |
| haze | true | true | ported |
| localWeatherRepeat | true | true | ported |
| localWeatherOffset | true | true | ported |
| shapeRepeat | true | true | ported |
| shapeOffset | true | true | ported |
| shapeDetailRepeat | true | true | ported |
| shapeDetailOffset | true | true | ported |
| turbulenceRepeat | true | true | ported |
| localWeatherVelocity | true | true | ported |
| shapeVelocity | true | true | ported |
| shapeDetailVelocity | true | true | ported |
| clouds.maxIterationCount | true | true | ported |
| clouds.minStepSize | true | true | ported |
| clouds.maxStepSize | true | true | ported |
| clouds.maxRayDistance | true | true | ported |
| clouds.perspectiveStepScale | true | true | ported |
| clouds.minDensity | true | true | ported |
| clouds.minExtinction | true | true | ported |
| clouds.minTransmittance | true | true | ported |
| clouds.maxIterationCountToSun | true | true | ported |
| clouds.maxIterationCountToGround | true | true | ported |
| clouds.minSecondaryStepSize | true | true | ported |
| clouds.secondaryStepScale | true | true | ported |
| clouds.maxShadowFilterRadius | true | true | ported |
| clouds.maxShadowLengthIterationCount | true | true | ported |
| clouds.minShadowLengthStepSize | true | true | ported |
| clouds.maxShadowLengthRayDistance | true | true | ported |
| clouds.hazeDensityScale | true | true | ported |
| clouds.hazeExponent | true | true | ported |
| clouds.hazeScatteringCoefficient | true | true | ported |
| clouds.hazeAbsorptionCoefficient | true | true | ported |
| clouds.multiScatteringOctaves | true | true | ported |
| clouds.accurateSunSkyLight | true | true | ported |
| clouds.accuratePhaseFunction | true | true | ported |
| shadow.cascadeCount | true | true | ported |
| shadow.mapSize | true | true | ported |
| shadow.maxFar | true | true | ported |
| shadow.farScale | true | true | ported |
| shadow.splitMode | true | true | ported |
| shadow.splitLambda | true | true | ported |
| shadow.temporalPass | true | true | ported |
| shadow.temporalJitter | true | true | ported |
| shadow.maxIterationCount | true | true | ported |
| shadow.minStepSize | true | true | ported |
| shadow.maxStepSize | true | true | ported |
| shadow.minDensity | true | true | ported |
| shadow.minExtinction | true | true | ported |
| shadow.minTransmittance | true | true | ported |
| shadow.opticalDepthTailScale | true | true | ported |
<!-- MIGRATION-TABLE:END -->

`CloudLayer` ports all 11 reference keys verbatim: `channel`, `altitude`,
`height`, `densityScale`, `shapeAmount`, `shapeDetailAmount`,
`weatherExponent`, `shapeAlteringBias`, `coverageFilterWidth`,
`densityProfile`, `shadow`. `CloudsContext.cloudLayers` is the same
`CloudLayers.DEFAULT.clone()` the effect shipped.

## Dropped — with reasons

| WebGL | Reason | Decided by |
|---|---|---|
| Orthographic cameras (`OrthographicCamera`) | Not a porting gap — the reference does not support them either. The ray direction is derived from a view-space position (`clouds.vert:69-76`, ported at `cloudsFragment.ts:208-212`), valid only when every ray starts at the camera origin. Under an orthographic projection every pixel gets the same direction (measured spread **0.0436°** vs **43.57°** for perspective) and, since `cameraPositionECEF` is one uniform, the same origin — a 0.04-degree pinhole whose image can only be uniform. Needs per-pixel ray origins to support. | parity case 53 retired |
| `irradianceTexture`, `scatteringTexture`, `transmittanceTexture`, `singleMieScatteringTexture`, `higherOrderScatteringTexture` | Atmosphere LUTs belong to the `AtmosphereContext` — the node reads them from the renderer's context, not from the clouds object. | ADR-001 (render graph), ADR-012 (peer/atmosphere contract) |
| `events`, `atmosphereOverlay`, `atmosphereShadow`, `atmosphereShadowLength` | Replaced by node outputs: `layerNode`, `depthVelocityNode`, `cloudShadow`, `cloudShadowLength` (see Additions). | ADR-001 (graph membership) |
| `resolution`, `setSize()`, `CloudsEffectOptions` (`width`, `height`, `resolutionX`, `resolutionY`) | The pass sizes itself from the current frame (`resolutionScale` remains). | default `resolutionScale` 1 |
| `setDepthTexture(texture, depthPacking)` + the `DEPTH_PACKING` define | Replaced by the `clouds({ sceneDepth })` node option — WebGPU depth texture nodes are never packed. | AUDIT-3 signature ruling |
| `initialize()` | The pass initializes on first render; nothing to call. | - |
| `update(renderer, inputBuffer, deltaTime)` | The pass updates per render through `updateBefore`; time/frame are plain settable numbers on the context. | ADR-003 (time and frame) |
| `skipRendering` | Intentionally dropped: it only skipped the effect's own composite; `enabled = false` is the supported switch. | ADR-003 revision (source-map AUDIT: `CloudsEffect.ts:505–506` defaults it to true) |
| `cloudsPass`, `shadowPass`, `uniforms` | Renderer internals — not public in the node port. | ADR-003 |

## React layer allocation changes

The React adapter now rejects ambiguous or excess layer declarations instead
of silently dropping them. These are breaking changes from the earlier adapter:

- `CloudLayerProps.index` is now `0 | 1 | 2 | 3`, not `number`. A computed
  numeric index must be validated and narrowed before passing it. For a fixed
  list, use `[0, 1, 2, 3] as const`; omit `index` if slot identity does not matter.
- Duplicate explicit indexes, out-of-range indexes from JavaScript, and more
  than four mounted `CloudLayer` children throw during layout effects. Validate
  dynamic layer lists before rendering. Use a React error boundary for a UI
  fallback; a `try/catch` around JSX creation cannot catch an effect error.
- Explicit indexes are reserved before automatic allocation, regardless of
  sibling order. Adding or moving an explicit layer may move an automatic layer
  to another slot and update its ref. Use unique explicit indexes when a stable
  slot is required. Conditional children count only while mounted.

Validate a computed index rather than hiding an invalid value with a cast:

```ts
import type { CloudLayerProps } from 'three-clouds-webgpu/r3f'

function layerIndex(value: number): NonNullable<CloudLayerProps['index']> {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value
  throw new RangeError('Expected a cloud layer index from 0 through 3')
}
```

## Texture inputs

The texture setter names are unchanged. The 2D inputs (`localWeatherTexture`
and `turbulenceTexture`) accept `Texture | ProceduralTextureLike | null`.
The 3D inputs (`shapeTexture` and `shapeDetailTexture`) accept `Data3DTexture`,
`Storage3DTexture`, compatible `ProceduralTextureLike<Storage3DTexture>`
generators, or `null`. The port includes compute-backed generators:

```ts
import {
  clouds,
  CloudShape,
  CloudShapeDetail,
  LocalWeather,
  Turbulence
} from 'three-clouds-webgpu'

const cloudsPass = clouds({ sceneDepth: null })
const cloudsContext = cloudsPass.cloudsContext
cloudsContext.localWeatherTexture = new LocalWeather()
cloudsContext.shapeTexture = new CloudShape()
cloudsContext.shapeDetailTexture = new CloudShapeDetail()
cloudsContext.turbulenceTexture = new Turbulence()
```

Assign to your existing pass's context if one already exists. The pass renders
assigned generators before sampling them. Baked textures
remain available through `loadBakedCloudTextures`; `DEFAULT_*_URL` constants
are document-relative asset paths, not automatic package asset resolution.
See [Baked assets](../WEBGPU.md#baked-assets) for bundler URL imports.

## Additions — documented, not renames

| WebGPU | Note |
|---|---|
| `enabled` | Skips the march pass entirely (the composite path stays referenced). |
| `time`, `frame` | Plain settable numbers (ADR-003) — no clock baked into the library. |
| `warnings` | Toggle for the stale-frame / history diagnostics. |
| `resetHistory()` | Invalidates temporal history (resize, seek, knob rebuilds). |
| `debug` | The exported `DebugView` union: `'none'`, `'uv'`, `'sampleCount'`, `'marchIntervals'`, `'cascades'`, `'shadowMap'`, `'frontDepth'`, `'shadowLength'`, `'velocity'`. No WebGL counterpart. |
| `logarithmicDepthBuffer` | Logarithmic scene depth support via the depth node contract. |
| `clouds({ sceneDepth })` | Factory takes only the scene depth node (AUDIT-3); every knob lives on `CloudsContext`. |
| `layerNode`, `depthVelocityNode` | Texture-node outputs of the march (color + depth/velocity MRT). |
| `cloudShadow`, `cloudShadowLength` | Shadow descriptor + shadow-length node outputs — the WebGL side consumed these via `events.atmosphereShadow/ShadowLength`. |
| `aerialPerspectiveWithCloudShadow`, `CloudShadowedAtmosphereLightNode` | Cloud-shadowed aerial/light adapters for scene integration. |
| `dispose()` | The reference effect had none; the context owns disposable textures. |
| `experimental`, `cloudShape`, `cloudTypes`, `convectiveProfile`, `rainShafts`, `lightning`, `cirrusDeck` | Port-only opt-in features and their knobs, none with a WebGL counterpart. Every `experimental` option ships off except `cloudFrontRefinement` and `distantShapeDetailFade`, and the `cloudShape` controls ship neutral; the other knob objects are read only while their option is on. `applyReferenceMode` turns every option off and the shape controls neutral. [docs/EXPERIMENTAL.md](EXPERIMENTAL.md) is the reference for each. |
| `environment`, `cloudShadowAt()` | Pass outputs with no WebGL counterpart: the sky-plus-clouds cube map for `scene.environmentNode` (with `experimental.cloudEnvironment`) and the cloud-shadow sampler for your own materials (WEBGPU.md). |
| `shadow.updateInterval` | **Default 2**; 1 is the reference (the cloud shadow map every frame). N renders it every N frames and keeps the map, its cascade matrices and intervals as the consistent set they were rendered as in between — only the view-depth row the marches select cascades through follows the camera each frame. The temporal resolve's alpha compounds so the map converges per wall-clock frame as at 1 (1 − 0.99^N). A structure change or a history reset renders regardless. The shadow-map OD march is the single largest cloud cost at any resolution (~3.7 ms for 3 × 512² × 50 iterations on an Apple GPU), so 2 saves ~1.8 ms per frame on average; the price is that a moving camera can leave the newest sliver of the view unshadowed for up to N − 1 frames, and the map accumulates half as many jittered samples (parity ladder `shadow-temporal`: SSIM 0.966 → 0.954 against a 0.95 floor). |
| `lightShaftsHalfResolution` | **On by default**; `false` is the reference's per-fragment march. The light-shaft shadow length marched once per 2×2 block of march fragments through WebGPU quad operations — each fragment marches every fourth sample of its own ray and the block sums them (a 2×2 box filter of the shadow length, a quarter of the march's cost). Blocks only average fragments whose shadow segments are alike (near and far within a tenth of the segment), so the horizon and cloud silhouettes keep their edges. Needs the device's `subgroups` feature; ignored where it is missing. No WebGL counterpart. |

**Struck from the declared additions:** `temporalAntialiasing` was listed
as a planned addition but is intentionally not implemented, the reference
`CloudsEffect` exposes no such knob. Its resolve always runs
temporal (`cloudsResolve.frag:167`): `temporalUpscale` selects the Bayer
1/4-res upscale path vs the full-res TAA path (`temporalAntialiasing()`,
`cloudsResolve.frag:120`), and the port reproduces both paths under that same
`temporalUpscale` knob (`buildTemporalUpscale` / `buildTemporalAntialiasing`
in `src/resolve/cloudsResolve.ts`, wired in `CloudsPassNode.buildResolveGraph`).

## Rendering-contract differences (AUDIT-4)

- `AerialPerspectiveEffect.lightingMask` / `LightingMaskPass` are not drop-in
  APIs in this port. `aerialPerspectiveWithCloudShadow` accepts a caller-owned
  `lightingMaskNode` as its sixth argument. With `aerial.lighting = true`, a
  mask of 0 preserves self-lit surface color and 1 selects aerial post-lighting;
  intermediate values blend, clamped to [0, 1]. Atmospheric transmittance and
  inscatter apply in both cases. Avoid lighting a surface both through an
  `AtmosphereLight` and the aerial post-lighting path.
- `AerialPerspectiveNode.lighting` is graph wiring, not a `CloudsContext`
  runtime knob. The parity harness therefore selects `'post'` or `'lights'`
  when constructing a case, and has no `debugAerialLighting` or other probe
  `set()` toggle.
- Public layer altitudes and heights are in metres. Cloud render-target
  distance channels use scaled unit space (`metres × worldToUnit`, normally
  `metres / bottomRadius`). Built-in consumers convert them back, but custom
  readers of `depthVelocityNode` must do that conversion themselves. See
  [Units and frame inputs](../WEBGPU.md#units-and-frame-inputs).
