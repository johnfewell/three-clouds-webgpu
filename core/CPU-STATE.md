# CPU state without three

These notes record the experimental core validation from 2026-10-08. The
measurements and gaps below belong to that snapshot, not to a new release
qualification. The core workspace is separate from the shipping cloud API.

`core/src/cpu` computes every per-frame value the default graph's shaders read,
with no import of three or takram (`core/test/isolation.test.ts`). The only
dependency is `astronomy-engine`, the ephemeris takram itself uses.

Every value is compared against the three package on identical inputs. The
comparison is **float64 identity** (`Object.is` per element), which implies an
identical float32 upload. Every test was proven red by mutation.

## How the values are checked

- **Unit twins** compare one core function with its three or takram
  counterpart: `math`, `camera`, `cascades`, `geodesy`, `celestial`,
  `inputs`.
- **The frame twin** (`frame.test.ts`) is the strong one. It runs the live
  port's `CloudsPassNode.updateBefore()` against a renderer stub, as
  `CloudsPassNode.test.ts` does, with the real uniform objects attached.
  `CloudsFrameState.update()` runs alongside it. After every frame, every
  uniform value both sides hold is compared field by field. Every per-cascade
  shadow draw is captured from `setRenderTarget` and compared too.

  | scenario | preset | frames | what it adds |
  | --- | --- | --- | --- |
  | `baseline-medium` | medium | 4 | the spike's case, static, no temporal upscale |
  | `temporal-upscale-moving` | medium | 18 | Bayer jitter over a full 16-frame cycle, odd canvas size, moving camera and sun, wind |
  | `high-interval-1-ecef-rotated` | high | 5 | shadow every frame, a rotated world-to-ECEF frame |
  | `twilight-moonlight-no-altitude` | low | 6 | moonlight on, light handed to the moon, `correctAltitude` off |
  | `structure-and-resize-edits` | ultra | 8 | cascade count 3 to 4, map size, `castsShadow` flips, `temporalPass` off and on, `resolutionScale` |

## Byte-level spot check against the emitter (not committed)

A 2026-10-08 experiment combined the CPU-state implementation with the
experimental emitter in a temporary checkout, then:
1. ran the emitter's side B for `baseline-medium` on its fake device
2. built `CloudsInputs` from the live `CloudsContext`
3. ran `CloudsFrameState`: 6 warm-up frames, a reset, then 3 frames
4. packed every value as float32 at the emitter's field offsets

**174 of 174 fields per frame equal the bytes three wrote**, on frames 0 to 2.
That covers:
- every `camera_`, `march_`, `layer_`, `parameter_`, `shadow_`, `cascade_`,
  `pass_`, `resolve_`, `shadowResolve_`, atmosphere, `shadowConsumer_` and
  `three_` built-in field
- all three per-cascade shadow draws
- both render-group camera writes per frame, which are the quad camera and
  then the scene camera

The same check over seven ladder cases, every field on frames 0 to 2:

| case | what it adds | fields per frame | mismatched |
| --- | --- | --- | --- |
| baseline-medium | the spike's case | 174 | 0 |
| ecef-rotated | world-to-ECEF rotated 28° about Y | 174 | 0 |
| temporal-on-static | temporal upscale (Bayer, quarter-res march) | 177 | 0 |
| temporal-on-orbit | temporal upscale, another pose | 177 | 0 |
| shafts-low-sun | light shafts and cloud shadow, low sun | 184 | 0 |
| shafts-inside-deck | light shafts inside the deck | 184 | 0 |
| shadow-temporal | cloud shadow with temporal upscale | 184 | 0 |

Each case pins its frame and keeps the camera still, as the emitter's protocol
does. Moving cameras, time and sequences are covered by the frame twin against
the live port, not here.

Positive control: nudging `coverage` by 3e-8 and the sun's x by 1e-7 gave 13
mismatches. They were exactly the dependent fields: the cascade draws and
arrays, `march_sunDirection`, `shadowConsumer_sunDirection` and
`parameter_coverage`.

Left unmapped:
- the harness scene's `ground` and `reference_*` fields
- the render-group buffers' contents at the reset, which the per-frame writes
  above overwrite

