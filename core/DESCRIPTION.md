# Graph description format (version 1)

The emitter (`core/scripts/emit.mjs`) runs the three package's TSL graph on a
fake WebGPU device in node and writes what three would have done on a GPU. Its
output is two JSON files:

- `description.json` holds the graph: WGSL, pipelines, layouts, resources,
  uniform field maps and the schedule. This is the contract a raw runtime
  executes.
- `state.json` holds case values: the bytes of every buffer and of every
  buffer write in the schedule. The CPU-state port replaces this
  file field by field.

No GPU is needed to emit. The emitter compiles the library from `src/`, not
`build/`, so TSL stays the single source.

```sh
node core/scripts/emit.mjs --case baseline-medium --out core/generated
```

## What graph

Version 1 describes one graph: the parity harness's side B (canonical post
lighting) at one ladder case. That is the graph the Phase A exit test compares
against. The case pins every graph-time switch, so one case gives one variant.
`source` records which graph, case and commit the file came from.

## Top level

| key | type | meaning |
| --- | --- | --- |
| `format` | `"three-clouds-core/description"` | refuse anything else |
| `version` | `1` | refuse a version you do not know |
| `source` | object | graph, case, commit, three version |
| `device.requiredFeatures` | string[] | what three requested. The WGSL needs `subgroups` (compute) and the LUTs need `float32-filterable` |
| `modules` | `{name: {stage, sha256, code}}` | WGSL, one module per stage per pipeline |
| `textures` | `{name: TextureInfo}` | every texture the schedule touches |
| `samplers` | `{name: GPUSamplerDescriptor}` | deduplicated by content |
| `buffers` | `{name: BufferInfo}` | uniform, vertex and index buffers |
| `bindGroupLayouts` | `{name: GPUBindGroupLayoutEntry[]}` | the entries, verbatim from three |
| `bindGroups` | `{name: {layout, entries}}` | resolved to resource names |
| `pipelines` | `{name: PipelineInfo}` | render or compute |
| `schedule` | `{init, frames, linear}` | queue steps, see below |

All names are stable for a given graph. They come from three's labels. When
two objects share a label, the first one in trace order keeps it and later
ones get `.1`, `.2`, and so on.

## Textures

```json
"shadowAtlas": {
  "size": [256, 256, 3], "format": "rgba16float", "dimension": "2d",
  "mipLevelCount": 1, "sampleCount": 1, "usage": 22
}
```

- `size` is in texels at the emitted case's resolution. Textures sized like
  the canvas are 1280x720 at `baseline-medium`. Resize is not described yet,
  see Open items.
- `external: "canvas"` marks the swap-chain texture. The runtime does not
  create it. It gets a new one each frame, and every frame step names it
  `canvas`.
- Asset textures are named by role: `shape`, `shapeDetail`, `localWeather`,
  `turbulence`, `stbn`. Their bytes are not in the description. `content`
  says where they come from: `{"file": "shape.bin"}` (a file in the parity
  assets folder) or `{"generated": "hashJitter"}` (the port's
  `createHashJitterTexture` recipe). The init steps say how three uploaded
  them.
- The scene's targets are `output` (color), `normal` and `depth`. The `ground`
  pipeline draws the app's synthetic scene into them. A runtime that takes the
  scene from the app skips the submits that use `ground`.

## Uniform names

Every uniform in every module has a stable name. There are no `nodeUniformN`
names and no `NodeBuffer_N` names.

| name | where it comes from |
| --- | --- |
| `<set>_<key>` | `setName` in the port's TSL: `camera_`, `march_`, `layer_`, `parameter_`, `shadow_`, `cascade_`, `pass_`, `resolve_`, `shadowResolve_`, and the parity harness's `shadowConsumer_`. `<key>` is the property name in that uniform set. For example, `parameter_coverage` is `createParameterUniforms().coverage` |
| plain names (`cameraNear`, `sunDirectionECEF`, `matrixWorldToECEF`, …) | named by three or takram themselves |
| `<texture>Texture`, `<texture>Texture_1` | named by the emitter after the three texture bound there. A `sample()` clone drops a TSL name, so the source cannot do this |
| `three_<export>`, `three_screenSize`, `three_viewport`, `three_dpr`, `three_matrixUniform` | three's own uniforms (for example `three_modelWorldMatrix`), named by the emitter |
| `takram_<a>_<b>_<c>` | takram uniforms, named by the emitter from the chain of properties that holds them (`takram_skyNode_starsNode_magnitudeRange`) |
| `reference_<property>` | a renderer or material reference (`reference_toneMappingExposure`) |

