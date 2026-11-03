# three-clouds-webgpu

Geospatial volumetric clouds, cloud shadows, light shafts and haze for Three.js
`WebGPURenderer`, with baked assets and an optional React Three Fiber adapter.

**Unofficial port of [@takram/three-clouds](https://github.com/takram-design-engineering/three-geospatial) 0.7.6.**
The original library, design and shaders are by **Shota Matsuda / takram**,
MIT licensed. This project is not affiliated with, endorsed by or supported by
takram. It consumes the published atmosphere and geospatial packages rather
than replacing them.

## Start here

| You want to… | Read or run |
| --- | --- |
| Render a first frame in vanilla Three.js | [Complete vanilla recipe](recipes/vanilla/README.md) |
| Integrate with React Three Fiber | [Complete R3F recipe](recipes/r3f/README.md) |
| Understand the graph, coordinates, updates and cleanup | [Integration guide](INTEGRATION.md) |
| Look up a setting, default, type or ownership contract | [Generated API reference](docs/API.md) |
| Diagnose a black frame or incomplete setup | [Setup diagnostics](docs/CONSUMER_CONTRACT.md) |
| Migrate the WebGL clouds API | [Migration table](docs/MIGRATION.md) |
| Build a custom graph instead of using the helper | [Manual WebGPU wiring](WEBGPU.md#usage) |

These files ship **inside the installed package**, together with readable
source, declarations and source maps. Start with one recipe, not the full
parity harness or Storybook. The recipes are independent projects: they need
the tarball and its public peers, not this repository's workspace.

## Install

[**0.1.0-alpha.7 is published**](https://github.com/johnfewell/three-clouds-webgpu/releases/tag/v0.1.0-alpha.7)
and targets **Three.js 0.187.0**. Install the GitHub Release archive below;
the package is not published on npm. The older alpha.6 archive retains its
original r185/r186 dependency contract.

Download these three archives into your application's `vendor/` directory:

- [three-clouds-webgpu-0.1.0-alpha.7.tgz](https://github.com/johnfewell/three-clouds-webgpu/releases/download/v0.1.0-alpha.7/three-clouds-webgpu-0.1.0-alpha.7.tgz)
- [takram-three-atmosphere-0.19.1+fork.8.tgz](https://raw.githubusercontent.com/johnfewell/three-clouds-webgpu/v0.1.0-alpha.7/vendor/takram-three-atmosphere-0.19.1%2Bfork.8.tgz)
- [takram-three-geospatial-0.9.1+fork.8.tgz](https://raw.githubusercontent.com/johnfewell/three-clouds-webgpu/v0.1.0-alpha.7/vendor/takram-three-geospatial-0.9.1%2Bfork.8.tgz)

The fork archives are pinned to the same release tag. No source checkout or
local package build is needed. Save the release's
[SHA256SUMS](https://github.com/johnfewell/three-clouds-webgpu/releases/download/v0.1.0-alpha.7/SHA256SUMS)
in `vendor/` and verify the clouds archive:

```sh
(cd vendor && shasum -a 256 -c SHA256SUMS)
```

The [release record](https://github.com/johnfewell/three-clouds-webgpu/releases/download/v0.1.0-alpha.7/public-candidate-record.json)
also lists the SHA-256 checksums for both fork archives.

Pin both fork builds in `pnpm-workspace.yaml`. They carry the required runtime
fixes and declarations compatible with r187's typed uniform nodes:

```yaml
overrides:
  '@takram/three-atmosphere': file:./vendor/takram-three-atmosphere-0.19.1+fork.8.tgz
  '@takram/three-geospatial': file:./vendor/takram-three-geospatial-0.9.1+fork.8.tgz
```

Then install the known consumer dependency set:

```sh
pnpm add ./vendor/three-clouds-webgpu-0.1.0-alpha.7.tgz three@0.187.0 @takram/three-atmosphere@0.19.1 @takram/three-geospatial@0.9.1 postprocessing@6.39.4
pnpm add -D typescript@5.9.2 @types/three@0.187.0
```

The pinned `postprocessing` peer still declares an older Three.js range, so
installation reports a peer warning. Even its latest release, 6.39.5, excludes
r187. The native consumer and parity checks cover the combination above; this
does not claim upstream compatibility for every postprocessing effect.

Use ESM, a browser bundler, `moduleResolution: "bundler"`, and
`skipLibCheck: true` for upstream declarations. Application code is still
typechecked. The recipes include the complete configuration.

Import vanilla APIs from `three-clouds-webgpu` or
`three-clouds-webgpu/webgpu`. Import React bindings only from
`three-clouds-webgpu/r3f`; that path additionally needs React 19 and Fiber 9.
The vanilla entrypoints do not import React. Some upstream peers declare
React dependencies even for vanilla use; the standalone vanilla recipe
disables peer auto-installation and explicitly lists the runtime peers above.

| Boundary | Supported or tested scope |
| --- | --- |
| Consumer Three.js | Stock **0.187.0** with `@types/three` **0.187.0**; declared range `>=0.187.0 <0.188.0` |
| Atmosphere / geospatial | Vendored fork builds **0.19.1+fork.8 / 0.9.1+fork.8**, pinned together by `overrides` |
| Browser / backend | Native WebGPU; local hardware evidence uses Chrome on Apple Metal |
| Projection | Perspective camera; orthographic projection is unsupported |
| WebGL2 fallback | Refused, including fallback selected by `WebGPURenderer` |
| Repository development | The same stock Three.js 0.187.0 and fork builds; no dependency is patched |
| TypeScript | Browser-bundler resolution with `skipLibCheck: true`; full-recipe NodeNext is not qualified |

The npm builds of the takram packages fail to import on Three.js 0.185: they
read `struct().layout`, removed in that revision. The fork builds carry the
upstream fix, and the `overrides` keep a single copy of each package.
See the [support details](WEBGPU.md#support-matrix) and
[exact readiness boundary](docs/CONSUMER_CONTRACT.md#supported-consumer-boundary).

### Building a tarball from source

These commands run in a repository clone, not in `node_modules`:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm pack
pnpm pack:verify ./three-clouds-webgpu-0.1.0-alpha.7.tgz
pnpm pack:qualify ./three-clouds-webgpu-0.1.0-alpha.7.tgz --keep-projects
```

Building requires Node 24 and the repository's pinned pnpm. Packing refuses
stale or missing build/declaration output and a stale committed API reference.
`pnpm check` and CI also check the reference without rewriting it; local builds
and typechecks do not block on documentation. Contributors regenerate it with
`pnpm docs:api` after public source changes. Verification extracts the actual
archive, checks its content and local documentation links, and writes a
SHA-256 receipt beside it. `pack:qualify` separately installs and builds both
complete recipes in isolated temporary projects, verifies their assets at root
and nested URL bases, and records a CPU-only receipt under `test-results/`.
`--keep-projects` retains those projects for browser checks. Qualification uses
stock Three.js 0.187.0 with matching types. These CPU checks do not claim GPU
qualification.

Full recipe qualification is opt-in, not part of `pnpm test`; a cold package
store needs network access. Recipe build output, bundler caches and local
lockfiles are excluded from the tarball.

## Integration model

`createCloudsIntegration` wires an existing renderer, perspective camera,
atmosphere context and scene pass into a cloud composition. It returns the
cloud pass, its context, aerial node, output node, explicit update method,
diagnostics and disposal. It does not create your renderer, choose your world
origin, start an animation loop or read a clock. The low-level
`clouds({ sceneDepth })` API remains available.

The scene MRT contains scene color and normals, **not cloud outputs**:

```text
scene color + depth + normal → aerial perspective → cloud composite → tone mapping
                               ↑ cloud shadows / light shafts
```

Configure `integration.context`. Distances are **metres**, time is
**seconds**, and there are exactly **four layer slots**. Advance the integer
frame/sample index once per rendered frame. Apply a quality preset before
local overrides; applying it again restores its fields. Read the
[integration guide](INTEGRATION.md) before changing coordinate or lighting policy.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Import crashes around `struct().layout` | The npm takram builds resolved on three 0.185: add the `overrides` above and reinstall |
| Black frame | Await renderer initialization, call `assertWebGPUSupported`, then inspect `inspectCloudsSetup` diagnostics |
| Texture fetch returns HTML or a byte-count error | Use the recipe's package `?url` imports, not page-relative `assets/...` defaults |
| Ground appears twice lit | Choose either aerial post-lighting or already-lit scene materials, not both |
| Ghosting after a camera jump or time seek | Call `resetHistory()`; keep ordinary time/frame updates explicit |
| Full example fails under NodeNext | Use the supplied bundler tsconfig; the narrow NodeNext import smoke test is not full-recipe support |

A diagnostics result of `configuration: 'valid'` or `assets: 'ready'`
does not prove shader compilation or a rendered frame. See
[readiness and ownership](docs/CONSUMER_CONTRACT.md).

## Features

- A volumetric cloud march with up to four cloud layers, density profiles,
  and the original's baked textures (or procedural ones)
- Cascaded cloud shadow maps on the scene and in the aerial perspective
- Light shafts (crepuscular rays) and haze
- Temporal upscaling or full-resolution temporal anti-aliasing
- The original's quality presets and knob names (the
  [migration table](docs/MIGRATION.md) maps every WebGL property)
- A WebGL fallback recipe (`recipes/webgl-fallback`): when the browser has
  no WebGPU, the app builds the original `@takram/three-clouds` stack on a
  `WebGLRenderer` instead, from the same settings object; the branch is
  chosen once before any renderer exists. The original lacks the port's
  opt-in features, so a fallback frame is a feature-reduced sky; see
  [INTEGRATION.md](INTEGRATION.md#webgl-fallback)
- An opt-in auto-quality governor (`createQualityGovernor(context)`): the
  host feeds frame intervals, and the governor steps the context from its own
  settings down to the perf map's c3 and then to `lowEnd` when half of the
  last ten frames missed vsync at 60 fps, and back up after 120 frames
  without a miss, with a cooldown and a backoff for a step up that proves
  wrong.
  Nothing moves until `arm()`; reference mode disarms it. See
  [INTEGRATION.md](INTEGRATION.md#auto-quality-governor)
- An opt-in `lowEnd` quality preset (`qualityPreset = 'lowEnd'`) for
  low-end or GPU-contended machines: temporal upscaling, a 0.5 resolution
  scale, half-resolution light shafts, no sun march, one 128² shadow cascade
  updated every fourth frame, haze and turbulence off. It is a fallback, not a
  look: the operator judged it acceptable only as one, and it is never the
  default
- Cloud variety, opt-in: six named cloud-type presets
  (`applyCloudTypePreset`: fair-weather cumulus, stratocumulus deck, overcast
  sheet, high cirrus, ground fog, mixed sky), a cloud-type map that varies
  shape by location, evolving weather on a wind field, towering convection with
  anvils, and seeded procedural weather maps
- Opt-in renderer experiments (compute resolve, wind reprojection, distant cloud
  shadows, directional skylight), documented with their cost in
  [docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md)
- Opt-in sky features: cloud-shape controls (darker bases, a horizon coverage
  bank, wind shear, edge shape), rain shafts under convective cells, lightning
  flashes, moonlit clouds, a cirrus deck, clouds in `scene.environmentNode`
  (and a `WaterProCloudSky` adapter for Water Pro), and a static mode that
  skips the cloud passes once a still scene has converged
- Whole-scene helpers: `syncCelestialDirections` sets the sun and moon from a
  place and an instant, and `applyScenePreset` picks a sky by name
- Reference mode: `applyReferenceMode` pins every port-only default to the
  original's behaviour, and `applyPortDefaults` restores the defaults
- A React Three Fiber `<Clouds>` component

## Status

- **Feature-complete.** The clouds march, cloud layers, cloud shadows, light
  shafts and haze are all ported.
- **Beyond the original, opt-in.** Named cloud-type presets, a cloud-type map
  for regional variation, evolving weather on a wind field, towering
  convection, seeded procedural weather maps, cloud-shape controls, rain
  shafts, lightning, moonlight, clouds in the environment map (with a Water Pro
  sky adapter), a static rendering mode for still scenes and a cirrus deck.
  Each is off by default and documented with its cost in
  [docs/EXPERIMENTAL.md](docs/EXPERIMENTAL.md).
- **Parity with the WebGL original:** 57 pass, 5 documented expected
  differences and 1 fail, over 63 A/B cases captured on hardware.
  `node scripts/verify-results.mjs` prints every case's verdict from the
  committed metrics. The one fail is a cloud-shadow case, see
  [Known differences](#known-differences). An earlier run reported 0 fails
  because both sides shared a wrong shadow range; fixing it exposed 13 shadow
  differences, and the committed metrics are where those stand now.
- **Performance:** at library defaults the port is faster than the WebGL
  original at DPR 1 and slower at DPR 2, in a real scene. Storybook Basic, both
  sides at their own defaults, uncapped rAF mean frame, N=5, ABBA order, on an
  Apple M4 Mac mini: **0.92x** the original's frame time at DPR 1 and **1.11x**
  at DPR 2. With settings matched in the parity harness it took **1.38x to
  1.71x** across the four state-matched cases, dominated by the cloud-shadow
  pass rather than by the march. Measured 2026-10-04;
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md) has the protocol, the September 2026
  figures these replace, and what moved between them. Since then a later change
  skips the shadow march's weather read when no layer casts a
  shadow, which cuts the
  port's frame by 26 % at 1280x720 and 32 % at 2560x1440 on the harness
  baseline. Library defaults cast shadows, so the Storybook figures are
  unchanged.

## Examples

These larger examples live in the repository, not in the tarball:

- [Basic](https://github.com/johnfewell/three-clouds-webgpu/blob/main/examples/basic/src/main.ts): minimal plain Three.js consumer.
- [3D Tiles](https://github.com/johnfewell/three-clouds-webgpu/blob/main/examples/tiles/README.md): Google Photorealistic 3D Tiles with clouds, atmosphere and cloud shadows on tiles.
- [React Three Fiber](https://github.com/johnfewell/three-clouds-webgpu/blob/main/examples/r3f/README.md): consumer with `<Clouds>`.
- [Storybook](https://github.com/johnfewell/three-clouds-webgpu/blob/main/examples/storybook/README.md): interactive stories.
- [Parity](https://github.com/johnfewell/three-clouds-webgpu/blob/main/examples/parity/README.md): the 63-case A/B visual comparison ladder.

## Known differences

- **Procedural textures.** The original's compiled Worley loop differs from
  its own source. The port follows the source, so procedural local weather
  differs. Baked textures are unaffected
  ([ADR-014](docs/adr/014-worley-compiled-path-divergence.md)).
- **Debug views** (cascades, sample count, front depth) are not pixel-parity
  ([ADR-011 Amendment 6](docs/adr/011-parity-methodology.md)), and the shadow
  map view differs only in a channel that does not affect rendering
  ([ADR-011 Amendment 13](docs/adr/011-parity-methodology.md)).
- **The atmosphere uses its LUT lookup.** One case, `below-deck-1km`, keeps
  the raymarch
  ([ADR-013 Amendment 6](docs/adr/013-atmosphere-source-of-truth.md)).
- **Cloud shadows: one ladder case fails.** `layers-4-shadow` is held to a
  floor set before the shadow-range fix
  ([ADR-015](docs/adr/015-layers-4-shadow-temporal-shadow-resolve.md)), and its
  committed capture measures below it (SSIM 0.930 against 0.9715). It is
  committed as a fail, not waived. `shadow-sphere` and `shadow-cascades-2x512`,
  which failed in earlier captures, now pass.
- **Port-only defaults.** The shadow map updates every other frame, and light
  shafts are marched once per 2×2 quad. Setting `shadow.updateInterval = 1` or
  `lightShaftsHalfResolution = false` restores the original's behaviour
  ([WEBGPU.md](WEBGPU.md#performance)). Two experimental options also ship on:
  `cloudFrontRefinement` (cloud edges land on the real boundary) and
  `distantShapeDetailFade` (removes distant horizon speckle).
  `applyReferenceMode` turns all of these off at once.

The [render-graph decision](docs/adr/001-render-graph.md) explains the
composition; the linked decisions above record the limitations and evidence.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the development setup, the checks, the
comment rules and how to propose a change.

## License and credits

[MIT](LICENSE). Copyright (c) 2024 Shota Matsuda (the original work this is
ported from) and (c) 2026 John Fewell (this port).

This is a port of **[@takram/three-clouds](https://github.com/takram-design-engineering/three-geospatial)**
by Shota Matsuda. Other adapted code, with every licence named and every
required notice reproduced, is registered in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): cascaded shadow maps from
[three-csm](https://github.com/StrandedKitty/three-csm/) and three.js, Perlin
noise from GLM, tileable volume noise from
[TileableVolumeNoise](https://github.com/sebh/TileableVolumeNoise), structured
volume sampling from [volsample](https://github.com/huwb/volsample), temporal
antialiasing from [Playdead](https://github.com/playdeadgames/temporal), and
Catmull-Rom texture sampling from
[TheRealMJP's gist](https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1).

No NVIDIA data ships in this repository. The default jitter volume is this
repository's own void-and-cluster blue noise, generated from a seed
([ADR-009](docs/adr/009-stbn-jitter-volume.md)); a Storybook knob still fetches
NVIDIA's spatiotemporal blue-noise dataset at runtime, in your browser, exactly
as the WebGL reference does, and NVIDIA's licence does not permit redistributing
it.