The spot-check script was not committed. These historical measurements are
not a reproducible release gate; the committed frame-twin tests remain the
repeatable evidence.

## Field table

The **uniform** column holds experimental emitter TSL names
(`<group>_<property>`). Re-check them against the current emitter before use.

**Core field** is the path in `CloudsFrameState`, from `core/src/cpu/frame.ts`.

### Camera (`camera_*`, `updateCameraUniformValues`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| camera_viewMatrix | camera.viewMatrix | CameraUniforms.update | frame twin |
| camera_inverseViewMatrix | camera.inverseViewMatrix | CameraUniforms.update | frame twin |
| camera_inverseProjectionMatrix | camera.inverseProjectionMatrix | CameraUniforms.update, jittered with temporal upscale | frame twin (temporal-upscale-moving) |
| camera_cameraNear | camera.cameraNear | CameraUniforms.update | frame twin |
| camera_cameraFar | camera.cameraFar | CameraUniforms.update | frame twin |
| camera_cameraPosition | camera.cameraPosition | CameraUniforms.update | frame twin |
| camera_cameraPositionECEF | camera.cameraPositionECEF | CameraUniforms.update | frame twin |
| camera_cameraDirectionECEF | camera.cameraDirectionECEF | CameraUniforms.update | frame twin |
| camera_reprojectionMatrix | camera.reprojectionMatrix | CameraUniforms.update + copyReprojectionMatrix | frame twin |
| camera_viewReprojectionMatrix | camera.viewReprojectionMatrix | CameraUniforms.update | frame twin |

The camera itself (`CameraState`) follows r185: `matrixWorldInverse` comes
from `decompose()`, recomposed at scale 1 when the columns are not exactly
unit length. Test: `cascades.test.ts` "camera projection, inverse and view
inverse". The polar pose needs that path: a plain inverse is off by up to
2.4e-10.

### March (`march_*`, `updateMarchUniformValues`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| march_bottomRadius | march.bottomRadius | updateMarchUniforms | frame twin |
| march_sunDirection | march.sunDirection | updateMarchUniforms | frame twin |
| march_lightDirection | march.lightDirection | CloudsContext.updateMoonlight (moonlightCPU) | frame twin (twilight), celestial.test.ts |
| march_moonIrradianceRatio | march.moonIrradianceRatio | CloudsContext.updateMoonlight | frame twin (twilight), celestial.test.ts |
| march_altitudeCorrection | march.altitudeCorrection | CloudsContext.updateCamera (takram getAltitudeCorrectionOffset) | frame twin, geodesy.test.ts |
| march_worldToECEFMatrix | march.worldToECEFMatrix | updateMarchUniforms | frame twin (ecef-rotated) |
| march_ecefToWorldMatrix | march.ecefToWorldMatrix | CloudsContext.updateCamera | frame twin (ecef-rotated) |
| march_worldToUnit | march.worldToUnit | 1 / bottomRadius | frame twin |
| march_cameraHeight | march.cameraHeight | CloudsContext.updateCamera (takram Geodetic height) | frame twin, geodesy.test.ts |
| march_maxIterationCount … march_maxIterationCountToGround (12 fields) | march.* | ctx.clouds.* | frame twin, inputs.test.ts |
| march_skyLightScale, march_groundBounceScale, march_powderScale, march_powderExponent | march.* | ctx.* | frame twin |

### Layers (`layer_*`, `updateLayerUniformValues`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| layer_minLayerHeights, layer_maxLayerHeights | layer.* | CloudLayers.packValues / packSums | frame twin |
| layer_minIntervalHeights, layer_maxIntervalHeights | layer.* | CloudLayers.packIntervalHeights | frame twin |
| layer_densityScales, layer_shapeAmounts, layer_shapeDetailAmounts, layer_weatherExponents, layer_shapeAlteringBiases, layer_coverageFilterWidths | layer.* | CloudLayers.packValues | frame twin |
| layer_densityProfile{ExpTerms,Exponents,LinearTerms,ConstantTerms} | layer.* | CloudLayers.packDensityProfiles | frame twin |
| layer_minHeight, layer_maxHeight, layer_shadowTopHeight, layer_shadowBottomHeight, layer_shadowLayerMask | layer.* | layerUniforms computeHeightBounds | frame twin (castsShadow flip) |

