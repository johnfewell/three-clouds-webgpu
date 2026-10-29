# r3f example

A React Three Fiber consumer of `three-clouds-webgpu`.

## Status: verified on WebGPU

This example is verified by the phase-4 e2e smoke test (`examples/parity/e2e/p4.spec.ts`).
The test waits for completed pipeline frames, checks nonblank sky pixels, and
compares clouds on/off against temporal drift. It renders three authored cloud
layers over the WGS84 globe using React Three Fiber,
mirroring [`examples/basic`](../basic/src/main.ts).

Unit coverage in `src/r3f/Clouds.dom.test.tsx` (26 tests) pins what `<Clouds>` writes
to `CloudsContext` — prop forwarding, the `time`/`frame` contract, ref forwarding,
and `<CloudLayer>` slot editing.

```bash
pnpm --filter r3f dev   # http://localhost:5200
```

The default scene needs no provider credentials. The optional `?tiles=1` view
uses the existing `VITE_ION_TOKEN` configuration in a gitignored `.env.local`.
Tile geometry/loading is not qualified by the credential-free smoke test. `predev`/`prebuild` provision local assets, including upstream
stars from the installed atmosphere package and the port's MIT blue-noise
volume for atmosphere jitter. The atmosphere's internal NVIDIA STBN URL is
redirected to that local volume; no NVIDIA data is downloaded or bundled. The smoke
rejects external requests. This is a rendering smoke test, not an STBN parity
comparison.

## What it demonstrates

`<Clouds>` owns **state and lifecycle only** — the app composes. There is no r3f
context for a WebGPU/TSL post chain, so the canonical ADR-001 graph is built in
`App.tsx` exactly as `examples/basic` builds it:

```
sky background → MRT scene pass → clouds march → aerial perspective (post-lit)
  → composite → tonemap
```

What the bindings add over doing all of it by hand is the declarative surface a
React app wants to own: `<CloudLayer>` editing a slot, props forwarding to the
context, and `useClouds()` handing the pass to whatever composes it.

## Two deliberate choices

**`time` and `frame` are driven by the app, not by `<Clouds>`.** The component
takes no clock (ADR-003): any `(time, frame)` pair must reproduce the same
pixels, and a `useFrame` accumulator reintroduces the order-dependence that ADR
removes. This example advances them in its own `useFrame` and passes them down —
which is exactly what a consumer is expected to do.

**No `@vitejs/plugin-react`.** It is not installed, and adding a dependency
means a `pnpm install` every agent in the shared checkout has to absorb. Vite's
own esbuild transforms JSX with the automatic runtime; the plugin would only add
Fast Refresh, which a demo does not need.

## Known type errors

Both examples are included in `pnpm typecheck:examples` (also part of
`pnpm check`). The gate rejects broken imports and new diagnostics while
allowing explicitly recorded upstream Three.js declaration-skew sites.
`pnpm exec tsc --noEmit -p examples/r3f/tsconfig.json` also reports those known
skew diagnostics directly, without the gate's classification.
