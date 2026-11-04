# WebGL fallback recipe

This folder is a standalone application, not a workspace package. Copy the
**whole folder** outside the repository or installed package before installing.

It renders clouds on whichever of two libraries the browser can run, decided
once before any renderer exists:

- **WebGPU present** (`navigator.gpu` and an adapter granted): this package,
  `three-clouds-webgpu`, on `WebGPURenderer`, wired as the vanilla recipe wires
  it.
- **No WebGPU**: the original `@takram/three-clouds` 0.7.6 `CloudsEffect` and
  `AerialPerspectiveEffect` on `WebGLRenderer` with `postprocessing`, wired the
  way this repository's parity harness drives the original.

Both branches read one settings object (`src/settings.ts`), whose 66 keys are
the WebGL `CloudsEffect` property names the WebGPU `CloudsContext` kept
verbatim, the rows the migration table marks ported. Keys the WebGPU port
added and the original lacks (`PORT_ONLY_KEYS`) are ignored by the WebGL
branch with one warning each. `?backend=webgl` and `?backend=webgpu` force a
branch for testing; forcing WebGPU where there is none fails in that branch.

## What the fallback is not

The original is a different renderer with a different look, within the
parity ladder's thresholds, and without the port's opt-in features: cloud
types, time of day, moonlight, rain shafts, the cirrus deck, lightning,
evolving weather, the quality governor and the `lowEnd` preset. A fallback
frame is a feature-reduced sky. Decide whether that is acceptable for your
product before shipping it; this recipe makes the branch possible, not the
call.

The WebGL2 backend of `WebGPURenderer` (`forceWebGL: true`) is **not** the
fallback: this package refuses it (`assertWebGPUSupported`), because it lacks
3D float texture filtering and storage textures.

## Run from a tarball

Use Node 24 and pnpm 11.8.0. From your copied folder:

```sh
mkdir -p vendor
cp /absolute/path/to/three-clouds-webgpu-0.1.0-alpha.8.tgz vendor/three-clouds-webgpu.tgz
cp /absolute/path/to/checkout/vendor/takram-three-atmosphere-0.19.1+fork.8.tgz vendor/
cp /absolute/path/to/checkout/vendor/takram-three-geospatial-0.9.1+fork.8.tgz vendor/
shasum -a 256 vendor/takram-*.tgz
corepack pnpm install
pnpm build
pnpm dev
```

Substitute the real input archive path, but keep the destination filename:
`package.json` deliberately uses `file:./vendor/three-clouds-webgpu.tgz`, never
`workspace:*` or an unpublished registry version. Preserve the generated
lockfile for subsequent `pnpm install --frozen-lockfile` runs.

Copy both fork archives from the same r187 checkout. Their SHA-256 values are:

- `takram-three-atmosphere-0.19.1+fork.8.tgz`: `829ec23b8754700f93e9764b8473924ac4995c634dccd6e96401f5b944eb34e1`
- `takram-three-geospatial-0.9.1+fork.8.tgz`: `10127715aeb9ac35e7d7e8bf443817d08e9bae845851810d5471628c3b91be25`

The npm takram builds use the removed struct-layout API. These vendored forks
carry the runtime fixes and explicit uniform types required by r187. Override
both names so one copy of each package resolves; pnpm records their integrity
hashes in the generated lockfile.

The exact baseline is stock Three.js 0.187.0, `@takram/three-clouds` 0.7.6,
atmosphere 0.19.1+fork.8, geospatial 0.9.1+fork.8, `postprocessing` 6.39.4,
`@types/three` 0.187.0, TypeScript 5.9.2 and Vite 7.3.6. There is no React or
Fiber dependency. See the [consumer contract](../../docs/CONSUMER_CONTRACT.md)
and the [integration guide](../../INTEGRATION.md#webgl-fallback).

## Files

- `src/detect.ts`: the one decision, with the `?backend=` override.
- `src/settings.ts`: the shared settings object, its key list, and
  `applySettings` for either library.
- `src/webgpu.ts` and `src/webgl.ts`: the two branches behind one handle
  (`src/handle.ts`): update, enable, seek, pause, resize, dispose.
- `src/main.ts`: the page, which reports the chosen backend in the `#backend`
  badge and the render state in `#status`.
- `src/assets.ts`: the four baked textures, resolved through the package's
  asset exports for both branches (they are plain three textures).