### Parameters (`parameter_*`, `updateParameterUniformValues`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| parameter_resolution, parameter_temporalJitter, parameter_targetUvScale, parameter_mipLevelScale | parameter.* | CloudsPassNode.updateParameterUniformsForFrame | frame twin (both temporal paths) |
| parameter_frame | parameter.frame | ctx.frame | frame twin |
| parameter_localWeatherOffset, parameter_shapeOffset, parameter_shapeDetailOffset | parameter.* | CloudsContext.updateOffsets (base + velocity × time) | frame twin (wind) |
| parameter_*Repeat (4) | parameter.* | ctx.*Repeat | frame twin |
| parameter_scatteringCoefficient, parameter_absorptionCoefficient, parameter_coverage, parameter_turbulenceDisplacement | parameter.* | ctx.* | frame twin |
| parameter_minDensity, parameter_minExtinction, parameter_minTransmittance, parameter_haze* (4) | parameter.* | ctx.clouds.* | frame twin |

### Shadow march (`shadow_*`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| shadow_maxIterationCount … shadow_opticalDepthTailScale (7), shadow_shadowResolution | shadowPass.* | updateShadowPassUniforms | frame twin |
| shadow_inverseShadowMatrix | shadow.draws[i].inverseShadowMatrix | renderShadowPass, per cascade draw | frame twin (captured per draw) |
| shadow_mipLevel | shadow.draws[i].mipLevel | MIP_LEVELS[i] | frame twin |
| shadow_reprojectionMatrix | shadow.draws[i].reprojectionMatrix | storeShadowReprojection, previous fit | frame twin (temporalPass) |
| shadow_cascadeIndex | shadow.draws[i].cascadeIndex | renderShadowPass and renderShadowResolve | frame twin |

### Cascades and composition (`cascade_*`, `pass_*`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| cascade_count | cloudShadow.cascadeCount | updateCloudShadowDescriptor | frame twin |
| cascade_intervals, cascade_matrices, cascade_inverseMatrices | cloudShadow.* (MAX_CASCADE_COUNT entries) | CascadedShadowMaps.update | frame twin, cascades.test.ts |
| cascade_far, cascade_topHeight, cascade_texelSize | cloudShadow.* | updateCloudShadowDescriptor | frame twin |
| pass_shadowFromECEF | cloudShadow.shadowFromECEF | composeShadowFromECEF, every frame | frame twin (skipped frames too) |
| pass_viewZFromECEF | cloudShadow.viewZFromECEF | composeShadowFromECEF | frame twin |

### Temporal resolves (`resolve_*`, `shadowResolve_*`, `updateResolveUniformValues`)

| uniform | core field | port source | test |
| --- | --- | --- | --- |
| resolve_width, resolve_height | resolve.width, resolve.height | renderResolvePass, the full frame size | frame twin, against `frameDimensions()` |
| resolve_temporalAlpha | resolve.temporalAlpha | `CLOUDS_TEMPORAL_ALPHA`, constant | frame twin |
| resolve_varianceGamma | resolve.varianceGamma | `uniform(2)` in ensureResolveTargets, constant | frame twin, parsed from the port's comment-stripped source |
| shadowResolve_temporalAlpha | resolve.shadowTemporalAlpha | shadowTemporalAlpha(ctx) | frame twin |
| shadowResolve_varianceGamma | resolve.shadowVarianceGamma | `uniform(1)` in buildShadowResolveGraph, constant | frame twin, parsed from source |

### three built-ins (`updateBuiltinUniformValues`, `builtins.ts`)

