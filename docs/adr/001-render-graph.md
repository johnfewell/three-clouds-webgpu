# ADR-001 — Render graph order: sky background → MRT scene → aerial(scene) → clouds composite

## Context

WebGL (`clouds.frag:701–716` `applyAerialPerspective`) applies aerial perspective inside the march and hands a finished overlay to `AerialPerspectiveEffect`, which composites after its own scene work. The WebGPU `AerialPerspectiveNode` has no overlay input and no shadow input: constructor `(scope, colorNode, depthNode, shadowLengthNode?)`, fields `colorNode`, `depthNode`, `normalNode?`, `skyNode?`, `shadowLengthNode?: Node<'vec2'>` (`reference/atmosphere-webgpu/AerialPerspectiveNode.ts:37–73`). The equivalent is therefore `composite(aerialPerspective(scene), cloudLayer)` with the march calling the accessors per sample.

Wrong: `aerialPerspective(cloudsComposite, sceneDepth)` — it would haze the clouds as if they sat at geometry depth.

Sky: `skyBackground()` is the only sky. `aerialPerspective(...)` also sets `node.skyNode = sky(shadowLengthNode)` for pixels at far depth; do not add a second sky in the composite.

Normals and lighting (AUDIT-4 2026-08-30, corrected): post-lighting is the explicit `AerialPerspectiveNode.lighting` boolean field — default `false`, hashed in `customCacheKey()` (`AerialPerspectiveNode.ts:55, 73–80`). When `lighting === true` the node lights every surface pixel as unlit albedo via `getSplitIlluminance` → `direct + indirect`, `luminance = color × E / π`. `normalNode` only supplies the ECEF normal; null gives the radial ellipsoid normal. There is no lighting mask (WebGL had `lightingMask`/`LightingMaskPass`), so a frame is either post-lit (`lighting = true`, unlit materials) or light-node-lit (`lighting = false`, `AtmosphereLight` on node materials).

## Decision

The WebGPU render graph is:

```text
scene.backgroundNode = skyBackground()

scene pass MRT
  ├─ color
  ├─ depth
  └─ normal (normalView)
        ▼
aerialPerspective(sceneColor, sceneDepth [+ normalNode] [, cloudShadowLength])
        │  geometry only; real scene depth
        ▼
CloudsPassNode.composite(aerializedScene)
        ▼
tonemap / bloom / grade / present
```

The canonical wiring sets `aerial.lighting = true` for the post-lit path. The MRT normal + `lighting = true` matches WebGL's `sunLight = skyLight = true` + `NormalPass` on side A, and is where the coarse Beer shadow-map optical depth feeds the
`direct` term (`src/march/primaryMarch.ts`, the `sampleShadowOpticalDepth`
addition).

The parity scene provides both lighting modes (`lighting: 'post' | 'lights'`, default `'post'`). With `lighting = true` every surface pixel is treated as unlit albedo, so one aerial node cannot mix post-lit geometry with `AtmosphereLight`-lit materials — a frame is either post-lit or light-lit, never both.

## Consequences

- `CloudsPassNode` exposes `composite(dstNode)` implementing the takram over operator (ADR-002); it never reads scene color for lighting.
- The march binds the scene camera explicitly. The fullscreen quad's TSL `camera*` nodes are never used inside a cloud pass: they resolve against the frame's camera, not the one this pass was handed.
- Because the aerial node has no overlay input, the in-march accessor path is the design, not a stopgap.
- The pass adds two inputs at this seam: `cloudShadowLength` (vec2, ADR-005) to `aerialPerspective`'s `shadowLengthNode`, and `shadowNode` (float transmittance, ADR-007) for the direct term.
- `examples/parity/src/sideB.ts` implements exactly this graph.
- `WEBGPU.md` "Changes from the WebGL API" lists the missing `lightingMask`.

## References

- `reference/atmosphere-webgpu/AerialPerspectiveNode.ts:37–80`
- `reference/clouds/src/shaders/clouds.frag:701–716`
- `cloudsEffect.frag:8–9`
- ADR-005 (shadow length vec2 encoding)
- ADR-007 (two shadow consumers)

## Amendment 1 (2026-09-24): the aerial node's sky is the visible sky; the background is a plain clear

The aerial node's sky branch writes `sky(shadowLengthNode)` into the value it returns. It replaces r, g and b of every far-depth pixel, and only the scene colour's alpha survives there.

- `AerialPerspectiveNode`'s constructor sets `skyNode`, so every adapter path has a sky by default.
- Pinned at emission: `src/shadow/aerialShadowAdapter.test.ts`, "sky pixels never show the raw scene colour", on both the plain and the cloud-shadowed path.

A `skyBackground()` on the scene was therefore a second full sky evaluation that was always overwritten. On `sky-horizon-low-sun` the scene stage cost B 0.48 vs A 0.29 ms at 1280, and 1.01 vs 0.61 at 2560 (paired A/B re-run).

**Superseded:** "`skyBackground()` is the only sky" and the `scene.backgroundNode = skyBackground()` line of the Decision.

**New decision:** the aerial node's sky is the only visible sky. The scene background is `scene.background = new Color(0x000000)`.

- Three clears a `Color` background at alpha 1, which is the alpha the sky mesh wrote (`vec4(sky, 1)`).
- The canvas output is predicted byte-identical.
- The scene pass's `normal` attachment now holds the clear value on sky pixels instead of the sky mesh's normal. Nothing reads it there: the aerial uses the normal only in its surface branch, and the march samples depth only.

The scene colour has exactly one reader, the aerial node, in every consumer (`test/sceneColourReaders.test.ts`). A new reader of the raw scene colour, such as a debug view or a lane, would see the black clear on sky pixels, so it must be added with its own sky handling.

ADR-013 Amendments 2 and 3 describe the state before gw6q, when `skyBackground()` was the visible sky on B. They are left as history.
