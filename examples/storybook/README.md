# clouds storybook

The upstream three-geospatial clouds stories, recreated on `three-clouds-webgpu`
in the shape of upstream's **own** WebGPU storybook, so the port's clouds can be
compared with the WebGL reference story for story with identical parameters.

```bash
pnpm --filter clouds-storybook storybook   # http://localhost:6006
```

## Why this shape

Upstream has two storybooks. `storybook/` is the WebGL one (r3f +
`postprocessing`; its clouds stories are Clouds/{Basic, CustomLayers,
WorldOriginRebasing, Vanilla}, 3D Tiles/{Tokyo, Fuji, London}, Building Blocks,
Minimal Setup). `storybook-webgpu/` is the WebGPU one — atmosphere and core
stories with every bell and whistle (3D tiles, aerial perspective, lens flare,
TAA, dithering, AgX) — and **no clouds section**. That gap is what this package
fills, in that storybook's conventions, so the stories can be dropped into
`storybook-webgpu/src/clouds/` for the upstream PR.

- `typings/` — upstream's `3d-tiles-renderer` type shims (trimmed) and a
  `NodeLibrary.addToneMapping` augmentation. (Named `typings/` because the root
  `.gitignore` ignores every `types/` directory — the library's generated one.)
- `src/clouds-webgl/` — the WebGL reference stories; `src/clouds-webgl/vendor/`
  is upstream `storybook/src/helpers` + the clouds leva panel, verbatim with
  documented edits (no date-fns, no Hald LUT, 0.4.28 TilesPlugin args).
- `src/vendor/` — upstream `storybook-webgpu/src/{components,controls,hooks,
  helpers,plugins,worker}` copied at `b012ad06` with the upstream MIT header.
  Every file states whether it is verbatim or what was edited (antd's Progress
  → CSS, no nx tsconfig-paths plugin, no emotion `css` prop). They run on the
  **published** `@takram/three-atmosphere` 0.19.1 / `@takram/three-geospatial`
  0.9.1 this port peers on.
- `src/clouds/` — the stories, parameters copied verbatim from the WebGL story
  files. The controls panel (`controls/`) is the WebGL panel's leva folders as
  Storybook args; every knob name is the `CloudsContext` key it writes.
  The port-only sections (Experiments, Cloud Types, Convection, Evolving
  Weather, Night, Cloud Environment, Custom Material Shadow, Lightning, Rain
  Shafts, Scene Presets, Static Mode) have no WebGL story to copy and are
  authored here.
- `src/clouds/helpers/CloudsPostProcessing.tsx` — the ADR-001 graph every story
  on the port composes: sky background → MRT scene pass → clouds march → aerial
  perspective (post-lit, cloud shadow + shadow length) → lens flare → tone
  mapping → TAA → dithering. Wired as `examples/basic` and the parity harness's
  side B wire it.

## A/B: the WebGL reference in the same storybook

`clouds-webgl/` carries the upstream WebGL stories on `@takram/three-clouds`
0.7.6 (the parity ladder's side A) with the same titles, parameters and camera
poses as the port's `clouds-webgpu/` section, so every story has its reference
one sidebar click away.
Their controls are the upstream leva panel (`h` hides it; `?hidePanel=1` on the
iframe URL hides it for scripted captures). The reference stories read the
precomputed atmosphere LUTs from the installed package (`/atmosphere`, a
`staticDirs` entry) and the cloud textures from `public/assets`, like the port.

The first pair rendered (Basic) found that the port's aerial node returns the
scene background's sky on far-plane pixels, so light shafts never reach the
sky/ground rays on the port side, visible in every pair as the volumetric
shadow wedge the reference draws on the ground rays and the port does not.

## Where it is not 1:1 with the WebGL storybook

- Stories build the node graph imperatively inside a component; there is no r3f
  context for a WebGPU/TSL post chain (upstream has none either).
- SMAA → nothing by default, but the arg now exists. Upstream's WebGPU stories
  end in TAA, the WebGL clouds stories in SMAA, and the port stories default
  both off: the clouds resolve is itself temporal (ADR-008) and a second
  temporal filter over the composite visibly softens the distant decks (Basic,
  cloud-edge-scale energy near the horizon 0.85–0.9× the reference with TAA on,
  1.0× with it off). `SMAA (story)` turns SMAA on, `temporal antialias (story)`
  turns TAA on, both off by default.
- SMAA is **not** disqualified by that softening, because it is spatial rather
  than temporal. Measured on the Basic pair at four horizon poses, in motion,
  over the WebGL story: the port as shipped carries 15–31% more per-frame
  high-frequency noise in the horizon band than the WebGL story, SMAA cuts that
  excess to 4–15% (41–78% of it removed) for 2% of far-deck edge energy, while
  TAA removes the excess entirely for 9–25% of that energy. SMAA is wired where
  the WebGL chain has it: after tone mapping, before `renderOutput`'s output
  transform.
- Dithering is in **both** chains, so the two are not differing there.
  `dithering (story)` takes it out of an A/B. Measured, it contributes nothing
  to the motion figure (within 1% either way), which is expected: the port's
  dither is a ±0.5/255 screen-space pattern, not a temporal filter.
- Hald LUT colour grading lived in the WebGL-only effects package. The WebGPU
  equivalent (three's `lut3D` over a `Data3DTexture` unpacked from a Hald PNG)
  is not implemented here.
- `lightingMask` has no WebGPU equivalent by design (ADR-001: post-lit or
  light-lit per frame, never both).
- Not pixel-identical by construction: the parity ladder's bar is SSIM ≥ 0.95
  per case. The port stories sample NVIDIA's STBN from the upstream URL, as the
  WebGL stories do (ADR-009 Amendment 1), so the A/B compares renderers, not
  noise sources; the `jitter volume` control switches a story to the library's
  hash-volume default to see what that default costs.

## Credentials

The 3D Tiles stories need a Google Maps Platform key (the `googleMapsApiKey`
story arg, or `STORYBOOK_GOOGLE_MAP_API_KEY` in `.env.local`) or a Cesium Ion
token (`STORYBOOK_ION_API_TOKEN`) for the Photorealistic Tiles asset. `.env*`
is gitignored; never commit keys.

## Verification

Every story is called done only with a hardware render behind it (headed
Chrome, `--enable-unsafe-webgpu`, the parity harness's recipe).
`test-results/storybook-evidence/` holds the latest local screenshot copies
(gitignored).

## Known type errors

`pnpm --filter clouds-storybook typecheck` reports 16 errors, all in
`src/vendor/` (AgxToneMapping, GlobeControls, wrapFadeNodeMaterial,
outputPassControls). They are one seam: the `@takram/*` type surfaces are built
against `@types/three` 0.182 and this repository types against 0.185, whose
`Node` is generic — geospatial's `Node<T>` alias then carries no TSL operators.
The stories and helpers under `src/clouds/` type-check clean by crossing that
seam with the same casts the parity harness uses. The vendored files are kept
verbatim rather than cast-patched; `eslint` ignores `src/vendor/**` like
`reference/**`. This package is not in the root `pnpm typecheck` gate for that
reason (neither are `examples/basic` and `examples/r3f`, which carry the same
error class).