| uniform | core field | three source | test |
| --- | --- | --- | --- |
| three_screenSize, three_screenSize_1 | screenSize, or `CloudsFrameState.size` marchW × marchH in `CloudsPass.object` | the size of the target the pass draws into: the march target for the march pass, the drawing buffer elsewhere. Only temporal-upscale cases tell the two apart | builtins.test.ts, spot check (temporal-on-static) |
| three_viewport | viewport | (0, 0, width, height) | builtins.test.ts, spot check |
| three_dpr | pixelRatio | renderer pixel ratio | spot check |
| three_modelWorldMatrix | modelWorldMatrix (identity) | every full-screen pass | spot check |
| three_modelWorldMatrix (Stars.object) | starsModelWorldMatrix | StarsNode `points.position.copy(camera.position)` | builtins.test.ts (vs `Points`), spot check |
| cameraProjectionMatrix, cameraViewMatrix (render group, quad passes) | quadProjectionMatrix, quadViewMatrix | QuadMesh's `OrthographicCamera(-1, 1, 1, -1, 0, 1)` on WebGPU. Elements 12 to 14 are -0 | builtins.test.ts (vs OrthographicCamera), spot check |
| cameraProjectionMatrix, cameraViewMatrix (render group, scene passes) | CameraState projectionMatrix, matrixWorldInverse | the scene camera | spot check |
| three_matrixUniform, three_matrixUniform_1 | uvTransform | `Texture.updateMatrix()` at defaults. Element 1 is -0 | builtins.test.ts (vs Texture), spot check |
| shadowConsumer_screenResolution | screenResolution | `renderer.getSize()`, the CSS size: an input, since the drawing buffer is floor(css × dpr) | spot check |

A runtime that writes literal identities would lose the -0s, and with them
bit identity. The tests compare with `Object.is`.

### Frame control (not uniforms)

| value | core field | port source | test |
| --- | --- | --- | --- |
| shadow map renders this frame | shadow.rendered | isShadowUpdateDue (updateInterval, structure change, invalid history) | frame twin, from `setRenderTarget(shadowRT)` |
| clear both shadow histories first | shadow.clearHistory | clearHistoryPair when the history is invalid or the resolve targets resize | frame twin, from `setRenderTarget(shadowHistoryRT)` |
| clear the colour history | historyInvalid | `_historyInvalid` after resetHistory | not compared: the stub port never builds the resolve targets |
| march, resolve and full sizes | size | frameDimensions | frame twin, through parameter_resolution and resolve_width |

### Atmosphere context (`updateAtmosphereUniformValues`, `atmosphere.ts`)

These come from takram's `AtmosphereContext`, which the composite, the sky
and the stars bind. They are kept apart from `CloudsFrameState`: the app owns
the atmosphere, and its `bottomRadius` is the atmosphere's
(`AtmosphereParameters`), not the clouds'.

| uniform | core field | takram source | test |
| --- | --- | --- | --- |
| matrixWorldToECEF | matrixWorldToECEF | app-set | atmosphere.test.ts |
| matrixECEFToWorld | matrixECEFToWorld | onRenderUpdate: the **transpose** of matrixWorldToECEF, not the inverse | atmosphere.test.ts (red when swapped for invert) |
| matrixECIToECEF | matrixECIToECEF | app-set, `getECIToECEFRotationMatrix(date)` | atmosphere.test.ts, celestial.test.ts |
| matrixMoonFixedToECEF | matrixMoonFixedToECEF | app-set, `getMoonFixedToECIRotationMatrix(date)` premultiplied by ECI to ECEF | atmosphere.test.ts (200 dates) |
| sunDirectionECEF, moonDirectionECEF | same | app-set, `getSun/MoonDirectionECEF` | atmosphere.test.ts, celestial.test.ts |
| cameraPositionECEF | cameraPositionECEF | onRenderUpdate, camera.matrixWorld position times matrixWorldToECEF | atmosphere.test.ts |
| altitudeCorrectionECEF | altitudeCorrectionECEF | onRenderUpdate, always computed, whatever correctAltitude says | atmosphere.test.ts |
| cameraHeight | cameraHeight | onRenderUpdate, Geodetic height on WGS84 | atmosphere.test.ts |
| takram_skyNode_sunNode_angularRadius, _intensity | AtmosphereInputs.sunAngularRadius, sunIntensity | SunNode defaults | atmosphere.test.ts |
| takram_skyNode_moonNode_angularRadius, _intensity | moonAngularRadius, moonIntensity | MoonNode defaults | atmosphere.test.ts |
| takram_skyNode_starsNode_pointSize, _intensity, _magnitudeRange | starsPointSize, starsIntensity, starsMagnitudeRange | StarsNode defaults | atmosphere.test.ts |
| inverseProjectionMatrix, inverseViewMatrix, projectionMatrix, cameraNear, cameraFar | CameraState projectionMatrixInverse, matrixWorld, projectionMatrix, near, far | takram accessors, plain references to the camera | cascades.test.ts (camera) |

