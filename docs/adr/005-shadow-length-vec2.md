# ADR-005 — shadowLength vec2 encoding for aerial + in-march accessors

## Context

WebGL clouds produced a scalar per-pixel shadow-length map (`clouds.frag:622–650` `marchShadowLength`) consumed by `AerialPerspectiveEffect.shadowLength`. The WebGPU atmosphere has its own producer `ShadowLengthNode(csmShadowNode, viewZUnitNode)` built on three's `CSMShadowNode` — mesh shadows, not cloud optical depth — so the clouds package supplies its own vec2 producer.

The `@takram/three-atmosphere` runtime (`runtime.ts:276–300`) defines a two-component encoding where `.y` is the unshadowed near distance and `.x` is the shadow interval length. Swapping the fields silently breaks the transmittance math.

## Decision

The shadow-length vec2 encoding is (verbatim from `runtime.ts:276–300`):

```text
camera |-----------|////////////////|-----------> top of atmosphere
       shadowLength.y   shadowLength.x
                   A                B
```

| Field | Meaning |
|---|---|
| `.y` | Distance camera → A (where shadow starts). When the viewer is in space it is rebased: `y = max(0, y − distanceToTop)`. |
| `.x` | Length of the shadowed interval A→B. `x == 0` triggers the runtime's no-shadow branch. |
| `shadowLimit = y + x` | Distance camera → B. |

The runtime math: camera inside shadow (branch 2): `S = T(0,p)·S(P)` with `p = shadowLength.x`; camera outside shadow (branch 3): `S = S(camera) − T(0,a)·S(A) + T(0,b)·S(B)`.

Units: the accessors take unit-space lengths (`worldToUnit`). The port's `CloudShadowLengthNode` and the in-march `shadowLength` argument to `getIndirectLuminanceToPoint` use this encoding. The in-march one is built by `applyAerialPerspective` from the marched scalar as Bruneton's Eq. 17 segment — the LAST `shadowLength` metres of the camera→front ray: `vec2(x = min(L, d), y = d − x)` (`src/march/aerialPerspective.ts`, `shadowLengthToPoint`); it was left at `vec2(0, 0)` at first, until it was fixed on 2026-09-04.

The shadow-length attachment is stored in unit space (`RG16F = vec2(shadowLength, shadowRayNearFar.x) × worldToUnit`), matching the original's scalar multiply at `clouds.frag:1001`. The node does no unit conversion — only the `.y` rebase and the gating (`vec2(0)` when `lightShafts` or `enabled` is false).

## Consequences

- `CloudShadowLengthNode` produces the vec2.
- Every consumer must respect `.y` before `.x` ordering — a unit test on the CPU-side helper asserts this and the `x == 0` no-shadow case.
- Attachments store distances in unit space, never metres, which avoids the fp16 overflow that would produce Inf/NaN in the history buffer.
- Before the shaft march landed, both fields were zero everywhere.

## References

- `reference/atmosphere-webgpu/runtime.ts:276–300`
- `clouds.frag:622–650` (`marchShadowLength`)
- `clouds.frag:1001` (unit-space multiply)

## Amendment 1 (2026-09-25): the attachment carries the reference's placement

The Decision's attachment line ("`RG16F = vec2(shadowLength, shadowRayNearFar.x) × worldToUnit`", with a `.y` rebase in the node) is superseded.

**What was wrong.** `.y` held the shadow march's near bound, `cameraNear` (100 m), on every pixel. The atmosphere consumers read `.y` as the start of the shadowed interval:
- `getIndirectRadianceToPointLookup` with `accurateShadowScattering`
- the raymarch `shadowSegment = [y, y + x]`

So every geometry ray was shadowed at its camera end, `[near, near + L]`. WebGL shadows the last `L` of the ray, `[D − L, D]` (`bruneton/runtime.glsl:318-322`, Eq. 17). The port's own in-march accessor (`shadowLengthToPoint`, above) already did that.

**New contract** (`src/march/aerialPerspective.ts`, `shadowLengthToAttachment`):

| Pixel | `.x` | `.y` |
| --- | --- | --- |
| geometry (scene ray distance `D > 0`) | `min(L, D)` | `D − x` (x + y = D; the in-march segment exactly) |
| sky | `L` | `0` (the shadow starts at the camera; the runtime's Eq. 18 case) |

Both channels are converted with the atmosphere's `worldToUnit` (km) at `clouds.frag:1001`'s site. Inside the pass, `.y` still carries the march near bound for the quad-shared shafts march; only the written output changed.

**No rebase in `CloudShadowLengthNode`.** `.y` is measured from the real camera. The runtime moves it itself when it moves an in-space camera to the atmosphere top (`reference/atmosphere-webgpu/runtime.ts:193-196, 722-725`). The removed rebase subtracted a vertical height difference, in the march's 1/bottomRadius unit, from a km value: a second shift of the wrong quantity, and in practice under a metre.

**Where it matters.** Only where a consumer reads `.y`:
- LUT lookup with `accurateShadowScattering` true: the harness and `examples/basic` and `examples/r3f`, at the atmosphere default.
- the raymarch path: the harness's `below-deck-1km` exception.

With `accurateShadowScattering = false` (the storybook) the lookup ignores `.y` on both kinds of ray, so nothing changes there.

**Pinned by:**
- `src/march/aerialPerspective.test.ts`: CPU twin and WGSL.
- `src/CloudsPassNode.test.ts`: "the shadow-length attachment encodes the surface-end segment", on the production march.
- `src/shadow/CloudShadowLengthNode.test.ts`: the node's emission has no arithmetic on the sample.
- `examples/parity/e2e/p3.spec.ts` test 18: `x + y = D` on the inside-deck frame, which replaced the camera-end value.
