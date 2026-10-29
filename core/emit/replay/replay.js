// Executes a graph description (core/DESCRIPTION.md) in raw WebGPU, with no
// three and no hand-written binding table: every resource, pipeline and pass
// comes from description.json, every byte the schedule writes from state.json
// Its job is to prove the description complete, not to be the runtime

const COPY = () => GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

// lowbias32 from the port's createHashJitterTexture, the parity jitter volume
function lowbias32(x) {
  x = (x + 0x9e3779b9) | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x21f0aaad)
  x ^= x >>> 15
  x = Math.imul(x, 0x735a2d97)
  x ^= x >>> 15
  return x >>> 0
}
function generated(kind, size) {
  if (kind !== 'hashJitter') throw new Error(`unknown generated asset ${kind}`)
  const data = new Uint8Array(size[0] * size[1] * size[2])
  for (let i = 0; i < data.length; i++) data[i] = lowbias32(i) & 0xff
  return data
}

// assetBase: URL of the directory holding the asset files
export async function createReplay(device, description, state, assetBase) {
  const d = description
  if (d.format !== 'three-clouds-core/description' || d.version !== 1)
    throw new Error(`unsupported description ${d.format} v${d.version}`)

  const textures = {}
  for (const [name, t] of Object.entries(d.textures)) {
    textures[name] = device.createTexture({
      label: name,
      size: t.size,
      format: t.format,
      dimension: t.dimension,
      mipLevelCount: t.mipLevelCount,
      sampleCount: t.sampleCount,
      usage: t.usage | COPY(),
      viewFormats: t.viewFormats ?? []
    })
  }
  const samplers = {}
  for (const [name, s] of Object.entries(d.samplers))
    samplers[name] = device.createSampler(s)
  const buffers = {}
  for (const [name, b] of Object.entries(d.buffers))
    buffers[name] = device.createBuffer({
      label: name,
      size: Math.ceil(b.size / 4) * 4,
      usage: b.usage | GPUBufferUsage.COPY_DST
    })
  const modules = {}
  for (const [name, m] of Object.entries(d.modules))
    modules[name] = device.createShaderModule({ label: name, code: m.code })
  const layouts = {}
  for (const [name, entries] of Object.entries(d.bindGroupLayouts))
    layouts[name] = device.createBindGroupLayout({ label: name, entries })

  const pipelines = {}
  for (const [name, p] of Object.entries(d.pipelines)) {
    const layout =
      p.layout === 'auto'
        ? 'auto'
        : device.createPipelineLayout({
            bindGroupLayouts: p.layout.map(l => layouts[l])
          })
    const stage = s => ({ ...s, module: modules[s.module] })
    pipelines[name] =
      p.kind === 'compute'
        ? device.createComputePipeline({
            label: name,
            layout,
            compute: stage(p.compute)
          })
        : device.createRenderPipeline({
            label: name,
            layout,
            vertex: stage(p.vertex),
            fragment: p.fragment == null ? undefined : stage(p.fragment),
            primitive: p.primitive,
            depthStencil: p.depthStencil,
            multisample: p.multisample
          })
  }

  const view = (name, v, external) =>
    (external[name] ?? textures[name]).createView(v)
  const bindGroups = {}
  const bindGroup = name => {
    if (bindGroups[name] != null) return bindGroups[name]
    const g = d.bindGroups[name]
    const auto = g.layout.match(/^auto:(.+)\.g(\d+)$/)
    const layout =
      auto != null
        ? pipelines[auto[1]].getBindGroupLayout(Number(auto[2]))
        : layouts[g.layout]
    const entries = g.entries.map(e => {
      if (e.sampler != null)
        return { binding: e.binding, resource: samplers[e.sampler] }
      if (e.texture != null)
        return { binding: e.binding, resource: view(e.texture, e.view, {}) }
      const resource = { buffer: buffers[e.buffer] }
      if (e.offset != null) resource.offset = e.offset
      if (e.size != null) resource.size = e.size
      return { binding: e.binding, resource }
    })
    return (bindGroups[name] = device.createBindGroup({
      label: name,
      layout,
      entries
    }))
  }

  const writeAll = contents => {
    for (const [name, bytes] of Object.entries(contents))
      device.queue.writeBuffer(buffers[name], 0, b64(bytes))
  }

  async function upload(step) {
    const t = d.textures[step.texture]
    const content = t.content
    if (content == null) throw new Error(`no content for ${step.texture}`)
    if (step.kind === 'copyExternalImage') {
      const img = new Image()
      img.src = `${assetBase}/${content.file}`
      await img.decode()
      const { source, dst, size } = step.args
      device.queue.copyExternalImageToTexture(
        { ...source, source: img },
        { ...dst, texture: textures[step.texture] },
        size
      )
      return
    }
    const data =
      content.generated != null
        ? generated(content.generated, t.size)
        : new Uint8Array(
            await (await fetch(`${assetBase}/${content.file}`)).arrayBuffer()
          )
    for (const r of step.args) {
      const { layout, size, ...dst } = r
      device.queue.writeTexture(
        { ...dst, texture: textures[step.texture] },
        data,
        layout,
        size
      )
    }
  }

  // one encoder per submit step, commands as the description lists them
  function encode(enc, commands, external) {
    let pass = null
    for (const c of commands) {
      switch (c.cmd) {
        case 'beginRenderPass': {
          const att = a =>
            a == null
              ? null
              : (({ texture, view: v, ...rest }) => ({
                  ...rest,
                  view: view(texture, v, external)
                }))(a)
          pass = enc.beginRenderPass({
            colorAttachments: c.colorAttachments.map(att),
            depthStencilAttachment: att(c.depthStencilAttachment) ?? undefined
          })
          break
        }
        case 'beginComputePass':
          pass = enc.beginComputePass()
          break
        case 'setPipeline':
          pass.setPipeline(pipelines[c.pipeline])
          break
        case 'setBindGroup':
          pass.setBindGroup(c.index, bindGroup(c.bindGroup))
          break
        case 'setVertexBuffer':
          pass.setVertexBuffer(c.slot, buffers[c.buffer], c.offset, c.size)
          break
        case 'setIndexBuffer':
          pass.setIndexBuffer(buffers[c.buffer], c.format, c.offset, c.size)
          break
        case 'end':
          pass.end()
          pass = null
          break
        default:
          pass[c.cmd](...c.args)
      }
    }
  }

  async function run(steps, writes, external = {}) {
    let w = 0
    for (const s of steps) {
      if (s.kind === 'write') {
        device.queue.writeBuffer(buffers[s.buffer], s.offset, b64(writes[w++]))
      } else if (s.kind === 'submit') {
        const enc = device.createCommandEncoder()
        encode(enc, s.commands, external)
        device.queue.submit([enc.finish()])
      } else {
        await upload(s)
      }
    }
    if (w !== writes.length)
      throw new Error(`used ${w} of ${writes.length} write payloads`)
  }

  // init once, then reset the frame buffers to their recorded state
  writeAll(state.initial.init)
  await run(d.schedule.init, [])
  writeAll(state.initial.frames)

  const part = k => (k === 0 ? 0 : k % 2 === 1 ? 1 : 2)
  return {
    textures,
    buffers,
    // overrides a field by name, through the description's field map
    setField(buffer, field, values) {
      const f = d.buffers[buffer].fields.find(x => x.name === field)
      if (f == null) throw new Error(`no field ${field} in ${buffer}`)
      device.queue.writeBuffer(
        buffers[buffer],
        f.offset,
        new Float32Array(values)
      )
    },
    async frame(k, canvasTexture) {
      const i = part(k)
      await run(d.schedule.frames[i], state.writes.frames[i], {
        canvas: canvasTexture
      })
    },
    async linear() {
      await run(d.schedule.linear, state.writes.linear)
    }
  }
}