Side B sets only `sunDirectionECEF` and `matrixWorldToECEF`. The ECI and
moon-fixed matrices stay at identity, and the moon direction stays zero,
unless the app writes them.

## The harness's shadow consumer (`shadowConsumer_*`)

The parity harness's side B (`examples/parity/src/sideB.ts` `render()`)
declares these uniforms itself, for `createCloudShadowTransmittance` in the
composite. They are app-side copies of values the core already has:

| uniform | from |
| --- | --- |
| shadowConsumer_viewMatrix | camera.viewMatrix |
| shadowConsumer_cameraNear | camera.cameraNear |
| shadowConsumer_sunDirection | march.sunDirection |
| shadowConsumer_ecefToWorldMatrix | reference.ecefToWorldMatrix, previous frame (see below) |
| shadowConsumer_worldToECEFMatrix | march.worldToECEFMatrix |
| shadowConsumer_altitudeCorrection | reference.altitudeCorrection, previous frame (see below) |
| shadowConsumer_worldToUnit | march.worldToUnit |
| shadowConsumer_temporalJitter | zero: side B never writes it |
| shadowConsumer_resolution | shadowPass.shadowResolution |
| shadowConsumer_screenResolution | `renderer.getSize()`, CSS pixels before device pixel ratio. The runtime supplies it |
| shadowConsumer_shadowFrame | parameter.frame |

From the code, not measured: `render()` copies `ecefToWorldMatrix` and
`altitudeCorrection` before `pipeline.render()` runs the pass that updates
them. So those two carry the previous frame's values: identity and zero on
the first frame after build. A static camera hides this. An emitter comparator
should reproduce the order rather than "fix" it on one side.

## Not covered yet

These fields were bound in the measured default graph but were not computed
by the core:

- **The app's scene**: the `reference_*` and `takram_directionECEF` /
  `takram_indirect` / `takram_intensity` fields of the harness's `ground`
  pipeline.
- **Graph features off in the default graph**: experimental options, light
  shafts, haze, ground bounce, debug views. Their uniforms are computed when
  they exist in the port's uniform objects (the frame twin compares every key),
  but no scenario turns those graph switches on.
- **Static frames**: the port skips a frame whose inputs did not change
  (`StaticModeTracker`, src/experimental/staticMode.ts). That happens only
  with `experimental.staticMode` on, which is off by default and was outside this experiment. `CloudsFrameState` never skips.
- **Early shadows** (`prepareShadow`, for forward-lit receivers) are not
  modelled.

## Findings along the way

- **The spike's 1 km control depends on the axis.** At every ladder pose
  tested, a 1 km camera move along x leaves the port's own cascade fit
  bit-identical: texel snapping absorbs it. A 1 km move along y or z changes
  18 to 22 values. So "the shadow atlas did not move", taken alone, does not
  show that the cascades were replayed (`cascades.test.ts`).
- **The cascades fit a stale light at twilight.** `updateShadowMaps` runs
  `updateMoonlight` before this frame's camera uniforms are written. So the
  twilight blend uses the previous frame's camera position, which is the
  origin on frame 0. That gives blend 1, which is the moon's direction when
  one is set. The core reproduces this (`frame.ts` fitShadowMaps), and the
  twilight scenario covers it.
- **The resize reset of the camera history has no effect** (from the code, not
  measured: the stub port never builds the resolve targets). renderResolvePass
  nulls the previous matrices after the march has used them, and the
  end-of-frame `copyReprojectionMatrix` refills them at once.
- **timeOfDay passes degrees as radians** (`src/experimental/timeOfDay.ts`
  observerPosition). The moon direction is off by up to 1.79 degrees at
  Tokyo in this snapshot; this experiment did not fix it. The core takes the
  observer as ECEF.

## Follow-up validation

Drive the experimental player from `CloudsFrameState` instead of a stored
`state.json`, writing through the emitter's `buffers[*].fields`, and compare
on the GPU. A committed byte-level test should cover the names, field maps
and float32 packing together before treating the historical spot check as a
repeatable acceptance gate.
