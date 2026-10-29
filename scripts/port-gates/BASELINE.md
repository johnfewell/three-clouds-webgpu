# Gate baselines — @takram/three-clouds 0.7.6

Measured 2026-08-30 on `reference/clouds/src` (vendored upstream, commit b012ad06).
Tools: oxlint 1.80.0, decision-points.mjs (AUDIT-2 revision), comment-audit.mjs.

## 1. oxlint complexity (max 13)

```
pnpm dlx oxlint@1.80.0 -c scripts/port-gates/oxlintrc.json reference/clouds/src
```

**Result: PASS (exit 0).** No `eslint(complexity)` errors at max 13.
6 `no-unused-vars` warnings (not gated).

Maximum: **13** — `CloudsEffect.ts:229` constructor.

Top functions (enumerated at max 1):

| Complexity | File | Function |
|---|---|---|
| 13 | CloudsEffect.ts:229 | constructor |
| 12 | uniforms.ts:124 | updateCloudLayerUniforms |
| 10 | helpers/FrustumCorners.ts:88 | split |
| 8 | CloudsEffect.ts:405 | updateAtmosphereComposition |
| 8 | CloudsEffect.ts:454 | update |
| 8 | CloudsMaterial.ts:263 | onBeforeRender |
| 8 | CloudsMaterial.ts:311 | copyCameraSettings |
| 8 | ShadowPass.ts:80 | initRenderTargets |
| 7 | CloudLayers.ts:141 | packIntervalHeights |
| 7 | CloudsResolveMaterial.ts:50 | constructor |
| 7 | r3f/Clouds.tsx:141 | (anonymous) |

69 of 80 functions at complexity ≤ 5.

## 2. decision-points GLSL (max 12)

```
node scripts/port-gates/decision-points.mjs reference/clouds/src/shaders --max 12
```

```
94 shader functions · max 12 (clouds.frag:472 marchClouds) · gate 12 · 0 over
  12   5#if clouds.frag:472                              marchClouds
   9  17#if clouds.frag:823                              main
   8   2#if shadow.frag:37                               marchClouds
   7   1#if clouds.frag:185                              sampleShadowOpticalDepthPCF
   7   0#if clouds.glsl:15                               getCubeSphereUv
   6   0#if clouds.frag:743                              getRayNearFar
   6   4#if cloudsResolve.frag:63                        temporalUpscale
   5   0#if clouds.frag:139                              getCascadeColor
   5   3#if cloudsResolve.frag:120                       temporalAntialiasing
   5   0#if shadowResolve.frag:51                        cascade
   4   7#if clouds.frag:252                              getCascadedShadowMaps
   4   0#if clouds.frag:772                              getShadowRayNearFar
   4   0#if clouds.frag:793                              getHazeRayNearFar
   4   0#if clouds.glsl:57                               insideLayerIntervals
   4   0#if structuredSampling.glsl:6                    getIcosahedralVertices
histogram {"11-15":1,"6-10":6,"1-5":87}
```

87 of 94 functions at 1–5 decision points.

## 3. comment-audit

```
node scripts/port-gates/comment-audit.mjs reference/clouds/src
```

```
TS       files  31  code  3369  comment   155  blank   508  comment/code 0.05  doc-blocks 2
GLSL     files  21  code  2106  comment   304  blank   351  comment/code 0.14  doc-blocks 5
all      files  52  code  5475  comment   459  blank   859  comment/code 0.08  doc-blocks 7
```

Tags: `{"TODO":10,"FIXME":0,"HACK":0,"NOTE":1,"XXX":0}` — 4 paper/author mentions.
Links cited in source: 30.

## 4. Informational: upstream WebGPU sources (not gated)

These are the vendored `reference/atmosphere-webgpu` and `reference/core-webgpu`
(upstream main b012ad06, 2026-05-27). The numbers prove the `FnVar`/`FnLayout`
house style is measured by `decision-points.mjs`, not rejected.

### atmosphere-webgpu

```
89 shader functions · max 19 (AerialPerspectiveNode.ts:144 surfaceLuminance)
histogram {"16+":2,"11-15":2,"6-10":5,"1-5":80}
8 structural problem(s) — all `select(` in class methods (setup/construct)
```

### core-webgpu

```
38 shader functions · max 18 (ScreenSpaceShadowNode.ts:444 (anonymous Fn))
histogram {"16+":1,"6-10":1,"1-5":36}
12 structural problem(s) — 2 unmeasured Fn (FnLayout.ts), 10 flow outside Fn
```

These structural problems are informational: the upstream style uses `select()` in
`setup()` methods and `FnLayout` stored-then-called patterns; the port avoids both
patterns per ADR-010.

## 5. Cross-check: decision-points.mjs vs Lizard (independent tool)

Lizard has no GLSL mode; its C reader tokenizes rather than parses, so the shaders
renamed to `.c` measure correctly — but Lizard counts `#if`/`#ifdef`/`#elif` as
branches. Therefore `lizard CCN == decision-points + #if column` on every function.

```
SCRATCH=<session scratch dir>  # outside the repo; nothing temporary is committed
mkdir -p "$SCRATCH"
for f in reference/clouds/src/shaders/*; do b=$(basename "$f"); cp "$f" "$SCRATCH/${b//./_}.c"; done
uvx lizard -l cpp --sort cyclomatic_complexity "$SCRATCH"
```

Top 10 functions by decision points (measured 2026-08-30, uv 0.11.21 / lizard):

| dp | #if | dp+#if | lizard CCN | agree | File | Function |
|---:|---:|---:|---:|---|---|---|
| 12 | 5 | 17 | 17 | YES | clouds.frag:472 | marchClouds |
| 9 | 17 | 26 | 26 | YES | clouds.frag:823 | main |
| 8 | 2 | 10 | 10 | YES | shadow.frag:37 | marchClouds |
| 7 | 1 | 8 | 8 | YES | clouds.frag:185 | sampleShadowOpticalDepthPCF |
| 7 | 0 | 7 | 7 | YES | clouds.glsl:15 | getCubeSphereUv |
| 6 | 0 | 6 | 6 | YES | clouds.frag:743 | getRayNearFar |
| 6 | 4 | 10 | 10 | YES | cloudsResolve.frag:63 | temporalUpscale |
| 5 | 0 | 5 | 5 | YES | clouds.frag:139 | getCascadeColor |
| 5 | 3 | 8 | 8 | YES | cloudsResolve.frag:120 | temporalAntialiasing |
| 5 | 0 | 5 | 5 | YES | shadowResolve.frag:51 | cascade |

**Result: 10/10 agree — no disagreements.** The two independent counters corroborate
the §2 baseline: `marchClouds` at 12 decision points (+5 compile-time `#if` variants,
reported separately by the gate as graph-time JS in the port) is the true maximum.