The names the emitter assigns exist only in the emitted WGSL. The three
package's own shaders keep three's `nodeUniformN` for those uniforms. The
names come from source in both.

## Buffers and field maps

```json
"CloudsResolve.object": {
  "size": 80, "usage": 72, "struct": "objectStruct",
  "fields": [{"name": "frame", "type": "u32", "offset": 0, "size": 4}, ...]
}
```

- A buffer is named after the first pipeline and WGSL variable it is bound to
  (`<pipeline>.<var>`). Vertex and index buffers are `<pipeline>.vertex<slot>`
  and `<pipeline>.index`.
- `fields` is the struct's host-shareable layout, computed from the WGSL that
  binds the buffer: name, WGSL type, byte offset and size. A buffer bound
  under two different structs fails the emit.
- Field names are the TSL uniform names (`setName`). Writing a value means
  writing its float32/u32 bytes at `offset`. A `mat3x3<f32>` is three vec4
  columns (48 bytes). An `array<T, N>` uses a 16-byte stride.
- `usage` is the GPUBufferUsage bitmask three created the buffer with.

## Pipelines

```json
"CloudsResolve": {
  "kind": "render",
  "layout": ["ShadowPass.g0", "CloudsResolve.g1"],
  "vertex": {"module": "CloudsResolve.vertex", "entryPoint": "main", "buffers": [...]},
  "fragment": {"module": "CloudsResolve.fragment", "entryPoint": "main", "targets": [...]},
  "primitive": {...}, "depthStencil": {...}, "multisample": {...},
  "bindings": [{"group": 1, "binding": 2, "name": "object", "kind": "uniform", "type": "objectStruct"}, ...]
}
```

- `layout` lists bind group layout names, or is `"auto"`. For `"auto"`, a
  bind group's `layout` is `"auto:<pipeline>.g<i>"`: call
  `pipeline.getBindGroupLayout(i)`.
- A layout object three shares between pipelines keeps the name of its first
  user, which is why `CloudsResolve` uses `ShadowPass.g0`.
- `vertex`, `fragment`, `primitive`, `depthStencil` and `multisample` are the
  descriptor three passed. Swap `module` for the compiled module.
- A compute pipeline has `compute: {module, entryPoint}` instead.
- `bindings` lists every WGSL module-scope binding of the pipeline's modules:
  what each `(group, binding)` slot is called and what kind of resource it
  takes. Texture and sampler names come from TSL names too.

## Bind groups

```json
"ShadowResolve.g1": {"layout": "ShadowResolve.g1", "entries": [
  {"binding": 0, "sampler": "linear-linear-nearest.clamp-to-edge"},
  {"binding": 1, "texture": "shadowVelocity", "view": {"dimension": "2d-array", ...}},
  {"binding": 2, "buffer": "ShadowResolve.object"}
]}
```

An entry names a sampler, a texture plus the `GPUTextureViewDescriptor` three
used, or a buffer (with `offset` and `size` when three gave them). A view
descriptor may carry keys a browser ignores, such as `swizzle`. Pass it
through as is.

## Schedule

The schedule is the queue's order, which is what WebGPU executes. A write
lands before any later submit. Each part is a list of steps:

| step | fields | runtime does |
| --- | --- | --- |
| `write` | `buffer, offset, size, fields` | `queue.writeBuffer(buffer, offset, bytes)`. The bytes are the next entry of the matching `state.writes` list. `fields` names the fields the write covers |
| `writeTexture` | `texture, args[]` | upload the asset. `args` holds the regions three wrote, one per layer for a volume |
| `copyExternalImage` | `texture, args` | upload an image (`flipY` and `colorSpace` as three did) |
| `submit` | `commands[]` | encode the commands into one encoder, then submit it |

Commands mirror the encoder API with names in place of objects:

- `beginRenderPass`: `colorAttachments[]` and `depthStencilAttachment`, each
  with `texture` and `view` (a view descriptor) plus three's
  load/store/clear fields.
