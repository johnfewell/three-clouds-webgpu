# Experimental GPU Fixtures

## `stbn.bin` — generated, not committed

The peer `@takram/three-geospatial` package defaults its jitter texture to a
runtime fetch of NVIDIA's spatiotemporal blue-noise volume, so a Playwright or
benchmark run would reach the network for it. Seven harnesses intercept the
`**/stbn.bin` route and answer from a local file instead.

That local file used to be NVIDIA's data, committed here. It is not any more.
NVIDIA publishes the volume under its own
[Non-Commercial Use License](https://github.com/NVIDIA-RTX/STBN/blob/main/License.txt),
which restricts use to research or evaluation, so it cannot be redistributed
under this repository's MIT licence — and the fixture used to sit next to a
`LICENSE` file claiming MIT over it. ADR-009 Amendment 3 records the removal.

What the routes need is a 128×128×64 single-channel volume, and this
repository generates one from its own void-and-cluster code:
`goldenVolume(generateRankMap())`, the same construction
`createJitterTexture()` builds at runtime from
`src/textures/blueNoiseRankMap.ts`. The peer `STBNLoader` reads the bytes as
`WIDTH × HEIGHT × DEPTH` and nothing else, so the shape is all that mattered.

Generate it with:

```sh
node scripts/setup-assets.mjs --example examples/parity --from @takram/three-clouds
```

or `node -e "import('./scripts/jitterFixture.mjs').then(m => console.log(m.ensureJitterFixture()))"`.
`scripts/isolate.sh` asserts it is present in a worktree. The path and the
byte shape are unchanged from the committed original, so the call sites that
build this path need no edit.

Star data is served from the installed atmosphere package's local assets.
