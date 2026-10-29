# ADR-007 — Two shadow consumers: aerial direct×shadow (unlit) and light-node subclass (lit)

## Context

Cloud shadows must reach two kinds of geometry: unlit/post-lit surfaces (e.g. photogrammetry tiles using `MeshBasicMaterial`) whose sun/sky illuminance comes from `AerialPerspectiveNode` when `lighting === true`, and lit node materials whose direct light comes from `AtmosphereLightNode`. Consumer 3.2b alone leaves unlit geometry unshadowed. The WebGPU `AerialPerspectiveNode` has no lighting mask (WebGL had `lightingMask`/`LightingMaskPass`), so a frame is either post-lit or light-node-lit, never both.

## Decision

Both consumers are required:

| ID | Geometry | Hook |
|---|---|---|
| 3.2a | Unlit / post-lit (`lighting === true`) | `AerialPerspectiveNode` gains an optional `shadowNode: Node<'float'>` (transmittance 0–1). Multiplies ONLY the `direct` solar term: `illuminance = direct × shadow + indirect`. Producer: `exp(−od)` via the ground sampler (ADR-006, no tail). |
| 3.2b | Lit node materials (`lighting === false`) | Subclass of `AtmosphereLightNode`, attenuates direct term by `exp(−od)`. Registered with `renderer.library.addLight(CloudShadowedAtmosphereLightNode, AtmosphereLight)`. |

3.2a interface shape: the aerial node's `illuminance` Fn (inside `setup()`, `AerialPerspectiveNode.ts:~195–230`) has `add(direct, indirect)` at `:216–218`. The interim `CloudShadowedAerialPerspectiveNode` copies `setup()` from the pinned 0.19.1 source (~150 lines, file header says so) and changes that one line to `add(direct.mul(shadowNode ?? 1), indirect)`. A WGSL snapshot test proves the copy has not drifted: the subclass with `shadowNode = float(1)` compiles normalised-identical to the upstream node.

Lighting modes: 3.2a on the parity scene's default `'post'` mode (cases 34/36); 3.2b on its `'lights'` mode (case 35). The two paths never share a frame.

## Consequences

- The library ships an adapter file with the subclass; upstreaming the `shadowNode` input on `AerialPerspectiveNode` is preferred long-term.
- `WEBGPU.md` documents the missing `lightingMask` and the two lighting modes.
- Parity cases 34–36 prove both consumers on pixels.
- The WGSL snapshot test on the interim subclass catches upstream drift at `pnpm test` time.

## Amendment 1 (2026-10-25): the hook is the fork node's inputs

The 3.2a hook now lives on `AerialPerspectiveNode` itself. It was introduced in the fork build `@takram/three-atmosphere` 0.19.1+fork.3 ([fork-release-3](https://github.com/johnfewell/three-geospatial/releases/tag/fork-release-3)), and later fork releases keep it. The release currently pinned is the one ADR-012 names. The contract is two optional inputs, both null by default:

- `shadowNode: Node<'float'> | null`: `illuminance = direct × shadow + indirect`, the 3.2a row above. Moonlight is not shadowed.
- `lightingMaskNode: Node<'float'> | null`: when `lighting` is true, `mix(color × transmittance, postLit, clamp(mask, 0, 1))` before inscattering is added. With `lighting` false the mask is skipped, since self-lit and post-lit are then the same value. Read the mask at an explicit LOD, because the node evaluates it in its surface branch.

With both null, the node emits the same WGSL as npm 0.19.1, byte for byte (evidence in the fork-release-3 release notes). `aerialPerspectiveWithCloudShadow` and the integration helper set the inputs on the plain node, and `CloudShadowedAerialPerspectiveNode` is deleted. Emission tests in `src/shadow/aerialShadowAdapter.test.ts` check the compiled WGSL: the direct term is multiplied by the shadow exactly once and the indirect term never; the mask is applied only with lighting on.

The ARM BC budget-closure lanes (`budgetClosure`, `opticalDepthNode`, `BC_SENTINEL_*`) lived only in the subclass and are removed with it. The parity harness refuses a `bcLane` parameter.

The subclass's last revision assembled the plate as `D·T·s + I·T`, a re-association added for those lanes. The fork node keeps this ADR's summed form `(D·s + I)·T`. On SwiftShader readbacks it is bit-identical to the subclass before that change, and within float32 rounding (≤ 3.1e-6 relative) of its last revision.

**Superseded:** the "3.2a interface shape" paragraph (the interim subclass and its WGSL snapshot), and the Consequences bullets "The library ships an adapter file with the subclass" and "The WGSL snapshot test on the interim subclass catches upstream drift".

## References

- `reference/atmosphere-webgpu/AerialPerspectiveNode.ts:55, 73–80, ~186–230`
- `reference/atmosphere-webgpu/AtmosphereLightNode.ts:21, 77`
- `aerialPerspectiveEffect.frag:357` (WebGL shadow sample)
- ADR-001 (render graph, lighting modes)
- ADR-006 (atlas and ground sampler)