- `beginComputePass`.
- `setPipeline {pipeline}`.
- `setBindGroup {index, bindGroup}`.
- `setVertexBuffer {slot, buffer, offset, size}`.
- `setIndexBuffer {buffer, format, offset, size}`.
- `end`.
- Anything else is `{cmd, args}`, called as `pass[cmd](...args)` with
  resources by name: `draw`, `drawIndexed`, `dispatchWorkgroups`,
  `setViewport`, `setScissorRect`. Render bundles are inlined into the
  commands of their pass.

The parts:

- `init` runs once: asset uploads, three's mip chain for `localWeather`, and
  the four atmosphere LUT dispatches (transmittance, multiple scattering,
  scattering with higher-order scattering, irradiance). Buffers start from
  `state.initial.init`.
- `frames` holds three recorded frames after a history reset. Buffers start
  from `state.initial.frames`.
  - `frames[0]` is the first frame after reset. It carries the clears of both
    shadow histories and both resolve targets.
  - `frames[1]` and `frames[2]` are the two ping-pong parities.
  - Frame `k > 0` of a sequence runs `frames[k % 2 === 1 ? 1 : 2]`.
  - The emitter records a fourth frame and refuses to write the file unless
    it repeats `frames[1]` step for step.
- `linear` is the composite again into the rgba16float `linear` target with
  no tone mapping. It reads the history of the `frames[1]` parity, so run it
  after an odd frame `k`.

## state.json

```json
{
  "initial": {"init": {"<buffer>": "<base64>"}, "frames": {"<buffer>": "<base64>"}},
  "writes": {"init": [], "frames": [["<base64>", ...], ...], "linear": ["<base64>", ...]}
}
```

These are the bytes three wrote for the emitted case, captured on the fake
device. `source.periodicValues` is true when the fourth recorded frame wrote
the same bytes as `frames[1]`. In that case `state.writes.frames[1]` and
`state.writes.frames[2]` serve every later frame. A runtime that computes its own uniforms writes fields by
name through `buffers[*].fields` instead.

## Not in version 1 (open items)

- Variants. One file is one graph at one case.
- Resize. Sizes are absolute. The canvas-sized textures are the ones whose
  size equals the canvas.
- Temporal upscale and Bayer, light shafts, moon, haze: not in this case's
  graph.
- Atmosphere parameters are WGSL literals, in 10 modules: the 4 LUT
  computes, the march (vertex and fragment), the stars vertex, both
  composites, and the app's ground material. They stay literals in version 1
  for three reasons.
  - takram builds `AtmosphereContextBase.parametersNode` once, in its
    constructor, as `atmosphereParametersStruct({...}).toConst()` of
    `float()`, `vec3()`, `ivec2()` and `uint()` literal nodes
    (`reference/atmosphere-webgpu/AtmosphereContextBase.ts:164`). It offers
    no uniform option, and every atmosphere Fn takes that struct.
  - The `AtmosphereContext` belongs to the app (ADR-004 context injection).
    The port cannot replace a field of it.
  - The emitter alone could assign a uniform-backed struct before the build.
    But literals fold when the shader compiles and uniforms do not. The core
    would then no longer match the three package by construction, and that
    match is the Phase A exit test.

  So a different parameter set means a new emit. The values are read when
  the graph builds, so a parameter changed before the first render (the
  parity harness's `groundAlbedo`) does reach the literals.
- The app's scene pass (`ground`) is described but belongs to the app.

## Proof that a description is complete

`node core/scripts/prove.mjs --out <dir>` runs under the GPU lock, after
`pnpm build` and `emit.mjs`:

1. It records the three package's side B through the spike's `gpuhook.js`:
   build, then reset, then 10 frames, then the linear readback.
2. It runs the description with no three (`core/emit/replay/replay.js`).
3. It lines the oracle's last frame up with `frames[1]` pass by pass, in
   queue order, and checks that each pair runs the same pipeline.
4. It compares every texture those passes touch, byte for byte.

Its positive controls:
- Two more frames must move the linear output.
- `parameter_coverage`, written by name through the field map, must move
  the march layer.

`core/emit/emit.test.ts` checks the same round trip at queue level on the
fake device, with no GPU.
