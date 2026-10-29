# ADR-004 — Context injection: nodes read atmosphere + clouds via renderer.contextNode

## Context

`@takram/three-atmosphere` 0.18.0 removed `atmosphereContext` constructor parameters from all nodes/objects. The WebGPU usage pattern is:

```ts
renderer.contextNode = context({
  ...renderer.contextNode.value,
  getAtmosphere: () => atmosphereContext,
})
renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
scene.add(new AtmosphereLight())
```

Nodes resolve the atmosphere in `setup(builder)` via `getAtmosphereContext(builder)` (`AtmosphereContext.ts:152–166`), which reads `builder.context.getAtmosphere()` and throws `'getAtmosphere() was not found in the context.'` or `'getAtmosphere() must return an instanceof AtmosphereContext.'`.

## Decision

No constructor-injected contexts. Consumers register both contexts on the renderer:

```ts
renderer.contextNode = context({
  ...renderer.contextNode.value,
  getAtmosphere: () => atmosphereContext,
  getClouds: () => cloudsContext,
})
```

The port mirrors the atmosphere pattern: `getCloudsContext(builder | renderer)` reads `builder.context.getClouds()` and throws the same shaped errors for `getClouds`. Every node in the package uses `getCloudsContext`, never a constructor arg.

## Consequences

- `CloudsContext` is a plain class (not a Node) holding layers, knobs, textures, `time`, `frame`, and uniform nodes that the pass/march `Fn`s reference — mirroring `AtmosphereContext`.
- The library exports `getCloudsContext(host)` as the single resolution point.
- A node built without `getClouds` in the context throws a documented message; `getCloudsContext` also catches `instanceof AtmosphereContext` failures and rethrows with the hint `'multiple copies of @takram/three-atmosphere are installed'`.
- Tests: a node built without `getClouds` in the context must throw the documented message.

## References

- `reference/atmosphere-webgpu/AtmosphereContext.ts:15–166`
- ADR-012 (package identity — why peers prevent the `instanceof` break)
- ADR-013 (atmosphere source of truth — aliases forwarding to the atmosphere context)
