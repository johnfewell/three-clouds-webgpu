# Complete vanilla recipe

This folder is a standalone application, not a workspace package. Copy the
**whole folder** outside the repository or installed package before installing.
The executable sources are the recipe; the asset snippet below is checked
against its complete source file.

Guide links below are relative to the original package. After copying and
installing, find them under `node_modules/three-clouds-webgpu/`.

## Run from a tarball

Use Node 24 and pnpm 11.8.0. From your copied folder:

```sh
mkdir -p vendor
cp /absolute/path/to/three-clouds-webgpu-0.1.0-alpha.6.tgz vendor/three-clouds-webgpu.tgz
curl -fLo vendor/takram-three-geospatial-0.9.1+fork.7.tgz \
  https://github.com/johnfewell/three-geospatial/releases/download/fork-release-7/takram-three-geospatial-0.9.1%2Bfork.7.tgz
shasum -a 256 vendor/takram-three-geospatial-0.9.1+fork.7.tgz
corepack pnpm install
pnpm build
pnpm dev
```

Substitute the real input archive path, but keep the destination filename:
`package.json` deliberately uses `file:./vendor/three-clouds-webgpu.tgz`, never
`workspace:*` or an unpublished registry version. Preserve the generated
lockfile for subsequent `pnpm install --frozen-lockfile` runs. Serve over
localhost or HTTPS in a browser with native WebGPU; WebGL fallback is rejected.

The checksum must be
`319ea47db67a9372e6dce58317cc702b6fd105e051964ed4c8e474bf072d9e44`.
The npm builds of `@takram/three-atmosphere` and `@takram/three-geospatial`
fail to import on Three.js 0.185, so `pnpm-workspace.yaml` overrides both with
fork builds that carry the upstream fix: atmosphere from its release URL,
geospatial from the tarball above. A local tarball keeps pnpm's guard against
URL sub-dependencies on and puts its integrity hash in the lockfile. Override
both names, never one, so a single copy of each package resolves.

The exact baseline is stock Three.js 0.185.1, atmosphere 0.19.1+fork.7,
geospatial 0.9.1+fork.7, `@types/three` 0.185.0, TypeScript 5.9.2 and Vite 7.3.6.
There is no React or Fiber dependency. 
Both templates disable automatic peer installation and explicitly satisfy the
upstream `postprocessing` peer with 6.39.4. This avoids pulling an unrelated
React tree into vanilla. `skipLibCheck: true` accommodates upstream declaration
mismatches; the application source remains strict. Bundler resolution is the
supported complete-example boundary, not a claim that the full program passes
NodeNext. See the [consumer contract](../../docs/CONSUMER_CONTRACT.md).

## Assets: two executable choices

The default resolves all four files through the package's public asset exports.
Vite emits URLs, including the raw `.bin` volumes. No repository setup script,
CDN, source alias or asset copying is needed.

<!-- source: src/assets.ts -->
```ts
import type { BakedCloudTextureUrls } from 'three-clouds-webgpu'
import localWeather from 'three-clouds-webgpu/assets/local_weather.png?url'
import shapeDetail from 'three-clouds-webgpu/assets/shape_detail.bin?url'
import shape from 'three-clouds-webgpu/assets/shape.bin?url'
import turbulence from 'three-clouds-webgpu/assets/turbulence.png?url'

export function assetUrls(): BakedCloudTextureUrls {
  const base = new URLSearchParams(location.search).get('assets')
  if (base == null) return { localWeather, shape, shapeDetail, turbulence }
  const root = new URL(base.endsWith('/') ? base : `${base}/`, location.href)
  return {
    localWeather: new URL('local_weather.png', root).href,
    shape: new URL('shape.bin', root).href,
    shapeDetail: new URL('shape_detail.bin', root).href,
    turbulence: new URL('turbulence.png', root).href
  }
}
```

For an explicit serving route instead, copy the same files:

```sh
mkdir -p public/cloud-assets
for name in local_weather.png shape.bin shape_detail.bin turbulence.png; do
  cp "node_modules/three-clouds-webgpu/assets/$name" public/cloud-assets/
done
pnpm dev
```

Open `/?assets=/cloud-assets/` (or set `assets` to your own complete base URL).
The query switch is implemented in [src/assets.ts](src/assets.ts), not illustrative
pseudocode. Production uses the same route through Vite's public directory.
Cross-origin URLs need appropriate CORS headers. The library's `DEFAULT_*_URL`
constants are page-relative; they are not package URL resolvers.

## What runs

- [src/main.ts](src/main.ts) initializes and asserts WebGPU, loads assets with cancellation, configures the camera/MRT, creates the integration and renders its output through `RenderPipeline`.
- `/?manual=1` runs [src/manual.ts](src/manual.ts) with the **same** bootstrap, assets, animation, resize and teardown. It exposes scene-depth reconstruction, cloud-shadow sampling, provider registration, aerial lighting and composition without calling `createCloudsIntegration`. This is a single-owner, post-lit example, not a replacement for the helper's reusable ownership/validation policy.
- Startup failures are shown in the status panel and release already-created resources. Dispose, page exit and HMR abort pending loads, stop the loop and release the pipeline, integration, owned textures, scene pass, atmosphere, geometry/material and renderer.
- Clouds: on/off toggles `integration.context.enabled` and resets history without replacing the pass. The button label and `aria-pressed` reflect the selected state. Pause first to compare the cloud contribution at a fixed time; the atmosphere and ground keep rendering when clouds are off.


World positions are ECEF **metres**, with an identity world-to-ECEF transform.
The ground radius is 6,378,137 m and the camera starts 2,500 m above it, aimed
toward the horizon. The explicit normalized sun is shared by the cloud and
atmosphere consumers through the integration. The scene writes color plus
`normalView` MRT; its depth texture is the actual cloud occlusion input.

Lighting is deliberately `post`: unlit ground albedo is lit by aerial perspective,
then clouds composite over it and the pipeline applies tone mapping. Do not add
`AtmosphereLight` to this path. The helper's `lights` mode does not install lights;
advanced light receivers also need explicit shadow preparation.

This is a daytime recipe: stars and moon are disabled before graph compilation,
and atmosphere scattering uses the LUT path. Cloud jitter is generated locally
with `createJitterTexture()` and owned by the application.
No NVIDIA noise download, remote stars catalogue, or global URL modifier is used.

`ANIMATION_SPEED = 1` means one cloud-time second per real second, not 1/60.
Change it only as an explicit artistic speed choice. Pause freezes time while
sample indices continue, allowing temporal accumulation to converge. Seek resets
time, frame and history; resize updates camera/renderer size and resets history.
A camera jump also requires a reset. Replacing the camera or scene-depth node
requires disposing/recreating the integration, not mutating its fixed identities.
If you keep an existing `RenderPipeline`, assign the replacement output and set
`pipeline.needsUpdate = true`; see the
[replacement sequence](../../INTEGRATION.md#replacing-an-integration).

The diagnostic table reports CPU setup/asset observations only. Neither a
successful build nor `ready` proves a completed, correct GPU frame. Native
rendering and lifecycle are separate qualification steps.

See the [integration guide](../../INTEGRATION.md) for contracts and the
[ownership reference](../../docs/CONSUMER_CONTRACT.md) before sharing textures
or placing the recipe inside an existing renderer.
