# ADR-009 — STBN replacement: deterministic hash jitter volume, scaled UV sampling

## Context

The original's default STBN URL packages NVIDIA's separately licensed spatiotemporal blue-noise dataset. Neither the library nor the parity example should depend on it. Additionally, three's built-in `STBNTextureNode`/`stbn` uses that same NVIDIA URL by default and indexes the renderer's `frameId`, not the library's `frame` — making it unsuitable for deterministic, seek-safe rendering.

The jitter UV must be scaled by the texture size; integer texel coordinates fed to a normalized sampler wrap onto one texel and kill all spatial and temporal variation.

## Decision

- The library ships `createJitterTexture()` — a deterministic hash volume 128×128×64, `RedFormat`, `UnsignedByteType`, `NearestFilter`, `RepeatWrapping` on S/T/R, `NoColorSpace`.
- `stbnTexture` remains a public property so a consumer with a license can substitute the real NVIDIA dataset.
- The parity harness hands the same generated volume to both side A (`CloudsEffect.stbnTexture`, `AerialPerspectiveEffect.stbnTexture`) and side B, making A/B comparisons meaningful.
- Sampling (matching core's `STBNTextureNode` pattern, `reference/core-webgpu/STBNTextureNode.ts:66–70`):

```ts
stbn.sample(vec3(screenCoordinate.xy, frame.mod(DEPTH)).div(vec3(SIZE, SIZE, DEPTH))).r
```

- Do NOT use core's `STBNTextureNode`/`stbn` in the library or the example.
- Do NOT use `DEFAULT_STBN_URL` anywhere.

## Consequences

- No NVIDIA license dependency; the library is MIT-clean.
- The hash volume is not blue noise — known accepted non-parity (listed in `thresholds.json` per ADR-011).
- `stbnTexture` on `CloudsContext` is the injection point; both the library default and consumer overrides go through it.
- `grep -r STBNTextureNode src examples` and `grep -r DEFAULT_STBN_URL src examples` must return nothing.

## References

- `clouds.glsl:1–5` (original sampling)
- `reference/core-webgpu/STBNTextureNode.ts:66–70`
- ADR-011 (accepted non-parity register)

## Amendment 1 (2026-09-03) — the storybook samples NVIDIA's STBN, like the reference it is compared against

**Context.** The WebGL reference stories (`examples/storybook/src/clouds-webgl`) sample NVIDIA's STBN through `@takram/three-clouds`'s default `DEFAULT_STBN_URL` — fetched at runtime from takram's repository, nothing bundled. The port's stories sampled the hash volume. Every A/B pair judged before this amendment therefore compared two noise sources as well as two renderers: the hash volume is white noise, STBN is blue, and the difference reads as grain on the port's side regardless of the march.

**Decision.**
- The storybook (`examples/storybook`) may fetch NVIDIA's STBN at runtime from the upstream URL, exactly as the reference does — the file is not redistributed and the license posture is upstream's. A `jitter` arg (`stbn` | `hash`, default `stbn`) switches per story so the two can be seen side by side; the Vanilla story samples STBN like its WebGL counterpart.
- The library default is unchanged: `CloudsContext.stbnTexture` lazily creates the hash volume; the vanilla API fetches nothing. The r3f `<Clouds>` keeps its upstream-shaped default (`stbnTexture = DEFAULT_STBN_URL`), which is where the "Do NOT use `DEFAULT_STBN_URL` anywhere" rule was already not followed; that default is documented rather than removed.
- The parity harness stays on its shared generated volume (both sides); nothing in `examples/parity` changes.
- The pass samples the jitter volume through its parameter-uniform `TextureNode`, re-synced from `CloudsContext.stbnTexture` every frame (`getSTBN` accepts a `TextureNode`). Before this, a texture assigned after the first build — the r3f prop, the knob — was never sampled; the shader kept the texture captured at build. Pinned by `CloudsPassNode.test.ts` ("a jitter volume swapped after the build is what the shadow program binds"), red-proved against the build-time capture.

**Consequence for the invariants above.** `grep -r DEFAULT_STBN_URL src examples` is no longer expected to return nothing: `src/r3f/Clouds.tsx` (the documented default) and `examples/storybook` (this amendment) may reference it. `STBNTextureNode`/`stbn` from core remain unused. `examples/parity` still must not reference either.

## Amendment 2 (2026-09-30) — the library default is blue noise

**Context.** The hash volume is white noise: its 8×8 box-blur variance per slice is about 10× NVIDIA's, and the variance of each pixel's mean over the 64 slices is about 50× NVIDIA's. Under TRAA that is visible grain. An upstream user reported replacing `stbn.bin` with a seeded void-and-cluster rank map (Ulichney 1993) whose slice k is `(map + k·φ) mod 1`, with numbers close to NVIDIA's. The constraint is unchanged: MIT-clean, no NVIDIA data, and a synchronous `createJitterTexture()` with no fetch.

**Alternatives.** Every candidate is 128×128×64 R8, generated offline from seed `0x5eed2026` by `scripts/generate-blue-noise.mjs`. The two statistics are the ones in that script's `jitterStatistics`.

| volume | 8×8 blur variance per slice (min–max) | variance of per-pixel mean | cost to ship |
|---|---|---|---|
| hash (`lowbias32`, white noise, the previous default) | 1.12e-3 – 1.46e-3 | 1.29e-3 | computed, 0 bytes |
| NVIDIA `stbn.bin` (measured only, and since removed: Amendment 3) | 1.50e-4 – 1.65e-4 | 2.52e-5 | not redistributable |
| (a) 2D void-and-cluster, σ 1.5, + k·φ per slice | 1.04e-4 – 2.11e-4 | 5.94e-5 | 16 KB rank map, slices built at creation |
| (b) 3D void-and-cluster, separate kernel σ 1.9 / 1.9 (Wolfe et al. 2022), slices equalized | 1.29e-4 – 1.44e-4 | 1.52e-5 | 1 MB volume (17 s to generate) |
| (c) FAST-style in-slice swaps (Donnelly et al. 2024), Gaussian σ 1 + exponential α 0.1 | 8.86e-5 – 1.03e-4 | 5.85e-7 | 1 MB volume (40 s to generate) |

- (b) and (c) are our own implementations of the published methods, and both beat NVIDIA on both statistics. They are kept out of the default only because each needs a 1 MB volume shipped with the library (generating one at runtime takes too long).
- (c): EA's `fastnoise` generator is BSD-3-Clause, but it is a Windows/DX12 binary, so the candidate is a reimplementation of the method, not EA's tool or data.

**Decision.**
- `createJitterTexture()` returns (a). The 128×128 rank map is embedded as 16 KB (`src/textures/blueNoiseRankMap.ts`), and the 64 slices are built synchronously at creation. `scripts/generateBlueNoise.test.ts` regenerates the map and byte-compares it.
- The hash stays available as `createHashJitterTexture()`. The parity harness uses it on both sides, so the ladder's bytes do not move (sha256 `0f9c8372…` before and after) and no case is re-captured. The hash's accepted non-parity entry under Consequences still applies to the ladder.
- The r3f `<Clouds>` default moves off `DEFAULT_STBN_URL` to `createJitterTexture()`, so no component default fetches NVIDIA's dataset any more.
- The Storybook `jitter` default moves from `stbn` to the new volume (`blue`; the options are `blue` | `stbn` | `hash`). **This reverses Amendment 1's default:** a noise-matched A/B against the WebGL stories now needs `jitter: stbn`, which still fetches NVIDIA's file at runtime exactly as Amendment 1 allowed. The Vanilla story still samples STBN like its WebGL counterpart.

**Why (a).** Rendered on a Mac mini on 2026-09-30, 2874×1794 at DPR 2, with each volume injected through the same `STBNLoader` path. The decisive measure is the low-frequency error: the per-frame deviation from the 32-frame mean, Gaussian low-passed at σ 4 px, std over cloud pixels. Its controls order correctly (blocky > hash > NVIDIA > all-zero). On the line from NVIDIA (0 %) to hash (100 %):

| volume | Vanilla (most sensitive, repeats ±0.002) | horizon | Basic (story TAA, low power) |
|---|---|---|---|
| (a) | −14 % | +6 % | +16 % (within spread) |
| (b) | −6 % | +61 % | +24 % |
| (c) | +37 % | +23 % | +139 % |

- (a) is indistinguishable from NVIDIA at every pose, in two separate sessions. It is also the only candidate that meets the synchronous, 16 KB constraint.
- (b) is borderline on the horizon pose.
- (c) is measurably grainier than NVIDIA on Vanilla, despite the best offline statistics. The two statistics favour a volume tuned for a σ 1 Gaussian and an exponential history, but they do not predict what the pass shows, so the render measure outranks them.
- At display level, no volume (hash included) differs by more than one 8-bit level once the temporal resolve has converged. The difference is low-frequency grain, visible in motion and before convergence.

## Amendment 3 (2026-10-02) — NVIDIA's volume leaves the repository

**Context.** Amendment 1 allowed the Storybook to *fetch* NVIDIA's volume at
runtime and said the file was "not redistributed and the license posture is
upstream's". That held for the library and the Storybook. It did not hold for
the test tree: `test/fixtures/experimental/stbn.bin` carried an unmodified copy
of the volume (sha256 `51f52f21…852`, 1,048,576 bytes) so seven Playwright and benchmark harnesses
could answer the peer package's `**/stbn.bin` route without a network fetch. Beside
it sat `test/fixtures/experimental/LICENSE`, a verbatim MIT block reading
"Copyright (c) 2024 Shota Matsuda".

Two things were wrong with that. The table above claimed the volume was "measured
only, never committed"; it had been committed since 2026-09-04. And the licence
was not MIT and never claimed to describe the data's origin: NVIDIA publishes the
volume under its own
[Non-Commercial Use License](https://github.com/NVIDIA-RTX/STBN/blob/main/License.txt)
(NVIDIA Source Code License for Spatiotemporal Blue Noise Texture Generation),
whose §3.3 restricts use to research or evaluation and whose §3.1 requires
redistribution under that licence with a complete copy of it. An MIT notice over
non-commercial-only data is a licence claim that is simply untrue, and this
repository is about to be published under MIT.

**Decision.**
- `test/fixtures/experimental/stbn.bin` is untracked and generated, from this
  repository's own code: `goldenVolume(generateRankMap())`, which is the same
  construction `createJitterTexture()` builds at runtime from
  `src/textures/blueNoiseRankMap.ts`. `scripts/jitterFixture.mjs` writes it;
  `scripts/setup-assets.mjs` provisions it on every dev, build and CI run, and
  `scripts/isolate.sh` asserts it in a worktree.
- The path and the byte shape are unchanged, so the seven call sites that build
  the path need no edit. `STBNLoader` reads the file as a
  `WIDTH * HEIGHT * DEPTH` `Uint8Array` and nothing else, so the substitution is
  transparent to the harnesses.
- The false `LICENSE` beside the fixture is deleted. Nothing in the tree now
  asserts MIT over NVIDIA's data.
- Amendment 1's runtime fetch is unchanged and remains permitted: `jitter:
  'stbn'` still fetches the upstream URL in the Storybook exactly as the WebGL
  reference does. Fetching a file at runtime is the consumer's licensing
  decision, made in the consumer's browser; redistributing it in the repository
  is ours.

**Consequences.**
- `THIRD_PARTY_NOTICES.md` records NVIDIA's volume as *referenced, never
  redistributed*, with the licence named and the URL.
- Benchmark suite hashes change: `examples/parity/scripts/benchmarks/run.mjs`
  folded the fixture's bytes into `benchmarkSuiteHash`, so the `perf/` receipts
  predate this substitution and must be re-run before they are quoted as current.
  Parity `metrics.json` results are unaffected; nothing under `parity/results/`
  reads this file.
- `test/jitterFixture.test.ts` fails if NVIDIA's volume reappears in the index or
  on disk, and if the generated one is truncated or non-deterministic.

**References**
- `https://github.com/NVIDIA-RTX/STBN/blob/main/License.txt` (the licence text)
- `test/fixtures/experimental/README.md` (how the fixture is provisioned)
- `THIRD_PARTY_NOTICES.md`
