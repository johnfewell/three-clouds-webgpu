# ADR-012 — Package identity and the dogfooding rule

## Context

The scaffold names the package `three-clouds-webgpu` with `./webgpu` and `.` exports pointing at `build/` + `types/` outputs. The library must be consumable as a regular npm package during development: the parity example imports it by package name, never by relative path into `src/`. This ensures the example exercises the published shape and catches export/build problems before release.

The port's nodes resolve the atmosphere through `getAtmosphereContext`, which checks `instanceof AtmosphereContext`. A second copy of `@takram/three-atmosphere` in a consumer's tree breaks that check, so the atmosphere and geospatial packages must be peer dependencies with caret ranges.

## Decision

- **Package name**: `three-clouds-webgpu`.
- **Dependency policy**: `three`, `@takram/three-atmosphere`, and `@takram/three-geospatial` are **peer dependencies** (`three@>=0.184.0 <0.187.0`, `@takram/three-atmosphere@^0.19.1`, `@takram/three-geospatial@^0.9.1`) with exact devDependencies (`0.185.1`, `0.19.1`, `0.9.1`). Inside the takram monorepo they become regular dependencies. The library never depends on `postprocessing` or `@takram/three-clouds`. three 0.186 is in range on fork release 7 only, whose scattering-LUT kernel builds correctly on r186 and whose atmosphere build carries its own `forkBuild` marker. The development tree stays on 0.185.1.
- **Fork-build pin**: the npm builds of `@takram/three-atmosphere` 0.19.1 and `@takram/three-geospatial` 0.9.1 read `struct().layout`, which three 0.185 removed, so they fail at import there. The workspace and both recipes pin the fork builds `0.19.1+fork.7` and `0.9.1+fork.7` (the 0.19.1 / 0.9.1 release commit plus the upstream struct fix, the `AerialPerspectiveNode` `shadowNode` / `lightingMaskNode` inputs of ADR-007, a `raySpheresIntersections` mask with one lane per radius, `AtmosphereContext.lookupGroundLift`, a scattering-LUT kernel that builds correctly on three r186 and a `forkBuild` marker in each package, published as [fork release 7](https://github.com/johnfewell/three-geospatial/releases/tag/fork-release-7)) with pnpm `overrides` in `pnpm-workspace.yaml`: atmosphere by its release URL, geospatial from a vendored tarball in `vendor/`. The overrides cover every importer, so a single copy of each package resolves and `instanceof AtmosphereContext` holds. The devDependencies and peer ranges keep naming the npm release the fork builds are cut from. No three patch is applied anywhere. `src/march/intersections.ts` refuses to load on a geospatial build whose `forkBuild` marker does not report four masked lanes, because the march reads lanes `.z` and `.w` of `raySpheresIntersections`, and on three r186 it also refuses to load unless the atmosphere and geospatial markers both report `r186Kernels` and the same release.
- **`sideEffects: false`**; the build must not bundle `three`/`@takram` code.
- **Exports**: `.` and `./webgpu` (both point at the same entry so the upstream `packages/clouds/src/webgpu` shape maps 1:1), plus `./package.json`.
- **pnpm workspace**: root = library; `examples/parity/` = a Vite app depending on the library as `workspace:*`, plus `@takram/three-clouds@0.7.6` and `postprocessing@6.39.4` for side A.
- **Dogfooding rule**: the workspace link resolves to the built output (`build/` + `types/`), not to `src/`. A relative import from `examples/parity/` into `../../src/` fails CI.

Layout:

```text
<repo>/package.json                 # library
<repo>/src/                         # lands upstream as packages/clouds/src/webgpu
<repo>/examples/parity/             # the showcase; imports library by package name
<repo>/scripts/port-gates/          # gate tooling
<repo>/parity/results/<phase>/      # committed stills + metrics
<repo>/docs/adr/                    # these ADRs
<repo>/reference/                   # vendored upstream sources, read-only
```

## Consequences

- The scaffold was reconciled to match: `playground/` became `examples/parity/`, the pins were bumped, and the workspace config added.
- Every import in the example uses the package name; CI enforces this with `grep -rnE "\.\./\.\./src" examples/parity/src`.
- A test asserts `(await import('<lib>')).CloudsContext === (await import('<lib>/webgpu')).CloudsContext`.
- A test greps `build/*.js` for `class WebGPURenderer` / `class AtmosphereContext` and expects none (no bundled peer code).
- When landed upstream in the takram monorepo, peer dependencies become regular dependencies; `WEBGPU.md` documents this.
- `test/pins.test.ts` pins the installed fork builds: the atmosphere override URL, version and the SHA-256 of its `build/webgpu.js`, and the vendored geospatial tarball's SHA-256. `test/threePeerRange.test.ts` pins the peer range. The workspace sets `blockExoticSubdeps: false`, because the parity reference's `@takram/three-clouds` makes the atmosphere URL a sub-dependency; the recipes keep the guard on.
- The fork pin ends when upstream publishes builds that import on three 0.185.

## References

- ADR-013 (atmosphere source of truth — why `instanceof` demands peers)
- Scaffold `package.json` (current state)
