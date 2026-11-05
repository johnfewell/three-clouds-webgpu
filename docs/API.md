# API reference: three-clouds-webgpu 0.1.0-alpha.8

Generated from this version’s public TypeScript surface, JSDoc and runtime defaults. Start with recommended integration; the advanced and reference groups remain exported for compatibility, not as required setup steps.

Signatures show full type names without machine-local module qualifiers. Source links preserve the complete declarations and imports.

Initial expressions come from source fields, constructor parameter defaults or a getter’s backing field. They are not evaluated and may be overridden by construction or options. Blank cells mean there is no single initializer; the current-default tables resolve the preset and layer definitions.

Import the vanilla surface from `three-clouds-webgpu` or `three-clouds-webgpu/webgpu`. Import React bindings only from `three-clouds-webgpu/r3f`; React is not required by the vanilla entrypoint.

[Integration guide](../INTEGRATION.md) · [Advanced WebGPU wiring](../WEBGPU.md) · [Migration](MIGRATION.md) · [Experimental options](EXPERIMENTAL.md)

- [Recommended integration and configuration](#recommended-integration-and-configuration)

- [Advanced composition](#advanced-composition)

- [Experiments](#experiments)

- [Reference and testing support](#reference-and-testing-support)

- [React adapter](#react-adapter)

- [Current defaults](#current-defaults)

## Recommended integration and configuration

### createCloudsIntegration

[Source](../src/integration.ts#L489)

```ts
createCloudsIntegration(options: CloudsIntegrationOptions): CloudsIntegration
```

Compose an initialized renderer's scene, atmosphere and clouds
Borrows renderer, camera, atmosphere, scene pass and supplied textures
Owns its composition and optional new pass, never disposes a supplied pass
Camera/depth identities stay fixed, their transforms and context values stay live
Call update with your own time/frame before rendering, then dispose on teardown

### CloudsIntegration

[Source](../src/integration.ts#L71)

```ts
interface CloudsIntegration
```

A composition lease, not a renderer, clock or asset owner

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `pass` | `CloudsPassNode` |  | No additional contract documented; see source |
| `context` | `CloudsContext` |  | No additional contract documented; see source |
| `aerial` | `AerialPerspectiveNode` |  | No additional contract documented; see source |
| `output` | `CloudsCompositeNode` |  | Assign to the caller's pipeline, stop rendering it before disposal |
| `diagnostics` | `() => CloudsSetupInspection` |  | Inspect current CPU inputs, never infer graph compilation or frame completion |
| `update` | `(inputs: CloudsIntegrationUpdate) => void` |  | Call before rendering, sync context-owned sun/world/moon to the atmosphere |
| `resetHistory` | `() => void` |  | Explicit temporal reset for seeks, camera jumps and other discontinuities |
| `dispose` | `() => void` |  | Release owned composition/pass resources, never borrowed inputs |

### CloudsIntegrationOptions

[Source](../src/integration.ts#L45)

```ts
interface CloudsIntegrationOptions
```

Explicit composition inputs, with no renderer or scene policy defaults

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `renderer` | `WebGPURenderer` |  | No additional contract documented; see source |
| `camera` | `PerspectiveCamera` |  | Perspective camera only, mutate in place or rebuild to replace it |
| `atmosphere` | `AtmosphereContext` |  | No additional contract documented; see source |
| `scenePass` | `PassNode` |  | Fixed depth-node identity, with output and view-normal MRT for post mode |
| `lighting` | `"post" \| "lights"` |  | No additional contract documented; see source |
| `textures` | `CloudsIntegrationTextures` |  | No additional contract documented; see source |
| `cloudsPass` | `CloudsPassNode \| undefined` |  | No additional contract documented; see source |
| `sunDirection` | `Vector3 \| undefined` |  | Required for a new pass, otherwise defaults to the borrowed context |
| `worldToECEFMatrix` | `Matrix4 \| undefined` |  | Copied into the context, identity means world positions are ECEF metres |

### CloudsIntegrationTextures

[Source](../src/integration.ts#L36)

```ts
type CloudsIntegrationTextures = Pick<
  CloudsContext,
  | 'localWeatherTexture'
  | 'shapeTexture'
  | 'shapeDetailTexture'
  | 'turbulenceTexture'
> & { stbnTexture?: Data3DTexture | null }
```

Borrowed resources, including procedural generators, never disposed here

### CloudsIntegrationUpdate

[Source](../src/integration.ts#L62)

```ts
interface CloudsIntegrationUpdate
```

Caller-owned seconds and sample index, with optional authoritative inputs

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `time` | `number` |  | No additional contract documented; see source |
| `frame` | `number` |  | No additional contract documented; see source |
| `sunDirection` | `Vector3 \| undefined` |  | No additional contract documented; see source |
| `moonDirection` | `Vector3 \| undefined` |  | No additional contract documented; see source |
| `worldToECEFMatrix` | `Matrix4 \| undefined` |  | No additional contract documented; see source |

### clouds

[Source](../src/CloudsPassNode.ts#L2148)

```ts
clouds(options: CloudsOptions): CloudsPassNode
```

Create the cloud pass. The one factory of the package, so
`instanceof CloudsPassNode` holds for every cloud graph.

```ts
const cloudsPass = clouds({ sceneDepth })
cloudsPass.cloudsContext.time = elapsed
cloudsPass.cloudsContext.frame = frameIndex
```

Nothing is uploaded until the first render: the pass initializes itself, so
there is no `initialize()` to call and no size to pass.

**remarks**: Requires: register this pass's context with the renderer before rendering
Ownership: the caller must release the pass and its context separately

### CloudsContext

[Source](../src/CloudsContext.ts#L120)

```ts
class CloudsContext
```

Every knob of the WebGL `CloudsEffect` under its original name, plus this
port's additions. One context belongs to one pass: read it as
`cloudsPass.cloudsContext`.

Most properties are plain numbers you may assign per frame. Graph setters
ignore unchanged values, but reapplying a preset restores its overrides
A property whose documentation says it rebuilds the graph additionally bumps
`graphVersion` and clears temporal history, which is why the graph-shape
fields have real setters instead of being plain public fields.

**remarks**: Units: world distances are metres and time is seconds, not an internal clock
Requires: register this pass's context as the renderer's getClouds provider
Ownership: dispose() releases assigned textures, including borrowed ones
Detach borrowed slots before disposal and release the pass separately

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `id` | `number` | `contextIdCounter++` | Creation order, for telling two contexts apart in a log |
| `cameraUniforms` | `CameraUniforms` | `new CameraUniforms()` | The camera uniforms the pass binds itself. Fullscreen passes never use the<br>TSL camera builtins, so the scene camera is bound here by<br>`updateCamera`. |
| `cloudLayers` | `CloudLayers` | `CloudLayers.DEFAULT.clone()` | The four cloud layers, as a fixed four-element array, with heights in<br>metres. Structural changes, such as activating an empty layer, rebuild the<br>graph through `checkLayerStructure`. Numeric magnitudes are uniforms |
| `localWeatherRepeat` | `Vector2` | `new Vector2().setScalar(100)` | How often each texture tiles across the sky, per unit of its offset space.<br>Larger numbers mean finer detail. A change mid-flight is a domain change,<br>which is one of the things `windReprojection` rejects history for. |
| `shapeRepeat` | `Vector3` | `new Vector3().setScalar(0.0003)` | No additional contract documented; see source |
| `shapeDetailRepeat` | `Vector3` | `new Vector3().setScalar(0.006)` | No additional contract documented; see source |
| `turbulenceRepeat` | `Vector2` | `new Vector2().setScalar(20)` | No additional contract documented; see source |
| `localWeatherOffset` | `Vector2` | `new Vector2()` | The base sampling offset of each texture. Combined with its velocity and<br>`time` into the `derived*` offsets, which is what the shader reads. |
| `shapeOffset` | `Vector3` | `new Vector3()` | No additional contract documented; see source |
| `shapeDetailOffset` | `Vector3` | `new Vector3()` | No additional contract documented; see source |
| `localWeatherVelocity` | `Vector2` | `new Vector2()` | Wind, in offset units per second. This is the advection the clouds move by,<br>so it is also what `windReprojection` reprojects against. |
| `shapeVelocity` | `Vector3` | `new Vector3()` | No additional contract documented; see source |
| `shapeDetailVelocity` | `Vector3` | `new Vector3()` | No additional contract documented; see source |
| `derivedLocalWeatherOffset` | `Vector2` | `new Vector2()` | What the shader reads: the base offset plus velocity times `time` |
| `derivedShapeOffset` | `Vector3` | `new Vector3()` | No additional contract documented; see source |
| `derivedShapeDetailOffset` | `Vector3` | `new Vector3()` | No additional contract documented; see source |
| `localWeatherTexture` | `Texture<unknown, TextureEventMap> \| ProceduralTextureLike<Texture<unknown, TextureEventMap>> \| null` |  | The local weather map, or the generator that draws it. The getter returns<br>whichever was set, so a procedural texture has to be driven each frame<br>through `renderProceduralTextures`. The `resolved*` getters are what<br>the uniforms bind. |
| `shapeTexture` | `Data3DTexture \| Storage3DTexture \| ProceduralTextureLike<Storage3DTexture> \| null` |  | The base 3D shape volume, or its generator. Same pairing as<br>`localWeatherTexture`. |
| `shapeDetailTexture` | `Data3DTexture \| Storage3DTexture \| ProceduralTextureLike<Storage3DTexture> \| null` |  | The high-frequency 3D detail volume, or its generator. Only sampled when<br>`shapeDetail` is on. |
| `turbulenceTexture` | `Texture<unknown, TextureEventMap> \| ProceduralTextureLike<Texture<unknown, TextureEventMap>> \| null` |  | The 2D curl noise the shape noise is displaced by, or its generator. Only<br>sampled when `turbulence` is on. |
| `resolvedLocalWeatherTexture` | `Texture<unknown, TextureEventMap> \| null` | `null` | The plain texture behind `localWeatherTexture`, generator or not |
| `resolvedShapeTexture` | `Data3DTexture \| Storage3DTexture \| null` | `null` | The plain texture behind `shapeTexture`, generator or not |
| `resolvedShapeDetailTexture` | `Data3DTexture \| Storage3DTexture \| null` | `null` | The plain texture behind `shapeDetailTexture`, generator or not |
| `resolvedTurbulenceTexture` | `Texture<unknown, TextureEventMap> \| null` | `null` | The plain texture behind `turbulenceTexture`, generator or not |
| `renderProceduralTextures` | `(renderer: Renderer) => boolean` |  | Fill any procedural texture that still needs it. Each generator clears its<br>own needsRender, so calling this every frame is cheap, as the reference<br>does (CloudsEffect.ts:473-476). Returns whether any generator re-filled |
| `stbnTexture` | `Data3DTexture` |  | The spatial-temporal blue-noise volume the march jitters with, built on<br>first read. Assign your own to sample NVIDIA's STBN as the original does.<br>Assign `null` to fall back to the generated volume again |
| `resolvedStbnTexture` | `Data3DTexture \| null` | `null` | The cached jitter volume, without triggering its lazy generation |
| `coverage` | `number` | `0.3` | How much of the weather map becomes cloud. 0 is clear sky, 1 overcast<br>Domain: normally [0, 1], assignment is not validated or clamped<br>Mutation: a per-frame uniform, with no graph rebuild |
| `scatteringCoefficient` | `number` | `1` | Scattering coefficient of the participating medium |
| `absorptionCoefficient` | `number` | `0` | Absorption coefficient of the participating medium |
| `turbulenceDisplacement` | `number` | `350` | How far the turbulence noise displaces the shape noise, in metres |
| `skyLightScale` | `number` | `1` | Multiplier on the sky's contribution to cloud lighting |
| `groundBounceScale` | `number` | `1` | Multiplier on light bounced off the ground into cloud bases. 0 turns ground<br>bounce off, which also removes the ground march. |
| `powderScale` | `number` | `0.8` | Strength of the powder darkening in dense, shadowed cloud |
| `powderExponent` | `number` | `150` | Height falloff of that powder darkening |
| `scatterAnisotropy1` | `number` | `0.7` | No additional contract documented; see source |
| `scatterAnisotropy2` | `number` | `-0.2` | No additional contract documented; see source |
| `scatterAnisotropyMix` | `number` | `0.5` | No additional contract documented; see source |
| `resolutionScale` | `number` | `defaults.resolutionScale` | March resolution as a fraction of the frame. Below 1 costs quality |
| `convectiveProfile` | `ConvectiveProfileParams` | `{<br>    ...convectiveProfileDefaults<br>  }` | No additional contract documented; see source |
| `rainShafts` | `RainShaftParams` | `{<br>    ...rainShaftDefaults<br>  }` | No additional contract documented; see source |
| `cirrusDeck` | `CirrusDeckParams` | `{<br>    ...cirrusDeckDefaults<br>  }` | No additional contract documented; see source |
| `evolvingWeather` | `EvolvingWeatherParams` | `{<br>    ...evolvingWeatherDefaults<br>  }` | No additional contract documented; see source |
| `cloudShape` | `CloudShapeParams` | `{ ...cloudShapeDefaults }` | The opt-in shape controls: a darker base, a horizon coverage bank, a wind<br>shear and one rounded-to-wispy edge knob. A plain field, like<br>`convectiveProfile`, because every magnitude is a graph-time literal<br>(src/experimental/cloudShape.ts). Neutral is all zeros, so an untouched<br>context reads as the reference.<br><br>`checkCloudShape` polls it, which the pass calls each frame itself |
| `lightning` | `LightningState \| null` | `null` | The lightning flash lighting the cloud from inside, or `null` for none. A<br>plain field, not a setter: its parts feed uniforms written every frame, so a<br>flash costs no graph rebuild. Read it only when experimental.lightning is on.<br><br>`position` is ECEF metres and belongs inside the cloud volume. `intensity`<br>is 0 whenever no flash is lit. Never reads a clock: the consumer decides<br>when a flash is, and when its envelope has decayed. |
| `cloudTypes` | `CloudTypes` | `new CloudTypes()` | Regional cloud-type controls, used when `experimental.cloudTypeMap` is on |
| `experimental` | `Readonly<ExperimentalCloudOptions>` | `experimentalDefaults` | Renderer experiments. `cloudFrontRefinement` and `distantShapeDetailFade`<br>default to true, all others to false. See docs/EXPERIMENTAL.md<br><br>Assign a partial object to preserve other options. Unknown keys and<br>non-boolean values throw. Changes rebuild the graph and reset history |
| `proceduralWeather` | `ProceduralWeather \| null` | `null` | The generator the flag installed, or null. Read-only on purpose: the<br>pattern and octave counts are graph time, so changing them means building<br>your own and assigning it to `localWeatherTexture` |
| `lightShafts` | `boolean` | `defaults.lightShafts` | Whether cloud shadow length is marched and read by the aerial consumers |
| `lightShaftsHalfResolution` | `boolean` | `PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION` | Whether the shaft march runs once per 2x2 quad rather than per fragment.<br>Needs the `subgroups` feature, on by default. Measured, not identical: dE P95<br>0.056-0.071 (2-3x the inert floor, ~8% of the case's A-vs-B mean), not<br>visible at DPR 1, and 7.2-20.0 ms per frame at 1280x720 on the shaft cases. |
| `haze` | `boolean` | `defaults.haze` | Whether the haze layer is marched alongside the clouds |
| `temporalUpscale` | `boolean` | `true` | Whether the resolve runs at the march resolution and upscales (Bayer,<br>`true`) or at the frame resolution (full-resolution TAA, `false`). The<br>temporal accumulation runs either way. `true` is cheaper and softer,<br>`false` is sharper and costs more. |
| `shapeDetail` | `boolean` | `defaults.shapeDetail` | Whether the high-frequency detail volume contributes at all. Off is<br>cheaper and smoother at distance, and every layer's `shapeDetailAmount`<br>stops mattering. |
| `turbulence` | `boolean` | `defaults.turbulence` | Whether the curl noise displaces the shape noise |
| `debug` | `DebugView` | `'none'` | The diagnostic view the resolve writes, or `'none'` for the shaded image |
| `clouds` | `CloudsPresetFields` | `Object.defineProperties(<br>    { ...defaults.clouds },<br>    {<br>      multiScatteringOctaves: {<br>        get: () => this.multiScatteringOctaves,<br>        set: (value: number) => {<br>          this.multiScatteringOctaves = value<br>        }<br>      },<br>      accurateSunSkyLight: {<br>        get: () => this.accurateSunSkyLight,<br>        set: (value: boolean) => {<br>          this.accurateSunSkyLight = value<br>        }<br>      },<br>      accuratePhaseFunction: {<br>        get: () => this.accuratePhaseFunction,<br>        set: (value: boolean) => {<br>          this.accuratePhaseFunction = value<br>        }<br>      }<br>    }<br>  )` | The march-side preset fields. Writing here configures this instance;<br>material parameters use the same setters as their top-level counterparts. |
| `shadow` | `ShadowPresetFields` | `{<br>    ...defaults.shadow,<br>    mapSize: defaults.shadow.mapSize.clone()<br>  }` | The shadow-side preset fields, flattened the same way |
| `shadowMaps` | `CascadedShadowMaps \| null` | `null` | The cascaded shadow maps, created by the pass. A caller may replace or<br>dispose it, but `syncShadowMaps` writes the split settings back into<br>whatever is here every frame, so `shadow.*` stays the only place to set<br>them. |
| `worldToECEFMatrix` | `Matrix4` | `new Matrix4()` | World space to ECEF. Set this once for your scene's coordinate frame |
| `ecefToWorldMatrix` | `Matrix4` | `new Matrix4()` | Inverse of `worldToECEFMatrix`, from `updateCamera` |
| `altitudeCorrection` | `Vector3` | `new Vector3()` | The offset that puts the camera on the ellipsoid, from updateCamera |
| `sunDirection` | `Vector3` | `new Vector3()` | Normalized ECEF sun direction. The zero default is not a usable sun<br>Requires: synchronize atmosphere and shadow consumers with the same sun<br>Mutation: copy components into this vector before rendering |
| `ellipsoid` | `Ellipsoid` | `Ellipsoid.WGS84` | The ellipsoid the projection and altitude correction assume |
| `sunAngularRadius` | `number` | `0.004675` | Sun angular radius in radians, which the sun disc and penumbra use |
| `moonDirection` | `Vector3` | `new Vector3()` | Normalized ECEF moon direction, required when experimental.moonlight is on |
| `moonGain` | `number` | `1` | Artistry over the physical moon-to-sun irradiance ratio, which is 2.5e-6<br>at full moon and far below what a fixed exposure shows |
| `moonColor` | `Vector3` | `new Vector3(1, 1, 1)` | The colour the moonlight carries, usually cooler than the sun's |
| `lightDirection` | `Vector3` | `new Vector3()` | The march's light direction: the sun's, or the moon's once twilight has<br>faded the sun out. Written by `updateMoonlight` |
| `moonIrradianceRatio` | `Vector3` | `new Vector3()` | The moon's irradiance as a fraction of the sun's, in `moonColor`.<br>Written by `updateMoonlight` |
| `bottomRadius` | `number` | `6360000` | Radius at which a ray is treated as hitting the surface, in metres |
| `correctAltitude` | `boolean` | `true` | Whether `updateCamera` applies the altitude correction offset |
| `cameraHeight` | `number` | `0` | Camera height above the ellipsoid, in metres, from `updateCamera` |
| `time` | `number` | `0` | Seconds of cloud motion to show. This is a pure function input, not a<br>clock: set it from your own and never let the library advance it. Wind is<br>derived from it as base offset plus velocity times `time`. |
| `frame` | `number` | `0` | Which frame this is. Must advance every frame while `temporalUpscale` is<br>on, or the resolve reprojects against stale history. See the `time` and<br>`frame` contract in WEBGPU.md.<br>Domain: an integer sample index supplied once per rendered frame |
| `warnings` | `boolean` | `true` | Whether the context may warn on the console, a stale frame for example |
| `enabled` | `boolean` | `true` | Whether the pass marches at all. `false` compiles the composite to a<br>pass-through, so it rebuilds the graph and, when turned back on, clears<br>history. The supported switch, where the dropped `skipRendering` is not. |
| `logarithmicDepthBuffer` | `boolean` | `false` | Whether `sceneDepth` is a logarithmic depth buffer, which the scene ray<br>distance must undo. Set it to match the renderer. |
| `graphVersion` | `number` | `0` | How many times the graph shape has changed. The pass folds this into its<br>cache key, so a rebuilt node is a different program. Watch it to know when<br>a rebuild happened. |
| `checkLayerStructure` | `() => boolean` |  | Poll the layer set's graph-time shape and rebuild if it moved. Returns<br>whether it did. The pass calls this itself each frame, so an application<br>only needs it when it changes a layer outside its own render loop. |
| `checkCloudShape` | `() => boolean` |  | Poll the four shape controls and rebuild if any moved. Every magnitude is a<br>graph-time literal, so this covers a value changing while its feature is<br>already on, not only the zero crossing. |
| `checkLocalWeatherChannels` | `() => boolean` |  | Poll which weather channels the four layers read and rebuild if that<br>changed, since the channel swizzle is compiled in |
| `checkShadowStructure` | `() => boolean` |  | Poll the shadow fields that are compiled rather than uniform, and clear<br>history if any moved. `syncShadowMaps` covers the rest of<br>`shadow.*`. |
| `syncShadowMaps` | `() => void` |  | Copy `shadow.splitLambda`, `shadow.splitMode`, `shadow.maxFar`,<br>`shadow.farScale`, `shadow.cascadeCount` and `shadow.mapSize` into<br>`shadowMaps`. The pass calls this once per shadow pass, so the<br>`shadow.*` fields are the only place those values need to be set. |
| `updateOffsets` | `() => void` |  | Weather is a pure function of `time`. Set `time` from your own clock.<br>Computes derived offsets: base + velocity × time. Call once per frame<br>before the march pass reads the offset uniforms. |
| `updateCamera` | `(camera: Camera) => void` |  | Per-frame camera update: ECEF transform, altitude correction, cameraHeight.<br>Call once per frame before the march pass. Mirrors<br>CloudsEffect.updateSharedUniforms() and CloudsMaterial.copyCameraSettings()<br>from the reference. |
| `updateMoonlight` | `() => void` |  | Retargets `lightDirection` and `moonIrradianceRatio` for the<br>frame. Idempotent and cheap, so every per-frame caller may run it: with<br>the option off it copies the sun's direction and leaves the ratio zero,<br>which is the reference's light |
| `updateShadowMaps` | `(camera: Camera) => void` |  | No additional contract documented; see source |
| `groundBounce` | `boolean` |  | Whether the ground-bounce march runs, which needs<br>`groundBounceScale` positive and `clouds.maxIterationCountToGround`<br>above zero. Polled by `checkGroundBounce`. |
| `checkGroundBounce` | `() => boolean` |  | Rebuild if `groundBounce` flipped, since it changes the march |
| `graphFlags` | `() => { shapeDetail: boolean; turbulence: boolean; lightShafts: boolean; lightShaftsHalfResolution: boolean; haze: boolean; temporalUpscale: boolean; accurateSunSkyLight: boolean; accuratePhaseFunction: boolean; multiScatteringOctaves: number; scatterAnisotropy1: number; scatterAnisotropy2: number; scatterAnisotropyMix: number; localWeatherChannels: string; layerStructure: string; shadowCascadeCount: number; shadowTemporalJitter: boolean; shadowTemporalPass: boolean; castsShadow: boolean; groundBounce: boolean; logarithmicDepthBuffer: boolean; debug: DebugView; experimentalFlags: number; cloudShape: string; }` |  | Every graph-shape fact as one plain object, which is what<br>`CloudsPassNode.customCacheKey` hashes. Useful to a caller that wants<br>to know whether a change is a uniform write or a rebuild. |
| `qualityPreset` | `QualityPreset` |  | The last preset applied. The setter writes every field that preset names,<br>so assigning a preset is the way to switch quality rather than copying<br>fields yourself. Explicit overrides leave this name unchanged, and applying<br>the same preset again restores its values. Unknown names throw `RangeError`.<br>Mutation: changed graph fields rebuild, equal values preserve graph/history |
| `qualityGovernor` | `QualityGovernor \| null` | `null` | The auto-quality governor registered by `createQualityGovernor`, or null.<br>Opt-in: nothing steps until the host arms it and feeds frame times.<br>`applyReferenceMode` disarms it, restoring the captured settings. |
| `multiScatteringOctaves` | `number` | `defaults.clouds.multiScatteringOctaves` | How many octaves of multiple scattering are summed. 0 is single |
| `accurateSunSkyLight` | `boolean` | `defaults.clouds.accurateSunSkyLight` | Whether the ground-bounce irradiance reads the atmosphere LUT per sample<br>(`true`) or a once-per-frame interpolation (`false`). Accurate costs more<br>and changes little. |
| `accuratePhaseFunction` | `boolean` | `defaults.clouds.accuratePhaseFunction` | Whether the phase function uses the accurate approximation (`true`) or the<br>cheaper dual-lobe one (`false`) |
| `registerResetHistory` | `(callback: () => void) => void` |  | Register the pass's history-clearing callback. Called by the pass |
| `resetHistory` | `() => void` |  | Drop the temporal accumulation, so the next frame reads no history. Call<br>it after anything that invalidates the previous frame's image: a jump in<br>position, a swap of the weather textures, or a change to a graph-shape<br>property, which already calls it for you. |
| `dispose` | `() => void` |  | Release generated jitter volumes and any texture still assigned here<br>Assigned textures are disposed even when borrowed, so transfer ownership<br>deliberately or detach borrowed slots before calling |

### CloudsPassNode

[Source](../src/CloudsPassNode.ts#L289)

```ts
class CloudsPassNode
```

The cloud pass owns its march and resolve targets. The scene MRT contains
scene color and normals, not the cloud outputs:

```ts
scenePass.setMRT(mrt({ output, normal: normalView }))
const cloudsPass = clouds({ sceneDepth: scenePass.getTextureNode('depth') })
cloudsPass.camera = camera
pipeline.outputNode = cloudsPass.composite(aerial)
```

The graph order is scene MRT, cloud march, aerial perspective with sky,
then cloud composite. WEBGPU.md shows the complete context and aerial
wiring. The output nodes exist before the first build and stay live

**remarks**: Requires: initialized native WebGPU, scene camera, cloud and atmosphere providers
Mutation: replacing camera or depth rebuilds the graph and resets history
Ownership: dispose() releases pass resources, not assigned context textures
The renderer, scene, camera and atmosphere remain caller-owned

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `cloudsContext` | `CloudsContext` | `new CloudsContext()` | Every knob. This is the object an application configures |
| `environment` | `CloudEnvironmentNode` | `new CloudEnvironmentNode()` | The sky plus a low-resolution cloud march, as a cube map node. Assign it to<br>`scene.environmentNode` (or sample it) to have reflections carry clouds.<br>Reads back null until `experimental.cloudEnvironment` is on and the graph<br>has been built. |
| `layerRT` | `RenderTarget<Texture<unknown, TextureEventMap>, RenderTargetEventMap>` |  | The march render target, shared with the pass. Treat it as read-only: its<br>attachment count follows `lightShafts`, so it is reallocated when that<br>changes. |
| `layerNode` | `CloudsTextureNode` |  | The shaded cloud colour the composite reads |
| `depthVelocityNode` | `CloudsTextureNode` |  | The march's second attachment: front distance times `worldToUnit` in `.x`<br>and UV velocity in `.yz`. Divide distance by the cloud scale to recover<br>metres, not by the atmosphere's kilometre scale |
| `sceneDepth` | `TextureNode \| null` |  | The scene depth this pass marches against. Same option as the factory |
| `weatherEvolution` | `EvolvingWeather` | `new EvolvingWeather()` | No additional contract documented; see source |
| `camera` | `Camera \| null` | `null` | The scene camera, which drives the ray directions, the shadow cascades and<br>the altitude correction. Set it before the first render: left null the pass<br>uses a default perspective camera, which is wrong for any other projection. |
| `cloudShadow` | `CloudShadowDescriptor` |  | No additional contract documented; see source |
| `cloudShadowLength` | `Node<"vec2">` |  | No additional contract documented; see source |
| `cloudShadowAt` | `(worldPosition: Node<"vec3">, options?: CloudShadowAtOptions) => Node<"float">` |  | Cloud shadow at a world position, as the sun transmittance in 0..1: 1 is<br>fully lit, 0 is fully shadowed. Multiply a material's sun-facing term by it<br>and water, vegetation, particles and custom lit surfaces take the shadow<br>the aerial perspective already puts on the ground below them.<br><br>```ts<br>material.colorNode = albedo.mul(pass.cloudShadowAt(positionWorld))<br>```<br><br>Nothing is built until this is called, so an unused call site cannot change<br>a pixel. The sample is the ground consumer's own transmittance, cascade<br>selection and all. The radius defaults to `DEFAULT_SHADOW_RADIUS`,<br>not the per-pixel adaptive radius the aerial consumer computes, which<br>`options.radius` takes. |
| `resolveRT` | `RenderTarget<Texture<unknown, TextureEventMap>, RenderTargetEventMap> \| null` | `null` | The resolve and history targets, swapped each frame. `historyRT` holds the<br>image the composite reads. Both are null until the first resolve, so read<br>`outputTextureNode` instead of reaching in here. |
| `historyRT` | `RenderTarget<Texture<unknown, TextureEventMap>, RenderTargetEventMap> \| null` | `null` | No additional contract documented; see source |
| `outputTextureNode` | `TextureNode` |  | The resolved cloud image, as the composite sees it: the history texture<br>after a resolve, the raw march otherwise. One node whose value follows the<br>history swap, so a consumer built early keeps reading the live image. |
| `constructor` | `(options: CloudsOptions): CloudsPassNode` |  | No additional contract documented; see source |
| `customCacheKey` | `() => number` |  | No additional contract documented; see source |
| `updateBefore` | `(frame: NodeFrame) => boolean \| undefined` |  | No additional contract documented; see source |
| `prepareShadow` | `(renderer: NonNullable<NodeFrame["renderer"]>, camera?: Camera \| null) => void` |  | Prepare the current sample's shadow atlas before forward-lit scene captures.<br>Set time/frame/camera first and hold those inputs through the main render.<br>This does not march clouds or advance their colour history, and the following<br>updateBefore reuses the atlas. resetHistory invalidates that reuse. |
| `setup` | `(builder: NodeBuilder) => Node \| null \| undefined` |  | No additional contract documented; see source |
| `hasComposite` | `boolean` |  | Whether the pass retains any undisposed composite destinations |
| `composite` | `(dst: Node<"vec4"> \| AerialPerspectiveNode) => CloudsCompositeNode` |  | Build the node that mixes the resolved clouds into `dst`. The same<br>destination reuses its node until disposed, distinct destinations get<br>independent composites. Assign the result to the composer's output.<br><br>`AerialPerspectiveNode` is accepted because ADR-001 wires the takram aerial<br>node into this call, and that class extends an untyped `TempNode`, so it is<br>assignable to NEITHER `Node<'vec4'>` nor `Node`: its `setup()` return is<br>incompatible with Three.js Node declarations. Every consumer had to cast<br>at the call site to pass the node the docs tell them to pass.<br><br>Ownership: dispose a composite to release its destination, or dispose the pass |
| `resetHistory` | `() => void` |  | Clear the temporal accumulation. Same as `cloudsContext.resetHistory()` |
| `staticTracker` | `StaticModeTracker` | `new StaticModeTracker()` | No additional contract documented; see source |
| `dispose` | `() => void` |  | Release pass-owned targets, materials and effects, not the context's textures<br>Ownership: dispose the context separately after detaching borrowed textures |

### CloudsOptions

[Source](../src/CloudsPassNode.ts#L158)

```ts
interface CloudsOptions
```

The only argument `clouds` takes. Every knob lives on
`cloudsPass.cloudsContext` instead. A null depth node disables scene
occlusion, and replacing the node rebuilds the graph

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `sceneDepth` | `TextureNode \| null` |  | The scene's depth texture node, which the march uses to stop at solid<br>geometry. `null` is valid but disables scene occlusion, so clouds may<br>appear in front of terrain that should hide them |

### CloudLayer

[Source](../src/CloudLayer.ts#L79)

```ts
class CloudLayer
```

One of the four cloud layers. A layer owns a height band, the shape and
weather weights inside it, and whether it casts a cloud shadow. Four of them
are packed into the uniforms every frame and read in one march, so the count
is fixed.

Altitude and height are in metres, like the scene's world-space distances

**remarks**: Domain: four fixed slots per context, positive height activates a slot
Mutation: numeric values are uniforms, structural changes rebuild the graph
Ownership: the containing context owns its cloned layers, not GPU resources

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `channel` | `TextureChannel` | `'r'` | Local weather channel this layer reads |
| `altitude` | `number` | `0` | Height of the band's base above the bottom radius, in metres |
| `height` | `number` | `0` | Thickness of the band, in metres. 0 leaves the lane empty |
| `densityScale` | `number` | `0.2` | Weight of this layer's density in the march |
| `shapeAmount` | `number` | `1` | Weight of the base shape noise |
| `shapeDetailAmount` | `number` | `1` | Weight of the high-frequency detail noise. Ignored when<br>`CloudsContext.shapeDetail` is off |
| `weatherExponent` | `number` | `1` | Exponent applied to the weather channel. 1 keeps it unchanged |
| `shapeAlteringBias` | `number` | `0.35` | Bias on the shape-altering parabola, which moves density toward the middle<br>of the band |
| `coverageFilterWidth` | `number` | `0.6` | Width of the soft ramp where weather crosses the coverage threshold. 0 cuts<br>hard |
| `densityProfile` | `DensityProfile` | `new DensityProfile(0, 0, 0.75, 0.25)` | Vertical density distribution inside the band |
| `shadow` | `boolean` | `false` | Whether this layer casts into the cloud shadow map. Changing whether any<br>layer casts shadows changes the compiled graph |
| `constructor` | `(options?: CloudLayerLike): CloudLayer` |  | Build a layer, optionally patching over the defaults |
| `set` | `(options?: CloudLayerLike) => this` |  | Patch this layer from a partial object, skipping absent keys |
| `clone` | `() => CloudLayer` |  | A new layer with the same values, density profile copied |
| `copy` | `(other: CloudLayer) => this` |  | Copy every value from another layer, density profile included |

### CloudLayerLike

[Source](../src/CloudLayer.ts#L25)

```ts
interface CloudLayerLike
```

The shape of the per-layer options object accepted by `CloudLayer` and
`CloudLayers`. Every key is optional; an absent key keeps the current
value, so a partial object is a patch rather than a replacement.

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `densityProfile` | `DensityProfileLike \| undefined` |  | Partial coefficient patch, omitted or nullish values keep current values |
| `altitude` | `number \| undefined` |  | Height of the band's base above the bottom radius, in metres |
| `shapeAmount` | `number \| undefined` |  | Weight of the base shape noise |
| `shapeDetailAmount` | `number \| undefined` |  | Weight of the high-frequency detail noise. Ignored when<br>`CloudsContext.shapeDetail` is off |
| `shapeAlteringBias` | `number \| undefined` |  | Bias on the shape-altering parabola, which moves density toward the middle<br>of the band |
| `densityScale` | `number \| undefined` |  | Weight of this layer's density in the march |
| `channel` | `TextureChannel \| undefined` |  | Local weather channel this layer reads |
| `height` | `number \| undefined` |  | Thickness of the band, in metres. 0 leaves the lane empty |
| `weatherExponent` | `number \| undefined` |  | Exponent applied to the weather channel. 1 keeps it unchanged |
| `coverageFilterWidth` | `number \| undefined` |  | Width of the soft ramp where weather crosses the coverage threshold. 0 cuts<br>hard |
| `shadow` | `boolean \| undefined` |  | Whether this layer casts into the cloud shadow map. Changing whether any<br>layer casts shadows changes the compiled graph |

### CloudLayers

[Source](../src/CloudLayers.ts#L64)

```ts
class CloudLayers
```

The four `CloudLayer` slots, as an array you index by position. The
count is fixed at four because the shader packs them into one `vec4` per
field, so a fifth layer would need a different graph.

Which channel each layer reads is what makes them independent: the default
set takes `r`, `g`, `b` and `a` of the weather map.

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `constructor` | `(options?: readonly CloudLayerLike[]): CloudLayers` |  | Build the four slots, each patched over `CloudLayer`'s defaults |
| `set` | `(options?: readonly CloudLayerLike[]) => this` |  | Patch each slot from a partial-per-layer object |
| `reset` | `() => this` |  | Return every slot to `CloudLayer`'s own defaults |
| `clone` | `() => CloudLayers` |  | A new set with the same four layers, each copied |
| `copy` | `(other: CloudLayers) => this` |  | No additional contract documented; see source |
| `localWeatherChannels` | `string` |  | The four channels as one string such as `'rgba'`. Polled by<br>`CloudsContext.checkLocalWeatherChannels` because the swizzle is compiled<br>in, so changing a layer's channel rebuilds the march. |
| `castsShadow` | `boolean` |  | Whether ANY layer casts a cloud shadow.<br><br>This exact predicate gates a graph-time variant (CloudsPassNode compiles<br>the Beer-shadow-map branch into shadeSample only when it holds), so it is<br>what CloudsContext.checkShadowStructure tracks<br><br>Deliberately not per-layer: WHICH layers cast reaches the shader through the<br>packed `shadowLayerMask` uniform, so a change there needs no rebuild. Only<br>the existence of a caster changes the compiled shape. |
| `structure` | `LayerStructure` |  | The graph-time shape of the layer set: which of the four lanes<br>hold a layer, and whether two terms of the per-layer maths are identities<br>on every active lane. CloudsPassNode compiles these facts into the march<br>as literals. The magnitudes stay uniforms, so only a change here rebuilds.<br><br>- A lane with `height <= 0` is empty: its weather density is 0 for every<br>  height but the layer's own altitude, so it is compiled as a literal 0.<br>- `weatherExponent === 1` on every active lane drops `pow(weather, e)`.<br>- `densityProfile.expTerm === 0` on every active lane drops<br>  `expTerm * exp(exponent * h)` from the density profile. |
| `packValues` | `<K extends NumericKey>(key: K, result: Vector4) => Vector4` |  | Write one numeric field from all four layers into a `vec4`. This is how the<br>per-layer values reach the shader. |
| `packSums` | `<A extends NumericKey, B extends NumericKey>(a: A, b: B, result: Vector4) => Vector4` |  | Write `a + b` from all four layers into a `vec4`, for the band tops, which<br>are stored as an altitude plus a height |
| `packDensityProfiles` | `<K extends keyof DensityProfileLike>(key: K, result: Vector4) => Vector4` |  | One `DensityProfile` field from all four layers, into a `vec4` |
| `packIntervalHeights` | `(minIntervals: Vector3, maxIntervals: Vector3) => void` |  | The three height ranges the march steps through, from the eight band<br>endpoints sorted and interval-coded. Bands may overlap and be out of order;<br>this returns the merged ranges, at most three of them |

### DensityProfile

[Source](../src/DensityProfile.ts#L8)

```ts
class DensityProfile
```

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `constructor` | `(expTerm?: number, exponent?: number, linearTerm?: number, constantTerm?: number): DensityProfile` |  | No additional contract documented; see source |
| `expTerm` | `number` | `0` | No additional contract documented; see source |
| `exponent` | `number` | `0` | No additional contract documented; see source |
| `linearTerm` | `number` | `0` | No additional contract documented; see source |
| `constantTerm` | `number` | `0` | No additional contract documented; see source |
| `set` | `(expTerm?: number, exponent?: number, linearTerm?: number, constantTerm?: number) => this` |  | No additional contract documented; see source |
| `clone` | `() => DensityProfile` |  | No additional contract documented; see source |
| `copy` | `(other: DensityProfile) => this` |  | No additional contract documented; see source |

### applyQualityPreset

[Source](../src/qualityPresets.ts#L348)

```ts
applyQualityPreset(target: QualityPresetTarget, name: QualityPreset): void
```

Write every field of one preset onto a target, in place. The top-level
props go to the target itself, `clouds` and `shadow` into its two shorthand
objects. Copies map dimensions into the target's own vector.

On a `CloudsContext`, this also records the last applied preset. Later
overrides leave that name unchanged. An unknown name throws `RangeError`
listing the supported presets before any configuration changes.

**remarks**: Domain: the keys of qualityPresets, applied before local overrides
Mutation: uses context setters, changed graph fields invalidate history
Ownership: copies mapSize values without sharing the preset's mutable vector

### QualityPreset

[Source](../src/qualityPresets.ts#L12)

```ts
type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'lowEnd'
```

The bundled presets. A preset is a whole set of fields, not a rank:
setting one overwrites every field it names, so mix presets by applying two
and then setting the fields you care about. `lowEnd` is a fallback for
low-end or contended GPUs, not a look, and is never the default.

### qualityPresets

[Source](../src/qualityPresets.ts#L246)

```ts
qualityPresets: Record<QualityPreset, QualityPresetValues>
```

Every bundled preset. `high` is `defaults` itself, so the object is
shared and must not be mutated by a caller.

Use `applyQualityPreset`, or set `CloudsContext.qualityPreset`, rather
than assigning a preset onto the context: the graph-shape fields
(`multiScatteringOctaves`, `accurateSunSkyLight`, `accuratePhaseFunction`)
use forwarding setters on `CloudsContext.clouds` to bump `graphVersion`.

### defaults

[Source](../src/qualityPresets.ts#L233)

```ts
defaults: QualityPresetValues
```

The values `high` is. Every `CloudsContext` starts from these, and a
preset spreads them, so this object is the single place a default is written.

### loadBakedCloudTextures

[Source](../src/textures/loadBakedCloudTextures.ts#L267)

```ts
loadBakedCloudTextures(urls: BakedCloudTextureUrls, { signal }?: LoadBakedCloudTexturesOptions): Promise<BakedCloudTextures>
```

Load the four baked assets the original ships, with the same filters and
wrapping it applies. Assign the result to the matching context properties:

```ts
const cloudsContext = cloudsPass.cloudsContext
const baked = await loadBakedCloudTextures({
  localWeather: DEFAULT_LOCAL_WEATHER_URL,
  turbulence: DEFAULT_TURBULENCE_URL,
  shape: DEFAULT_SHAPE_URL,
  shapeDetail: DEFAULT_SHAPE_DETAIL_URL
})
cloudsContext.localWeatherTexture = baked.localWeatherTexture
cloudsContext.shapeTexture = baked.shapeTexture
cloudsContext.shapeDetailTexture = baked.shapeDetailTexture
cloudsContext.turbulenceTexture = baked.turbulenceTexture
```

The 3D loads use `fetch`, so a cross-origin file:// page needs the assets
served over http. Success transfers all four textures to the caller.
Failure or abort disposes all loader-owned textures, including late images.
Abort cancels fetches, not image transport, and has no effect after success.

**remarks**: Requires: all four URLs, with successful HTTP responses and exact volume sizes
Readiness: resolved textures are CPU-loaded, not proof of a rendered frame
Ownership: dispose returned textures once, or transfer them to one owner
Failure: CloudTextureLoadError identifies the asset, AbortError is cancellation

### LoadBakedCloudTexturesOptions

[Source](../src/textures/loadBakedCloudTextures.ts#L50)

```ts
interface LoadBakedCloudTexturesOptions
```

Optional cancellation while the loader still owns its pending resources

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `signal` | `AbortSignal \| undefined` |  | Abort pending loads, not textures already returned to the caller |

### BakedCloudTextures

[Source](../src/textures/loadBakedCloudTextures.ts#L28)

```ts
interface BakedCloudTextures
```

The four baked textures a `CloudsContext` marches against
Ownership transfers to the caller after a successful load, without jitter

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `localWeatherTexture` | `Texture<unknown, TextureEventMap>` |  | No additional contract documented; see source |
| `turbulenceTexture` | `Texture<unknown, TextureEventMap>` |  | No additional contract documented; see source |
| `shapeTexture` | `Data3DTexture` |  | No additional contract documented; see source |
| `shapeDetailTexture` | `Data3DTexture` |  | No additional contract documented; see source |

### BakedCloudTextureUrls

[Source](../src/textures/loadBakedCloudTextures.ts#L42)

```ts
interface BakedCloudTextureUrls
```

Where to fetch each of the four. The shapes are raw 3D payloads sized by
`CLOUD_SHAPE_TEXTURE_SIZE` and `CLOUD_SHAPE_DETAIL_TEXTURE_SIZE`
rather than images, so they cannot go through a `TextureLoader`.

The defaults for all four are exported from the package root.

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `localWeather` | `string` |  | No additional contract documented; see source |
| `turbulence` | `string` |  | No additional contract documented; see source |
| `shape` | `string` |  | No additional contract documented; see source |
| `shapeDetail` | `string` |  | No additional contract documented; see source |

### CloudTextureLoadError

[Source](../src/textures/loadBakedCloudTextures.ts#L70)

```ts
class CloudTextureLoadError
```

Identifies a failed asset without requiring callers to parse its message
Cancellation instead rejects with a DOMException named AbortError

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `asset` | `CloudTextureAsset` |  | The failed logical asset, even when several assets share a URL |
| `url` | `string` |  | The caller-supplied URL, not a resolved cache key |
| `status` | `number \| undefined` |  | HTTP status when a volume response was received, absent for images |
| `expectedBytes` | `number \| undefined` |  | Required raw volume byte count when a payload-size mismatch was found |
| `actualBytes` | `number \| undefined` |  | Received raw volume byte count when a payload-size mismatch was found |
| `constructor` | `(details: TextureLoadDetails, message: string, cause?: unknown): CloudTextureLoadError` |  | No additional contract documented; see source |

### CloudTextureAsset

[Source](../src/textures/loadBakedCloudTextures.ts#L56)

```ts
type CloudTextureAsset = keyof BakedCloudTextureUrls | 'stbn'
```

Logical asset identity, independent of its URL or transport

### createJitterTexture

[Source](../src/textures/loadBakedCloudTextures.ts#L400)

```ts
createJitterTexture(): Data3DTexture
```

The 128x128x64 blue-noise jitter volume the context uses when you do not
assign one, built offline by `scripts/generate-blue-noise.mjs` and embedded
as a rank map. Slice k is that map shifted by k times the golden ratio
conjugate, so consecutive slices decorrelate. Generated per call and cached
by `CloudsContext.stbnTexture`.

To sample NVIDIA's STBN exactly as the original does instead, load it from
upstream and assign it (see ADR-009).

### assertWebGPUSupported

[Source](../src/CloudsPassNode.ts#L262)

```ts
assertWebGPUSupported(renderer: unknown): void
```

Refuses an uninitialized, unknown or non-native WebGPU backend from the
caller's own stack

Call this once after `await renderer.init()` and before constructing the
pass:

```ts
const renderer = new WebGPURenderer({ forceWebGL: true })
await renderer.init()
assertWebGPUSupported(renderer) // throws here, where you can catch it
```

WHY THIS EXISTS SEPARATELY FROM THE setup() CHECK. CloudsPassNode.setup()
also throws on a WebGL backend, and that throw CANNOT refuse construction:
setup() runs inside three's node-build try/catch, which catches the error,
re-emits it as a `THREE.TSL: Error: ...` console message, and finishes the
build without the pass. Measured on a WebGL2 run:
the message appears as a console error with a ContextNode.setup stack, the
page produces ZERO pageerror events, the renderer reports itself as booted,
and the observable result is a silently black frame. A caller relying on the
documented "setup() throws" got a black render instead of an exception.

Call only after initialization, when `renderer.initialized` is true. A
backend object can exist before `init()` and does not establish readiness

### syncCelestialDirections

[Source](../src/experimental/timeOfDay.ts#L133)

```ts
syncCelestialDirections(sinks: CelestialSink | readonly CelestialSink[], request: TimeOfDayRequest): CelestialDirections
```

Compute both directions and write each into the sinks that take it: one call
for the whole sun sync, which is the part consumers get wrong. The
atmosphere, the clouds and the shadow dependencies each read their own copy,
and a scene missing two of the three is black or unshadowed rather than
broken.

A sink with no `moonDirection` gets the sun and nothing else, so the clouds
context takes part unchanged. Returns the same values it wrote, so a caller can
light the scene from them without computing twice.

### inspectCloudsSetup

[Source](../src/diagnostics.ts#L453)

```ts
inspectCloudsSetup({ renderer, pass, atmosphere: expectedAtmosphere, depthMode }: InspectCloudsSetupOptions): CloudsSetupInspection
```

Inspect setup without loading textures, creating GPU resources or rendering

**remarks**: Requires: the actual pass and renderer, with an explicit depth policy
Mutation: none by the inspector, registered context providers are called
Readiness: graph and frame stay unobserved even when assets are ready
Ownership: all inputs are borrowed, no lazy jitter texture is allocated

### CloudSetupDiagnostic

[Source](../src/diagnostics.ts#L11)

```ts
interface CloudSetupDiagnostic
```

One observable setup problem, with a stable code and input path

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `code` | `"backend.webgl" \| "backend.not-initialized" \| "backend.unknown" \| "provider.missing" \| "provider.threw" \| "provider.duplicate-clouds" \| "provider.clouds-mismatch" \| "provider.atmosphere-invalid" \| "provider.atmosphere-mismatch" \| "direction.invalid" \| "asset.missing" \| "asset.wrong-dimension" \| "asset.not-loaded" \| "layers.invalid-slots" \| "layers.invalid-channel" \| "camera.missing" \| "camera.atmosphere-mismatch" \| "depth.mode-invalid" \| "depth.missing" \| `feature.${string}`` |  | Stable problem category for branching without parsing prose |
| `severity` | `"error" \| "warning"` |  | Errors invalidate configuration, warnings retain their separate remedies |
| `path` | `string` |  | Input path to inspect or correct |
| `observed` | `string \| number \| boolean \| readonly number[] \| null` |  | Plain observed value, not a retained texture, renderer or context |
| `message` | `string` |  | Human-readable explanation, not a stable machine identifier |
| `remedy` | `string` |  | Suggested correction, never applied by this inspection |

### CloudsSetupInspection

[Source](../src/diagnostics.ts#L59)

```ts
interface CloudsSetupInspection
```

CPU observations only, not shader compilation or GPU completion evidence

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `diagnostics` | `CloudSetupDiagnostic[]` |  | Observed errors and warnings, including experimental feature warnings |
| `readiness` | `{ configuration: "valid" \| "invalid"; assets: "ready" \| "not-ready"; graph: "unobserved"; frame: "unobserved"; }` |  | Assets describe CPU observations, graph and frame are always unobserved |

### InspectCloudsSetupOptions

[Source](../src/diagnostics.ts#L47)

```ts
interface InspectCloudsSetupOptions
```

Existing objects to inspect, never a second configuration store

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `renderer` | `unknown` |  | Inspect after renderer.init(), earlier calls report not-initialized |
| `pass` | `CloudsPassNode` |  | The actual pass whose context must match the renderer's provider |
| `atmosphere` | `AtmosphereContext \| undefined` |  | Optional expected identity in addition to inspecting the active provider |
| `depthMode` | `"scene" \| "sky-only"` |  | Scene mode requires depth, sky-only explicitly permits missing depth |

## Advanced composition

| Export | Signature | Description |
| --- | --- | --- |
| [`aerialPerspectiveWithCloudShadow`](../src/shadow/aerialShadowAdapter.ts#L24) | `aerialPerspectiveWithCloudShadow(colorNode: Node<"vec4">, depthNode: Node<"float"> \| TextureNode, shadowLengthNode: Node<"vec2"> \| null, shadowNode: Node<"float"> \| null, normalNode?: Node<"vec3"> \| TextureNode, lightingMaskNode?: Node<"float"> \| null): AerialPerspectiveNode` | See source declaration |
| [`CLOUD_SHAPE_DETAIL_TEXTURE_SIZE`](../src/constants.ts#L5) | `CLOUD_SHAPE_DETAIL_TEXTURE_SIZE: 32` | See source declaration |
| [`CLOUD_SHAPE_TEXTURE_SIZE`](../src/constants.ts#L4) | `CLOUD_SHAPE_TEXTURE_SIZE: 128` | See source declaration |
| [`cloudShadowAtlasResolution`](../src/shadow/cloudShadowNode.ts#L79) | `cloudShadowAtlasResolution(descriptor: CloudShadowDescriptor): Node<"vec2">` | See source declaration |
| [`CloudShadowAtOptions`](../src/shadow/cloudShadowNode.ts#L32) | `interface CloudShadowAtOptions` | See source declaration |
| [`CloudShadowDescriptor`](../src/CloudsPassNode.ts#L187) | `interface CloudShadowDescriptor` | See source declaration |
| [`CloudShadowedAtmosphereLightNode`](../src/shadow/CloudShadowedAtmosphereLightNode.ts#L15) | `class CloudShadowedAtmosphereLightNode` | See source declaration |
| [`CloudShadowNodeDeps`](../src/shadow/cloudShadowNode.ts#L19) | `interface CloudShadowNodeDeps` | See source declaration |
| [`CloudShadowNodeOptions`](../src/shadow/cloudShadowNode.ts#L27) | `interface CloudShadowNodeOptions` | See source declaration |
| [`CloudShape`](../src/textures/generators.ts#L28) | `class CloudShape` | See source declaration |
| [`CloudShapeDetail`](../src/textures/generators.ts#L38) | `class CloudShapeDetail` | See source declaration |
| [`cloudsMaterialParameterKeys`](../src/qualityPresets.ts#L142) | `cloudsMaterialParameterKeys: readonly ["multiScatteringOctaves", "accurateSunSkyLight", "accuratePhaseFunction"]` | `clouds` fields that are compile-time material parameters, so a change<br>rebuilds the graph |
| [`CloudsPresetFields`](../src/qualityPresets.ts#L15) | `interface CloudsPresetFields` | The march-side fields a preset sets, grouped as the reference groups them |
| [`cloudsUniformKeys`](../src/qualityPresets.ts#L115) | `cloudsUniformKeys: readonly ["maxIterationCount", "minStepSize", "maxStepSize", "maxRayDistance", "perspectiveStepScale", "minDensity", "minExtinction", "minTransmittance", "maxIterationCountToSun", "maxIterationCountToGround", "minSecondaryStepSize", "secondaryStepScale", "maxShadowFilterRadius", "maxShadowLengthIterationCount", "minShadowLengthStepSize", "maxShadowLengthRayDistance", "hazeDensityScale", "hazeExponent", "hazeScatteringCoefficient", "hazeAbsorptionCoefficient"]` | `clouds` fields that are march uniforms, rewritten every frame |
| [`createCloudShadowNode`](../src/shadow/cloudShadowNode.ts#L46) | `createCloudShadowNode(deps: CloudShadowNodeDeps, options?: CloudShadowNodeOptions): FnNode<[Node<"vec3"> \| Vector3, number \| Node<"float"> \| Node<"uint">, number \| Node<"float"> \| Node<"uint">], Node<"float">>` | See source declaration |
| [`createCloudShadowTransmittance`](../src/shadow/sampleCloudShadowOpticalDepth.ts#L214) | `createCloudShadowTransmittance(descriptor: CloudShadowDescriptor, deps: GroundShadowExtraDeps, options?: { enabled?: boolean; shadowSampleCount?: number; }): FnNode<[Node<"vec3"> \| Vector3, number \| Node<"float"> \| Node<"uint">, number \| Node<"float"> \| Node<"uint">], Node<"float">>` | See source declaration |
| [`createGetShadowRadius`](../src/shadow/shadowRadius.ts#L39) | `createGetShadowRadius(deps: ShadowRadiusDeps): FnNode<[Node<"vec3"> \| Vector3], Node<"float">>` | See source declaration |
| [`createQualityGovernor`](../src/QualityGovernor.ts#L375) | `createQualityGovernor(target: QualityGovernorTarget, options?: QualityGovernorOptions): QualityGovernor` | Create a governor for a target and register it as the target's<br>`qualityGovernor`, which is what `applyReferenceMode` disarms. The governor<br>starts disarmed: call `arm()` to begin, and feed `update(frameMs)` per frame. |
| [`createSampleCloudShadowOpticalDepth`](../src/shadow/sampleCloudShadowOpticalDepth.ts#L53) | `createSampleCloudShadowOpticalDepth(descriptor: CloudShadowDescriptor, deps: GroundShadowExtraDeps, options?: { shadowSampleCount?: number; }): FnNode<[Node<"vec3"> \| Vector3, number \| Node<"float"> \| Node<"uint">, number \| Node<"float"> \| Node<"uint">], VarNode<"float", ConstNode<"float", number>>>` | See source declaration |
| [`DebugView`](../src/CloudsContext.ts#L89) | `type DebugView =<br>  \| 'none'<br>  \| 'cascades'<br>  \| 'shadowMap'<br>  \| 'uv'<br>  \| 'sampleCount'<br>  \| 'frontDepth'<br>  \| 'shadowLength'<br>  \| 'velocity'<br>  \| 'marchIntervals'` | Which diagnostic view the resolve pass writes, or `'none'` for the shaded<br>image. A change rebuilds the graph. |
| [`DEFAULT_LOCAL_WEATHER_URL`](../src/constants.ts#L6) | `DEFAULT_LOCAL_WEATHER_URL: "assets/local_weather.png"` | See source declaration |
| [`DEFAULT_SHADOW_RADIUS`](../src/shadow/shadowRadius.ts#L20) | `DEFAULT_SHADOW_RADIUS: 3` | See source declaration |
| [`DEFAULT_SHAPE_DETAIL_URL`](../src/constants.ts#L8) | `DEFAULT_SHAPE_DETAIL_URL: "assets/shape_detail.bin"` | See source declaration |
| [`DEFAULT_SHAPE_URL`](../src/constants.ts#L7) | `DEFAULT_SHAPE_URL: "assets/shape.bin"` | See source declaration |
| [`DEFAULT_TURBULENCE_URL`](../src/constants.ts#L9) | `DEFAULT_TURBULENCE_URL: "assets/turbulence.png"` | See source declaration |
| [`DensityProfileLike`](../src/DensityProfile.ts#L4) | `interface DensityProfileLike` | See source declaration |
| [`getCloudsContext`](../src/CloudsContext.ts#L1321) | `getCloudsContext(ctx: Record<string, unknown>): CloudsContext` | Read the `CloudsContext` out of a TSL context, for a node that needs<br>the knobs without holding the pass. Throws when the pass is not in the graph,<br>and when two copies of this package are loaded, which is the usual cause of<br>the second message. |
| [`GroundShadowExtraDeps`](../src/shadow/sampleCloudShadowOpticalDepth.ts#L41) | `interface GroundShadowExtraDeps` | See source declaration |
| [`LOCAL_WEATHER_SIZE`](../src/textures/generators.ts#L25) | `LOCAL_WEATHER_SIZE: 512` | See source declaration |
| [`LocalWeather`](../src/textures/generators.ts#L55) | `class LocalWeather` | See source declaration |
| [`Procedural3DTexture`](../src/textures/ProceduralTexture.ts#L87) | `class Procedural3DTexture` | See source declaration |
| [`ProceduralTexture2D`](../src/textures/ProceduralTexture.ts#L152) | `class ProceduralTexture2D` | See source declaration |
| [`ProceduralTextureLike`](../src/textures/ProceduralTexture.ts#L41) | `interface ProceduralTextureLike` | See source declaration |
| [`QUALITY_GOVERNOR_LEVEL_1`](../src/QualityGovernor.ts#L74) | `QUALITY_GOVERNOR_LEVEL_1: QualityPresetValues` | See source declaration |
| [`QualityGovernor`](../src/QualityGovernor.ts#L156) | `class QualityGovernor` | Steps a target between its own settings (level 0), the perf map's c3<br>(level 1) and the `lowEnd` preset (level 2), down when frames run late and<br>back up when headroom returns. The host feeds frame intervals: the library<br>never reads a clock. Opt-in: nothing happens until `arm()`. |
| [`qualityGovernorDefaults`](../src/QualityGovernor.ts#L61) | `qualityGovernorDefaults: Readonly<Required<Omit<QualityGovernorOptions, "onStep">>>` | The defaults every option falls back to |
| [`QualityGovernorLevel`](../src/QualityGovernor.ts#L25) | `type QualityGovernorLevel = 0 \| 1 \| 2` | 0 is the target's own settings, 1 the perf map's c3, 2 the lowEnd preset |
| [`QualityGovernorOptions`](../src/QualityGovernor.ts#L37) | `interface QualityGovernorOptions` | See source declaration |
| [`QualityGovernorStepEvent`](../src/QualityGovernor.ts#L27) | `interface QualityGovernorStepEvent` | See source declaration |
| [`QualityGovernorTarget`](../src/QualityGovernor.ts#L19) | `interface QualityGovernorTarget` | What a governor drives: a `CloudsContext`, or anything shaped like one |
| [`QualityPresetTarget`](../src/qualityPresets.ts#L71) | `interface QualityPresetTarget` | What a preset needs to write into, which `CloudsContext` implements. A plain<br>object with these members works too. |
| [`QualityPresetValues`](../src/qualityPresets.ts#L92) | `interface QualityPresetValues` | One complete set of preset values |
| [`shadowMapsParameterKeys`](../src/qualityPresets.ts#L166) | `shadowMapsParameterKeys: readonly ["cascadeCount", "mapSize", "maxFar", "farScale", "splitMode", "splitLambda"]` | `shadow` fields owned by the cascaded shadow maps rather than the pass |
| [`shadowMaterialParameterKeys`](../src/qualityPresets.ts#L160) | `shadowMaterialParameterKeys: readonly ["temporalJitter"]` | `shadow` field that is a compile-time material parameter |
| [`shadowPassParameterKeys`](../src/qualityPresets.ts#L163) | `shadowPassParameterKeys: readonly ["temporalPass"]` | `shadow` field that configures the resolve pass rather than the march |
| [`ShadowPresetFields`](../src/qualityPresets.ts#L42) | `interface ShadowPresetFields` | The shadow-map fields a preset sets |
| [`ShadowRadiusDeps`](../src/shadow/shadowRadius.ts#L27) | `interface ShadowRadiusDeps` | See source declaration |
| [`shadowUniformKeys`](../src/qualityPresets.ts#L149) | `shadowUniformKeys: readonly ["maxIterationCount", "minStepSize", "maxStepSize", "minDensity", "minExtinction", "minTransmittance", "opticalDepthTailScale"]` | `shadow` fields that are per-frame shadow-march uniforms |
| [`TextureChannel`](../src/CloudLayer.ts#L64) | `type TextureChannel = 'r' \| 'g' \| 'b' \| 'a'` | Which channel of the local weather texture one layer reads. The four layers<br>default to `r`, `g`, `b` and `a`, so a two-channel weather map still gives<br>two independent layers. |
| [`Turbulence`](../src/textures/generators.ts#L48) | `class Turbulence` | See source declaration |
| [`TURBULENCE_SIZE`](../src/textures/generators.ts#L24) | `TURBULENCE_SIZE: 128` | See source declaration |
| [`writeQualityPresetValues`](../src/qualityPresets.ts#L367) | `writeQualityPresetValues(target: QualityPresetTarget, values: QualityPresetValues): void` | Write one complete value set onto a target the way a preset does, without<br>recording a preset name. The governor's level 1 and its level 0 restore use<br>it, and `applyQualityPreset` is this plus the name. |

## Experiments

| Export | Signature | Description |
| --- | --- | --- |
| [`AppliedScenePreset`](../src/experimental/scenePresets.ts#L558) | `interface AppliedScenePreset` | What a preset left behind, so a caller can light from it without recomputing |
| [`applyCloudTypePreset`](../src/experimental/cloudTypePresets.ts#L291) | `applyCloudTypePreset(target: CloudTypePresetTarget, name: CloudTypePresetName): CloudTypePreset` | See source declaration |
| [`applyScenePreset`](../src/experimental/scenePresets.ts#L622) | `applyScenePreset(target: ScenePresetTarget, name: ScenePresetName, request: ScenePresetRequest): AppliedScenePreset` | Write a whole scene: cloud type, coverage, haze, the experimental options it<br>needs, then the sun and moon for its time of day at the caller's place. One<br>call because a preset applied halfway is a different sky, and the half that<br>is missing is the half nobody looks at. |
| [`blendCloudTypeParameter`](../src/experimental/cloudTypeMap.ts#L368) | `blendCloudTypeParameter(base: Node<"vec4">, weights: [Node<"float">, Node<"float">, Node<"float">], d0: Node<"vec4">, d1: Node<"vec4">, d2: Node<"vec4">): Node<"vec4">` | See source declaration |
| [`CelestialDirections`](../src/experimental/timeOfDay.ts#L26) | `interface CelestialDirections` | Both bodies as ECEF unit vectors, which is what every consumer wants |
| [`CelestialSink`](../src/experimental/timeOfDay.ts#L40) | `interface CelestialSink` | One consumer. `sunDirection` is required, `moonDirection` is optional |
| [`celestialVector`](../src/experimental/timeOfDay.ts#L58) | `celestialVector(target: CelestialVector): Vector3` | The `Vector3` behind a sink field, whatever shape that field has |
| [`CelestialVector`](../src/experimental/timeOfDay.ts#L37) | `type CelestialVector = Vector3 \| { readonly value: Vector3 }` | A place a direction can be written to: a plain `Vector3` like<br>`CloudsContext.sunDirection`, or a uniform wrapper like<br>`atmosphere.sunDirectionECEF`. Both are what the shipped consumers hold, so<br>no consumer changes shape to take part. |
| [`cirrusDeckDefaults`](../src/experimental/cirrusDeck.ts#L46) | `cirrusDeckDefaults: Readonly<CirrusDeckParams>` | See source declaration |
| [`CirrusDeckParams`](../src/experimental/cirrusDeck.ts#L30) | `interface CirrusDeckParams` | See source declaration |
| [`CLOUD_TYPE_PARAMS`](../src/experimental/cloudTypeMap.ts#L53) | `CLOUD_TYPE_PARAMS: readonly ["shapeAmount", "shapeDetailAmount", "shapeAlteringBias", "densityScale", "expTerm", "exponent", "linearTerm", "constantTerm"]` | See source declaration |
| [`CLOUD_TYPE_TENT_SCOPES`](../src/experimental/cloudTypeMap.ts#L138) | `CLOUD_TYPE_TENT_SCOPES: readonly ["weather", "media"]` | See source declaration |
| [`CloudEnvironmentSettings`](../src/experimental/cloudEnvironment.ts#L46) | `interface CloudEnvironmentSettings` | See source declaration |
| [`cloudShapeDefaults`](../src/experimental/cloudShape.ts#L36) | `cloudShapeDefaults: Readonly<CloudShapeParams>` | See source declaration |
| [`CloudShapeDeps`](../src/experimental/cloudShape.ts#L209) | `interface CloudShapeDeps` | See source declaration |
| [`CloudShapeParams`](../src/experimental/cloudShape.ts#L11) | `interface CloudShapeParams` | See source declaration |
| [`CloudTypeAnchor`](../src/experimental/cloudTypeMap.ts#L46) | `interface CloudTypeAnchor` | See source declaration |
| [`CloudTypeAnchorDeltas`](../src/experimental/cloudTypeMap.ts#L118) | `type CloudTypeAnchorDeltas = [<br>  UniformNode<'vec4', Vector4>,<br>  UniformNode<'vec4', Vector4>,<br>  UniformNode<'vec4', Vector4><br>]` | See source declaration |
| [`cloudTypeAnchors`](../src/experimental/cloudTypeMap.ts#L71) | `cloudTypeAnchors: readonly [CloudTypeAnchor, CloudTypeAnchor, CloudTypeAnchor]` | See source declaration |
| [`CloudTypeArchetype`](../src/experimental/cloudTypeMap.ts#L30) | `interface CloudTypeArchetype` | See source declaration |
| [`cloudTypeArchetypes`](../src/experimental/cloudTypeMap.ts#L409) | `cloudTypeArchetypes: readonly CloudTypeArchetype[]` | See source declaration |
| [`CloudTypeBlendNodes`](../src/experimental/cloudTypeMap.ts#L127) | `interface CloudTypeBlendNodes` | See source declaration |
| [`CloudTypeDeltas`](../src/experimental/cloudTypeMap.ts#L125) | `type CloudTypeDeltas = Record<CloudTypeParam, CloudTypeAnchorDeltas>` | See source declaration |
| [`CloudTypeLayers`](../src/experimental/cloudTypePresets.ts#L12) | `type CloudTypeLayers = readonly [<br>  CloudLayerLike,<br>  CloudLayerLike,<br>  CloudLayerLike,<br>  CloudLayerLike<br>]` | See source declaration |
| [`CloudTypeParam`](../src/experimental/cloudTypeMap.ts#L64) | `type CloudTypeParam = (typeof CLOUD_TYPE_PARAMS)[number]` | See source declaration |
| [`CloudTypePreset`](../src/experimental/cloudTypePresets.ts#L19) | `interface CloudTypePreset` | See source declaration |
| [`CloudTypePresetName`](../src/experimental/cloudTypePresets.ts#L35) | `type CloudTypePresetName = (typeof cloudTypePresetNames)[number]` | See source declaration |
| [`cloudTypePresetNames`](../src/experimental/cloudTypePresets.ts#L26) | `cloudTypePresetNames: readonly ["fairWeatherCumulus", "stratocumulusDeck", "overcastSheet", "highCirrus", "groundFog", "mixedSky"]` | See source declaration |
| [`cloudTypePresets`](../src/experimental/cloudTypePresets.ts#L243) | `cloudTypePresets: Record<"fairWeatherCumulus" \| "stratocumulusDeck" \| "overcastSheet" \| "highCirrus" \| "groundFog" \| "mixedSky", CloudTypePreset>` | See source declaration |
| [`CloudTypePresetTarget`](../src/experimental/cloudTypePresets.ts#L255) | `interface CloudTypePresetTarget` | See source declaration |
| [`cloudTypeProfileAt`](../src/experimental/cloudTypePresets.ts#L272) | `cloudTypeProfileAt(profile: DensityProfileLike, heightFraction: number): number` | See source declaration |
| [`CloudTypes`](../src/experimental/cloudTypeMap.ts#L266) | `class CloudTypes` | See source declaration |
| [`cloudTypeTentNames`](../src/experimental/cloudTypeMap.ts#L142) | `cloudTypeTentNames(scope: CloudTypeTentScope, suffix?: string \| number): [string, string, string]` | See source declaration |
| [`CloudTypeTentScope`](../src/experimental/cloudTypeMap.ts#L140) | `type CloudTypeTentScope = (typeof CLOUD_TYPE_TENT_SCOPES)[number]` | See source declaration |
| [`cloudTypeTentWeights`](../src/experimental/cloudTypeMap.ts#L349) | `cloudTypeTentWeights(morph: Node<"float">, scope: CloudTypeTentScope, suffix?: string \| number): [Node<"float">, Node<"float">, Node<"float">]` | See source declaration |
| [`computeCelestialDirections`](../src/experimental/timeOfDay.ts#L65) | `computeCelestialDirections(date: Date \| number, location: TimeOfDayLocation, result?: CelestialDirections): CelestialDirections` | Sun and moon directions for an instant and a place, in ECEF, unit length |
| [`CONVECTIVE_TOWER_MIN_HEIGHT`](../src/experimental/convectiveProfile.ts#L44) | `CONVECTIVE_TOWER_MIN_HEIGHT: 4000` | See source declaration |
| [`CONVECTIVE_TOWER_RAMP`](../src/experimental/convectiveProfile.ts#L48) | `CONVECTIVE_TOWER_RAMP: 1000` | See source declaration |
| [`convectiveProfileDefaults`](../src/experimental/convectiveProfile.ts#L30) | `convectiveProfileDefaults: Readonly<ConvectiveProfileParams>` | See source declaration |
| [`ConvectiveProfileParams`](../src/experimental/convectiveProfile.ts#L9) | `interface ConvectiveProfileParams` | See source declaration |
| [`ConvectiveUniforms`](../src/experimental/convectiveProfile.ts#L204) | `interface ConvectiveUniforms` | See source declaration |
| [`createCirrusStreaksTexture`](../src/experimental/cirrusStreaks.ts#L157) | `createCirrusStreaksTexture(size?: number, seed?: number): DataTexture` | See source declaration |
| [`createCloudTypeMap`](../src/experimental/cloudTypeMap.ts#L235) | `createCloudTypeMap(options?: { size?: number; cells?: number; seed?: number; }): DataTexture` | See source declaration |
| [`createProceduralWeather`](../src/experimental/proceduralWeather.ts#L369) | `createProceduralWeather(low: WeatherChannelNodes, mid: WeatherChannelNodes, high: WeatherChannelNodes): ProceduralWeatherGenerator` | See source declaration |
| [`DEFAULT_WATER_PRO_CLOUD_SKY`](../src/experimental/waterProSky.ts#L83) | `DEFAULT_WATER_PRO_CLOUD_SKY: WaterProCloudSkyOptions` | See source declaration |
| [`evolvingWeatherDefaults`](../src/experimental/evolvingWeather.ts#L73) | `evolvingWeatherDefaults: Readonly<EvolvingWeatherParams>` | See source declaration |
| [`EvolvingWeatherParams`](../src/experimental/evolvingWeather.ts#L60) | `interface EvolvingWeatherParams` | See source declaration |
| [`ExperimentalCloudOptions`](../src/experimental/options.ts#L4) | `interface ExperimentalCloudOptions` | See source declaration |
| [`experimentalDefaults`](../src/experimental/options.ts#L37) | `experimentalDefaults: Readonly<ExperimentalCloudOptions>` | See source declaration |
| [`FlashSample`](../src/experimental/lightning.ts#L262) | `interface FlashSample` | See source declaration |
| [`flashScheduleDefaults`](../src/experimental/lightning.ts#L254) | `flashScheduleDefaults: Readonly<FlashScheduleOptions>` | See source declaration |
| [`FlashScheduleOptions`](../src/experimental/lightning.ts#L243) | `interface FlashScheduleOptions` | See source declaration |
| [`FULL_MOON_IRRADIANCE_RATIO`](../src/experimental/moonlight.ts#L16) | `FULL_MOON_IRRADIANCE_RATIO: 0.0000025` | See source declaration |
| [`generateCirrusStreaks`](../src/experimental/cirrusStreaks.ts#L113) | `generateCirrusStreaks(size?: number, seed?: number): Uint8Array` | See source declaration |
| [`isCloudTypePresetName`](../src/experimental/cloudTypePresets.ts#L260) | `isCloudTypePresetName(value: unknown): value is CloudTypePresetName` | See source declaration |
| [`isScenePresetName`](../src/experimental/scenePresets.ts#L522) | `isScenePresetName(value: unknown): value is ScenePresetName` | See source declaration |
| [`LightningParams`](../src/experimental/lightning.ts#L39) | `interface LightningParams` | See source declaration |
| [`lightningParamsDefault`](../src/experimental/lightning.ts#L51) | `lightningParamsDefault: Readonly<LightningParams>` | See source declaration |
| [`LightningState`](../src/experimental/lightning.ts#L30) | `interface LightningState` | See source declaration |
| [`MoonlightNodes`](../src/experimental/moonlight.ts#L89) | `interface MoonlightNodes` | See source declaration |
| [`ProceduralWeather`](../src/experimental/proceduralWeather.ts#L414) | `class ProceduralWeather` | See source declaration |
| [`ProceduralWeatherGenerator`](../src/experimental/proceduralWeather.ts#L364) | `type ProceduralWeatherGenerator = (uv: Node<'vec2'>) => Node<'vec4'>` | See source declaration |
| [`ProceduralWeatherParameters`](../src/experimental/proceduralWeather.ts#L54) | `interface ProceduralWeatherParameters` | See source declaration |
| [`rainShaftDefaults`](../src/experimental/rainShafts.ts#L32) | `rainShaftDefaults: Readonly<RainShaftParams>` | See source declaration |
| [`RainShaftParams`](../src/experimental/rainShafts.ts#L21) | `interface RainShaftParams` | See source declaration |
| [`RainShaftUniforms`](../src/experimental/rainShafts.ts#L206) | `interface RainShaftUniforms` | See source declaration |
| [`resolveTimeOfDay`](../src/experimental/timeOfDay.ts#L90) | `resolveTimeOfDay(date: Date \| number, timeOfDay: number, location: TimeOfDayLocation): Date` | The instant a local solar time of day names, on a date already in some<br>timezone. `timeOfDay` is a fraction of a day in LOCAL SOLAR time: 0 is local<br>midnight, 0.5 local noon. Longitude is the only thing that converts it, at 15<br>degrees per hour, so the result wraps across UTC midnight instead of<br>clamping. |
| [`ScenePreset`](../src/experimental/scenePresets.ts#L47) | `interface ScenePreset` | A sky, assembled from existing knobs. `timeOfDay` is local solar time as a<br>fraction of a day, so 0.5 is local noon for every longitude, and what the sun<br>does with it depends on the observer's latitude and the date: 0.75 is sunset<br>at any latitude on an equinox, and earlier or later by up to an hour either<br>side of it. |
| [`ScenePresetName`](../src/experimental/scenePresets.ts#L38) | `type ScenePresetName = (typeof scenePresetNames)[number]` | See source declaration |
| [`scenePresetNames`](../src/experimental/scenePresets.ts#L27) | `scenePresetNames: readonly ["partlyCloudy", "fluffy", "pixar", "stunningSunset", "moonlitNight", "hazy", "thunderstorm", "stormyEvening"]` | See source declaration |
| [`ScenePresetRequest`](../src/experimental/scenePresets.ts#L553) | `interface ScenePresetRequest` | The instant and the place, plus where the sun and moon go |
| [`scenePresets`](../src/experimental/scenePresets.ts#L511) | `scenePresets: Record<"partlyCloudy" \| "fluffy" \| "pixar" \| "stunningSunset" \| "moonlitNight" \| "hazy" \| "thunderstorm" \| "stormyEvening", ScenePreset>` | See source declaration |
| [`ScenePresetTarget`](../src/experimental/scenePresets.ts#L535) | `interface ScenePresetTarget` | What a preset writes on the clouds side. `CloudsContext` satisfies it, and<br>so does a plain object, because every field is a property the preset already<br>knows how to set. Experimental options merge rather than replace, so a preset<br>that wants one option does not silently clear the caller's other choices. |
| [`TimeOfDayLocation`](../src/experimental/timeOfDay.ts#L19) | `interface TimeOfDayLocation` | Where the observer is: degrees, metres. A `Geodetic` from<br>`@takram/three-geospatial` is accepted as it stands. |
| [`TimeOfDayRequest`](../src/experimental/timeOfDay.ts#L111) | `interface TimeOfDayRequest` | What a caller hands `syncCelestialDirections` |
| [`TWILIGHT_SIN_ELEVATION`](../src/experimental/moonlight.ts#L20) | `TWILIGHT_SIN_ELEVATION: -0.104528` | See source declaration |
| [`WaterProCloudSky`](../src/experimental/waterProSky.ts#L208) | `class WaterProCloudSky` | Water Pro's sky, backed by `cloudsPass.environment`. |
| [`WaterProCloudSkyOptions`](../src/experimental/waterProSky.ts#L67) | `interface WaterProCloudSkyOptions` | See source declaration |
| [`WaterProSkyProvider`](../src/experimental/waterProSky.ts#L50) | `interface WaterProSkyProvider` | The seam Water Pro's `WaterSystem.setSky` binds a sky provider to, at 3.5.1. |
| [`WeatherChannel`](../src/experimental/proceduralWeather.ts#L32) | `type WeatherChannel = 'low' \| 'mid' \| 'high'` | See source declaration |
| [`WeatherChannelNodes`](../src/experimental/proceduralWeather.ts#L200) | `interface WeatherChannelNodes` | See source declaration |
| [`WeatherChannelParameters`](../src/experimental/proceduralWeather.ts#L34) | `interface WeatherChannelParameters` | See source declaration |
| [`WeatherPattern`](../src/experimental/proceduralWeather.ts#L30) | `type WeatherPattern = 'clumps' \| 'bands' \| 'scattered'` | See source declaration |

## Reference and testing support

| Export | Signature | Description |
| --- | --- | --- |
| [`applyPortDefaults`](../src/referenceMode.ts#L130) | `applyPortDefaults(ctx: CloudsContext): boolean` | See source declaration |
| [`applyReferenceMode`](../src/referenceMode.ts#L101) | `applyReferenceMode(ctx: CloudsContext): boolean` | See source declaration |
| [`CameraUniforms`](../src/CameraUniforms.ts#L20) | `class CameraUniforms` | See source declaration |
| [`cpuBlendCloudTypeParameter`](../src/experimental/cloudTypeMap.ts#L390) | `cpuBlendCloudTypeParameter(base: [number, number, number, number], morph: number, param: CloudTypeParam, anchors: readonly CloudTypeArchetype[]): [number, number, number, number]` | See source declaration |
| [`cpuCloudShadowTransmittance`](../src/shadow/cloudShadowNode.ts#L88) | `cpuCloudShadowTransmittance(opticalDepth: number): number` | See source declaration |
| [`cpuCloudTypeTentWeights`](../src/experimental/cloudTypeMap.ts#L382) | `cpuCloudTypeTentWeights(morph: number): [number, number, number]` | See source declaration |
| [`createHashJitterTexture`](../src/textures/loadBakedCloudTextures.ts#L381) | `createHashJitterTexture(): Data3DTexture` | The white-noise hash volume the jitter defaulted to before blue noise. It is<br>still exported because the parity harness samples it, and its bytes are part<br>of the ladder's committed evidence, so replacing the default with it would<br>move every captured metric. |
| [`createLayerUniforms`](../src/layerUniforms.ts#L35) | `createLayerUniforms(): LayerUniforms` | See source declaration |
| [`flashEnvelopeCPU`](../src/experimental/lightning.ts#L271) | `flashEnvelopeCPU(time: number, seed: number, options?: Readonly<FlashScheduleOptions>): FlashSample` | See source declaration |
| [`flashPositionCPU`](../src/experimental/lightning.ts#L312) | `flashPositionCPU(index: number, seed: number, bottomRadius: number, altitude: number): Vector3` | See source declaration |
| [`getSTBN`](../src/march/jitter.ts#L30) | `getSTBN(stbnTexture: Data3DTexture \| TextureNode, frame: Node<"float"> \| Node<"int">, coordinate?: Node<"vec2">, name?: string): Node<"float">` | See source declaration |
| [`illuminatedFractionCPU`](../src/experimental/moonlight.ts#L33) | `illuminatedFractionCPU(sunDirection: Vector3, moonDirection: Vector3): number` | See source declaration |
| [`LayerUniforms`](../src/layerUniforms.ts#L13) | `interface LayerUniforms` | See source declaration |
| [`moonlightCPU`](../src/experimental/moonlight.ts#L47) | `moonlightCPU(sunDirection: Vector3, moonDirection: Vector3, cameraPositionECEF: Vector3, gain: number, color: Vector3, out: { lightDirection: Vector3; irradianceRatio: Vector3; }): { blend: number; illuminated: number; }` | See source declaration |
| [`PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION`](../src/referenceMode.ts#L18) | `PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION: true` | See source declaration |
| [`REFERENCE_MODE`](../src/referenceMode.ts#L69) | `REFERENCE_MODE: ReferenceModePins` | See source declaration |
| [`REFERENCE_MODE_PORT_ONLY_PATHS`](../src/referenceMode.ts#L79) | `REFERENCE_MODE_PORT_ONLY_PATHS: readonly string[]` | See source declaration |
| [`REFERENCE_SHADOW_UPDATE_INTERVAL`](../src/referenceMode.ts#L23) | `REFERENCE_SHADOW_UPDATE_INTERVAL: 1` | See source declaration |
| [`referenceModePins`](../src/referenceMode.ts#L89) | `referenceModePins(ctx: CloudsContext): ReferenceModePins` | See source declaration |
| [`ReferenceModePins`](../src/referenceMode.ts#L62) | `interface ReferenceModePins` | See source declaration |
| [`shadowRadiusFromFootprintCPU`](../src/shadow/shadowRadius.ts#L111) | `shadowRadiusFromFootprintCPU(sizePx: number, shadowRadius?: number): number` | See source declaration |
| [`twilightBlendCPU`](../src/experimental/moonlight.ts#L25) | `twilightBlendCPU(sunElevation: number): number` | See source declaration |
| [`updateLayerUniforms`](../src/layerUniforms.ts#L156) | `updateLayerUniforms(uniforms: LayerUniforms, ctx: CloudsContext): void` | See source declaration |

## React adapter

These bindings own React lifecycle, not the renderer or final render pipeline. Their props and hook contracts are separate from the vanilla entrypoint.

### /r3f: CloudLayer

[Source](../src/r3f/CloudLayer.tsx#L45)

```ts
CloudLayer(props: CloudLayerProps): ReactNode | Promise<ReactNode>
```

Declare one of four cloud slots inside Clouds or CloudLayers
Changing index releases the old slot, unmount restores its default and frees it
With disableDefaultLayers, released slots return to zero height instead

### /r3f: CloudLayerProps

[Source](../src/r3f/CloudLayer.tsx#L27)

```ts
interface CloudLayerProps
```

One declarative layer, rebuilt from its slot default and props on each render
Removed props return to that slot's default rather than keeping old values
Altitude and height are metres, as on the underlying CloudLayer
Nested densityProfile applies first, explicit dashed coefficients win

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `ref` | `Ref<CloudLayerImpl> \| undefined` |  | The current slot object, updated when explicit requests move an automatic layer |
| `index` | `0 \| 3 \| 2 \| 1 \| undefined` |  | A unique slot from 0 through 3. Invalid or occupied slots throw.<br>Explicit requests take priority, including later mounts and index changes<br>Omit for a free slot, retained unless an explicit request moves it<br>A fifth layer throws |
| `densityProfile` | `DensityProfileLike \| undefined` |  | Partial coefficient patch, omitted or nullish values keep current values |
| `altitude` | `number \| undefined` |  | Height of the band's base above the bottom radius, in metres |
| `shapeAmount` | `number \| undefined` |  | Weight of the base shape noise |
| `shapeDetailAmount` | `number \| undefined` |  | Weight of the high-frequency detail noise. Ignored when<br>`CloudsContext.shapeDetail` is off |
| `shapeAlteringBias` | `number \| undefined` |  | Bias on the shape-altering parabola, which moves density toward the middle<br>of the band |
| `densityScale` | `number \| undefined` |  | Weight of this layer's density in the march |
| `channel` | `TextureChannel \| undefined` |  | Local weather channel this layer reads |
| `height` | `number \| undefined` |  | Thickness of the band, in metres. 0 leaves the lane empty |
| `weatherExponent` | `number \| undefined` |  | Exponent applied to the weather channel. 1 keeps it unchanged |
| `coverageFilterWidth` | `number \| undefined` |  | Width of the soft ramp where weather crosses the coverage threshold. 0 cuts<br>hard |
| `shadow` | `boolean \| undefined` |  | Whether this layer casts into the cloud shadow map. Changing whether any<br>layer casts shadows changes the compiled graph |
| `densityProfile-expTerm` | `number \| undefined` |  | No additional contract documented; see source |
| `densityProfile-exponent` | `number \| undefined` |  | No additional contract documented; see source |
| `densityProfile-linearTerm` | `number \| undefined` |  | No additional contract documented; see source |
| `densityProfile-constantTerm` | `number \| undefined` |  | No additional contract documented; see source |

### /r3f: CloudLayers

[Source](../src/r3f/CloudLayers.tsx#L216)

```ts
CloudLayers(props: CloudLayersProps): ReactNode | Promise<ReactNode>
```

Provide fixed-slot allocation for advanced composition with an existing context
Normal Clouds usage installs this provider automatically

### /r3f: CloudLayersContext

[Source](../src/r3f/CloudLayers.tsx#L28)

```ts
CloudLayersContext(props: ProviderProps<CloudLayersContextValue | null>): ReactNode
```

Advanced provider access, normally installed by Clouds

### /r3f: CloudLayersContextValue

[Source](../src/r3f/CloudLayers.tsx#L18)

```ts
interface CloudLayersContextValue
```

Advanced allocation state, normally managed through CloudLayer children

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `layers` | `CloudLayersImpl` |  | The borrowed four-slot collection |
| `indexPool` | `number[]` |  | Unclaimed indices, maintained by child mounts and unmounts |
| `disableDefault` | `boolean` |  | Whether unclaimed slots reset to the empty standalone layer |

### /r3f: CloudLayersProps

[Source](../src/r3f/CloudLayers.tsx#L203)

```ts
interface CloudLayersProps
```

Bind declarative children to an existing four-slot collection

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `layers` | `CloudLayersImpl` |  | Borrowed collection, this component does not own GPU resources |
| `disableDefault` | `boolean \| undefined` |  | Default false, true resets unclaimed slots to zero-height CloudLayer.DEFAULT |
| `children` | `ReactNode` |  | At most four simultaneously claimed CloudLayer slots |

### /r3f: Clouds

[Source](../src/r3f/Clouds.tsx#L304)

```ts
Clouds(props: CloudsProps): ReactNode | Promise<ReactNode>
```

Own a pass and asset-loading lifecycle, not a complete render pipeline
Requires: a Fiber canvas with native WebGPU, app-owned composition and providers
Ownership: URL textures are disposed on replacement or unmount
The owned pass, context and generated default jitter are disposed on unmount
Passed texture and generator objects remain borrowed and are never disposed
Loading or failed assets gate rendering without changing context.enabled

### /r3f: CloudsAssetState

[Source](../src/r3f/Clouds.tsx#L77)

```ts
type CloudsAssetState =
  | { status: 'loading' | 'ready'; error: null }
  | { status: 'error'; error: Error }
```

URL assets load before ready, objects and lazy default jitter are ready inputs
An error disables the pass until inputs change and all assets become ready
This does not validate borrowed textures or prove a GPU frame rendered

### /r3f: CloudsPassContext

[Source](../src/r3f/Clouds.tsx#L82)

```ts
CloudsPassContext(props: ProviderProps<CloudsPassContextValue | null>): ReactNode
```

Advanced provider access, prefer useClouds inside the component tree

### /r3f: CloudsPassContextValue

[Source](../src/r3f/Clouds.tsx#L63)

```ts
interface CloudsPassContextValue
```

Mounted resources borrowed from the enclosing Clouds component

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `pass` | `CloudsPassNode` |  | Compose this pass, but do not dispose it independently of the component |
| `context` | `CloudsContext` |  | Configuration state, with caller-driven time and frame values |
| `assets` | `CloudsAssetState` |  | Asset lifecycle only, not shader compilation or visible-frame evidence |

### /r3f: CloudsProps

[Source](../src/r3f/Clouds.tsx#L252)

```ts
interface CloudsProps
```

Declarative context inputs, with the same units and graph effects as the context
A preset applies before explicit scalar overrides on each React render
Omitted scalar props preserve current values, time and frame never auto-advance

| Member | Type | Initial expression (source) | Contract |
| --- | --- | --- | --- |
| `ref` | `Ref<CloudsPassNode> \| undefined` |  | The mounted pass, cleared on unmount, never independently disposed |
| `sceneDepth` | `TextureNode \| null` |  | Required depth policy: a scene depth node, or explicit null for sky-only<br>Keep node identity stable between intentional replacements<br>Replacing node identity keeps the pass but rebuilds its graph and history |
| `debug` | `DebugView \| undefined` |  | Debug output selection, omitted preserves the current selection |
| `disableDefaultLayers` | `boolean \| undefined` |  | Default false, true leaves undeclared layer slots empty |
| `experimental` | `Partial<ExperimentalCloudOptions> \| undefined` |  | A validated partial patch, absent experiment keys keep their current values |
| `qualityPreset` | `QualityPreset \| undefined` |  | Reapplied before scalar props, so explicit resolutionScale wins |
| `sunDirection` | `Vector3 \| undefined` |  | Normalized ECEF direction copied into the context, no automatic sun clock |
| `worldToECEFMatrix` | `Matrix4 \| undefined` |  | World metres to ECEF metres, copied rather than retaining this matrix |
| `localWeatherTexture` | `string \| Texture<unknown, TextureEventMap> \| ProceduralTextureLike<Texture<unknown, TextureEventMap>> \| undefined` |  | Borrow an object or load an owned URL texture, defaults to the baked URL |
| `shapeTexture` | `string \| Data3DTexture \| ProceduralTextureLike<Storage3DTexture> \| undefined` |  | Borrow a volume/generator or load its raw bytes, defaults to the baked URL |
| `shapeDetailTexture` | `string \| Data3DTexture \| ProceduralTextureLike<Storage3DTexture> \| undefined` |  | Borrow a detail volume/generator or load bytes, defaults to the baked URL |
| `turbulenceTexture` | `string \| Texture<unknown, TextureEventMap> \| ProceduralTextureLike<Texture<unknown, TextureEventMap>> \| undefined` |  | Borrow an object or load an owned URL texture, defaults to the baked URL |
| `stbnTexture` | `string \| Data3DTexture \| undefined` |  | Borrow a volume or load a URL, omission generates owned jitter without fetch |
| `children` | `ReactNode` |  | CloudLayer declarations and consumers of useClouds |
| `frame` | `number \| undefined` |  | Which frame this is. Must advance every frame while `temporalUpscale` is<br>on, or the resolve reprojects against stale history. See the `time` and<br>`frame` contract in WEBGPU.md.<br>Domain: an integer sample index supplied once per rendered frame |
| `coverage` | `number \| undefined` |  | How much of the weather map becomes cloud. 0 is clear sky, 1 overcast<br>Domain: normally [0, 1], assignment is not validated or clamped<br>Mutation: a per-frame uniform, with no graph rebuild |
| `scatteringCoefficient` | `number \| undefined` |  | Scattering coefficient of the participating medium |
| `absorptionCoefficient` | `number \| undefined` |  | Absorption coefficient of the participating medium |
| `turbulenceDisplacement` | `number \| undefined` |  | How far the turbulence noise displaces the shape noise, in metres |
| `skyLightScale` | `number \| undefined` |  | Multiplier on the sky's contribution to cloud lighting |
| `groundBounceScale` | `number \| undefined` |  | Multiplier on light bounced off the ground into cloud bases. 0 turns ground<br>bounce off, which also removes the ground march. |
| `powderScale` | `number \| undefined` |  | Strength of the powder darkening in dense, shadowed cloud |
| `powderExponent` | `number \| undefined` |  | Height falloff of that powder darkening |
| `scatterAnisotropyMix` | `number \| undefined` |  | No additional contract documented; see source |
| `resolutionScale` | `number \| undefined` |  | March resolution as a fraction of the frame. Below 1 costs quality |
| `sunAngularRadius` | `number \| undefined` |  | Sun angular radius in radians, which the sun disc and penumbra use |
| `bottomRadius` | `number \| undefined` |  | Radius at which a ray is treated as hitting the surface, in metres |
| `correctAltitude` | `boolean \| undefined` |  | Whether `updateCamera` applies the altitude correction offset |
| `cameraHeight` | `number \| undefined` |  | Camera height above the ellipsoid, in metres, from `updateCamera` |
| `time` | `number \| undefined` |  | Seconds of cloud motion to show. This is a pure function input, not a<br>clock: set it from your own and never let the library advance it. Wind is<br>derived from it as base offset plus velocity times `time`. |
| `warnings` | `boolean \| undefined` |  | Whether the context may warn on the console, a stale frame for example |
| `enabled` | `boolean \| undefined` |  | Whether the pass marches at all. `false` compiles the composite to a<br>pass-through, so it rebuilds the graph and, when turned back on, clears<br>history. The supported switch, where the dropped `skipRendering` is not. |

### /r3f: useClouds

[Source](../src/r3f/Clouds.tsx#L91)

```ts
useClouds(): CloudsPassContextValue
```

Read the enclosing Clouds pass, context and loading/ready/error asset state
Requires: call inside a mounted Clouds descendant, otherwise it throws
Ownership: returned resources are borrowed and become invalid on unmount
The app still wires providers, atmosphere and its render pipeline

## Current defaults

These tables are read from the built package, not transcribed from prose. Values are initial defaults, not runtime range validation.

### Experimental options

Source: `experimentalDefaults`. Changing an option rebuilds the graph and invalidates temporal history. A partial assignment preserves other options.

| Option | Default | Details |
| --- | --- | --- |
| `cloudFrontRefinement` | `true` | [Behavior and cost](EXPERIMENTAL.md#cloudfrontrefinement) |
| `computeResolve` | `false` | [Behavior and cost](EXPERIMENTAL.md#computeresolve) |
| `windReprojection` | `false` | [Behavior and cost](EXPERIMENTAL.md#windreprojection) |
| `distantCloudShadows` | `false` | [Behavior and cost](EXPERIMENTAL.md#distantcloudshadows) |
| `directionalSkylight` | `false` | [Behavior and cost](EXPERIMENTAL.md#directionalskylight) |
| `distantShapeDetailFade` | `true` | [Behavior and cost](EXPERIMENTAL.md#distantshapedetailfade) |
| `cloudTypeMap` | `false` | [Behavior and cost](EXPERIMENTAL.md#cloudtypemap) |
| `evolvingWeather` | `false` | [Behavior and cost](EXPERIMENTAL.md#evolvingweather) |
| `proceduralWeather` | `false` | [Behavior and cost](EXPERIMENTAL.md#proceduralweather) |
| `convectiveProfile` | `false` | [Behavior and cost](EXPERIMENTAL.md#convectiveprofile) |
| `rainShafts` | `false` | [Behavior and cost](EXPERIMENTAL.md#rainshafts) |
| `moonlight` | `false` | [Behavior and cost](EXPERIMENTAL.md#moonlight) |
| `lightning` | `false` | [Behavior and cost](EXPERIMENTAL.md#lightning) |
| `cloudEnvironment` | `false` | [Behavior and cost](EXPERIMENTAL.md#cloudenvironment) |
| `staticMode` | `false` | [Behavior and cost](EXPERIMENTAL.md#staticmode) |
| `cirrusDeck` | `false` | [Behavior and cost](EXPERIMENTAL.md#cirrusdeck) |
| `shadowRoundRobin` | `false` | [Behavior and cost](EXPERIMENTAL.md#shadowroundrobin) |

### Quality presets

Source: `defaults` and `qualityPresets`. A new context starts at `high`. Apply a preset before local overrides; reapplying it restores the preset fields. Preset objects are shared definitions, not mutable per-instance state.

| Field | low | medium | high | ultra | lowEnd |
| --- | --- | --- | --- | --- | --- |
| `resolutionScale` | `1` | `1` | `1` | `1` | `0.5` |
| `lightShafts` | `false` | `false` | `true` | `true` | `true` |
| `shapeDetail` | `false` | `true` | `true` | `true` | `true` |
| `turbulence` | `false` | `false` | `true` | `true` | `false` |
| `haze` | `true` | `true` | `true` | `true` | `false` |
| `clouds.multiScatteringOctaves` | `8` | `8` | `8` | `8` | `8` |
| `clouds.accurateSunSkyLight` | `false` | `false` | `true` | `true` | `false` |
| `clouds.accuratePhaseFunction` | `false` | `false` | `false` | `false` | `false` |
| `clouds.maxIterationCount` | `200` | `500` | `500` | `500` | `500` |
| `clouds.minStepSize` | `100` | `50` | `50` | `10` | `200` |
| `clouds.maxStepSize` | `1000` | `1000` | `1000` | `1000` | `1000` |
| `clouds.maxRayDistance` | `100000` | `200000` | `200000` | `200000` | `200000` |
| `clouds.perspectiveStepScale` | `1.01` | `1.01` | `1.01` | `1.01` | `1.01` |
| `clouds.minDensity` | `0.0001` | `0.0001` | `0.00001` | `0.00001` | `0.0001` |
| `clouds.minExtinction` | `0.0001` | `0.0001` | `0.00001` | `0.00001` | `0.0001` |
| `clouds.minTransmittance` | `0.1` | `0.01` | `0.01` | `0.01` | `0.01` |
| `clouds.maxIterationCountToGround` | `0` | `1` | `3` | `3` | `0` |
| `clouds.maxIterationCountToSun` | `1` | `2` | `2` | `2` | `0` |
| `clouds.minSecondaryStepSize` | `100` | `100` | `100` | `100` | `100` |
| `clouds.secondaryStepScale` | `2` | `2` | `2` | `2` | `2` |
| `clouds.maxShadowFilterRadius` | `6` | `6` | `6` | `6` | `6` |
| `clouds.maxShadowLengthIterationCount` | `500` | `500` | `500` | `500` | `500` |
| `clouds.minShadowLengthStepSize` | `50` | `50` | `50` | `50` | `50` |
| `clouds.maxShadowLengthRayDistance` | `200000` | `200000` | `200000` | `200000` | `200000` |
| `clouds.hazeDensityScale` | `0.00003` | `0.00003` | `0.00003` | `0.00003` | `0.00003` |
| `clouds.hazeExponent` | `0.001` | `0.001` | `0.001` | `0.001` | `0.001` |
| `clouds.hazeScatteringCoefficient` | `0.9` | `0.9` | `0.9` | `0.9` | `0.9` |
| `clouds.hazeAbsorptionCoefficient` | `0.5` | `0.5` | `0.5` | `0.5` | `0.5` |
| `shadow.cascadeCount` | `2` | `3` | `3` | `3` | `1` |
| `shadow.mapSize` | `[256,256]` | `[256,256]` | `[512,512]` | `[1024,1024]` | `[128,128]` |
| `shadow.maxFar` | `null` | `null` | `null` | `null` | `null` |
| `shadow.farScale` | `1` | `1` | `1` | `1` | `1` |
| `shadow.splitMode` | `2` | `2` | `2` | `2` | `2` |
| `shadow.splitLambda` | `0.6` | `0.6` | `0.6` | `0.6` | `0.6` |
| `shadow.temporalPass` | `true` | `true` | `true` | `true` | `true` |
| `shadow.temporalJitter` | `true` | `true` | `true` | `true` | `true` |
| `shadow.maxIterationCount` | `25` | `50` | `50` | `50` | `50` |
| `shadow.minStepSize` | `100` | `100` | `100` | `100` | `100` |
| `shadow.maxStepSize` | `1000` | `1000` | `1000` | `1000` | `1000` |
| `shadow.minDensity` | `0.0001` | `0.0001` | `0.00001` | `0.00001` | `0.0001` |
| `shadow.minExtinction` | `0.0001` | `0.0001` | `0.00001` | `0.00001` | `0.0001` |
| `shadow.minTransmittance` | `0.01` | `0.0001` | `0.0001` | `0.0001` | `0.0001` |
| `shadow.opticalDepthTailScale` | `2` | `2` | `2` | `2` | `2` |
| `shadow.updateInterval` | `2` | `2` | `2` | `2` | `4` |
| `temporalUpscale` | not set | not set | not set | not set | `true` |
| `lightShaftsHalfResolution` | not set | not set | not set | not set | `true` |

### Layer defaults

Source: `CloudLayer.DEFAULT` (standalone empty layer) and `CloudLayers.DEFAULT` (the context’s fixed slots). Altitude and height are metres. A zero height disables a slot without changing the slot count.

| Field | Standalone | Slot 0 | Slot 1 | Slot 2 | Slot 3 |
| --- | --- | --- | --- | --- | --- |
| `channel` | `"r"` | `"r"` | `"g"` | `"b"` | `"a"` |
| `altitude` | `0` | `750` | `1000` | `7500` | `0` |
| `height` | `0` | `650` | `1200` | `500` | `0` |
| `densityScale` | `0.2` | `0.2` | `0.2` | `0.003` | `0.2` |
| `shapeAmount` | `1` | `1` | `1` | `0.4` | `1` |
| `shapeDetailAmount` | `1` | `1` | `1` | `0` | `1` |
| `weatherExponent` | `1` | `1` | `1` | `1` | `1` |
| `shapeAlteringBias` | `0.35` | `0.35` | `0.35` | `0.35` | `0.35` |
| `coverageFilterWidth` | `0.6` | `0.6` | `0.6` | `0.5` | `0.6` |
| `densityProfile.expTerm` | `0` | `0` | `0` | `0` | `0` |
| `densityProfile.exponent` | `0` | `0` | `0` | `0` | `0` |
| `densityProfile.linearTerm` | `0.75` | `0.75` | `0.75` | `0.75` | `0.75` |
| `densityProfile.constantTerm` | `0.25` | `0.25` | `0.25` | `0.25` | `0.25` |
| `shadow` | `false` | `true` | `true` | `false` | `false` |
