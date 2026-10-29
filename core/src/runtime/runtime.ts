// Executes a graph description in raw WebGPU: every resource, pipeline and
// pass comes from description.json, every uniform byte from the CPU state by
// field name. Only geometry and the app's own scene buffers arrive as bytes

import {
  checkDescription,
  framePart,
  type Command,
  type Description,
  type Step,
  type SubmitStep,
  type UploadStep
} from './description'
import type { FieldSources } from './fieldValues'
import type {
  GpuBindGroup,
  GpuBindGroupLayout,
  GpuBuffer,
  GpuDevice,
  GpuPass,
  GpuPipeline,
  GpuTexture
} from './gpu'
import { bufferImage, fieldBuffers, writeBytes, writeSites } from './writes'

// GPUTextureUsage.COPY_SRC | COPY_DST and GPUBufferUsage.COPY_DST, so every
// texture can be read back and every buffer written
const TEXTURE_COPY = 0x01 | 0x02
const BUFFER_COPY_DST = 0x08

export interface RuntimeOptions {
  device: GpuDevice
  description: Description
  // Bytes of every buffer without a field map (geometry, star catalogue) and
  // of the app's own scene buffers, by buffer name
  staticBuffers: Record<string, Uint8Array>
  // Fills an asset texture as the description's upload step says
  upload: (step: UploadStep, texture: GpuTexture) => Promise<void>
}

export interface Runtime {
  readonly textures: Record<string, GpuTexture>
  readonly buffers: Record<string, GpuBuffer>
  init(sources: FieldSources): Promise<void>
  // frame k counts from the last history reset; k = 0 clears the histories
  frame(k: number, sources: FieldSources, canvas?: GpuTexture): void
  linear(sources: FieldSources): void
  resize(width: number, height: number): void
}

function mapValues<T, U>(
  record: Record<string, T>,
  fn: (value: T, key: string) => U
): Record<string, U> {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, fn(v, k)])
  )
}

function createPipelines(device: GpuDevice, d: Description) {
  const modules = mapValues(d.modules, (m, label) =>
    device.createShaderModule({ label, code: m.code })
  )
  const layouts = mapValues(d.bindGroupLayouts, (entries, label) =>
    device.createBindGroupLayout({ label, entries })
  )
  const stage = (s: { module: string } | undefined) =>
    s == null ? undefined : { ...s, module: modules[s.module]! }
  const pipelines = mapValues(d.pipelines, (p, label): GpuPipeline => {
    const layout =
      p.layout === 'auto'
        ? 'auto'
        : device.createPipelineLayout({
            bindGroupLayouts: p.layout.map(l => layouts[l]!)
          })
    if (p.kind === 'compute')
      return device.createComputePipeline({
        label,
        layout,
        compute: stage(p.compute)
      })
    return device.createRenderPipeline({
      label,
      layout,
      vertex: stage(p.vertex),
      fragment: stage(p.fragment),
      primitive: p.primitive,
      depthStencil: p.depthStencil,
      multisample: p.multisample
    })
  })
  return { layouts, pipelines }
}

// Resolves the names a command uses to the objects the runtime created
interface Resources {
  pipeline(name: string): GpuPipeline
  bindGroup(name: string): GpuBindGroup
  buffer(name: string): GpuBuffer
  view(texture: string, descriptor: unknown): unknown
}

type Args = unknown[]

// Pass methods called with the description's own arguments
const PASS_CALLS: Record<string, (pass: GpuPass, args: Args) => void> = {
  draw: (p, a) => p.draw(...(a as Parameters<GpuPass['draw']>)),
  drawIndexed: (p, a) =>
    p.drawIndexed(...(a as Parameters<GpuPass['drawIndexed']>)),
  dispatchWorkgroups: (p, a) =>
    p.dispatchWorkgroups(...(a as Parameters<GpuPass['dispatchWorkgroups']>)),
  setViewport: (p, a) =>
    p.setViewport(...(a as Parameters<GpuPass['setViewport']>)),
  setScissorRect: (p, a) =>
    p.setScissorRect(...(a as Parameters<GpuPass['setScissorRect']>))
}

function encodeCommand(pass: GpuPass, c: Command, r: Resources): void {
  const s = (key: string) => c[key] as string
  const n = (key: string) => c[key] as number | undefined
  switch (c.cmd) {
    case 'setPipeline':
      return pass.setPipeline(r.pipeline(s('pipeline')))
    case 'setBindGroup':
      return pass.setBindGroup(n('index')!, r.bindGroup(s('bindGroup')))
    case 'setVertexBuffer':
      return pass.setVertexBuffer(
        n('slot')!,
        r.buffer(s('buffer')),
        n('offset'),
        n('size')
      )
    case 'setIndexBuffer':
      return pass.setIndexBuffer(
        r.buffer(s('buffer')),
        s('format'),
        n('offset'),
        n('size')
      )
  }
  const call = PASS_CALLS[c.cmd]
  if (call == null) throw new Error(`unknown command ${c.cmd}`)
  call(pass, c['args'] as Args)
}

function attachment(
  a: Record<string, unknown> | null | undefined,
  r: Resources
): Record<string, unknown> | undefined {
  if (a == null) return undefined
  const { texture, view, ...rest } = a
  return { ...rest, view: r.view(texture as string, view) }
}

// One submit step: its commands in one encoder, then one queue submit
function submit(device: GpuDevice, step: SubmitStep, r: Resources): void {
  const encoder = device.createCommandEncoder()
  let pass: GpuPass | null = null
  for (const c of step.commands) {
    if (c.cmd === 'beginRenderPass') {
      const colors = c['colorAttachments'] as Record<string, unknown>[]
      const depth = c['depthStencilAttachment'] as Record<string, unknown>
      pass = encoder.beginRenderPass({
        colorAttachments: colors.map(a => attachment(a, r)),
        depthStencilAttachment: attachment(depth, r)
      })
    } else if (c.cmd === 'beginComputePass') {
      pass = encoder.beginComputePass()
    } else if (pass == null) {
      throw new Error(`${c.cmd} outside a pass`)
    } else if (c.cmd === 'end') {
      pass.end()
      pass = null
    } else encodeCommand(pass, c, r)
  }
  device.queue.submit([encoder.finish()])
}

interface BindGroupDeps {
  layouts: Record<string, GpuBindGroupLayout>
  pipelines: Record<string, GpuPipeline>
  samplers: Record<string, object>
  buffers: Record<string, GpuBuffer>
  view(texture: string, descriptor: unknown): unknown
}

function createBindGroup(
  device: GpuDevice,
  d: Description,
  name: string,
  deps: BindGroupDeps
): GpuBindGroup {
  const g = d.bindGroups[name]!
  const auto = /^auto:(.+)\.g(\d+)$/.exec(g.layout)
  const layout =
    auto != null
      ? deps.pipelines[auto[1]!]!.getBindGroupLayout(Number(auto[2]))
      : deps.layouts[g.layout]
  const entries = g.entries.map(e => {
    if (e.sampler != null)
      return { binding: e.binding, resource: deps.samplers[e.sampler] }
    if (e.texture != null)
      return { binding: e.binding, resource: deps.view(e.texture, e.view) }
    const resource: Record<string, unknown> = {
      buffer: deps.buffers[e.buffer!]
    }
    if (e.offset != null) resource['offset'] = e.offset
    if (e.size != null) resource['size'] = e.size
    return { binding: e.binding, resource }
  })
  return device.createBindGroup({ label: name, layout, entries })
}

// Every texture in the description, re-creatable by name for a resize. An
// external texture (the canvas) gets a stand-in for offscreen frames
function createTextures(device: GpuDevice, info: Description['textures']) {
  const textures: Record<string, GpuTexture> = {}
  const createTexture = (name: string) => {
    const t = info[name]!
    textures[name]?.destroy()
    textures[name] = device.createTexture({
      label: name,
      size: t.size,
      format: t.format,
      dimension: t.dimension,
      mipLevelCount: t.mipLevelCount,
      sampleCount: t.sampleCount,
      usage: t.usage | TEXTURE_COPY,
      viewFormats: t.viewFormats ?? []
    })
  }
  for (const name of Object.keys(info)) createTexture(name)
  return { textures, createTexture }
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { device, staticBuffers } = opts
  // our own copy: a resize rewrites its texture sizes, which the write sites
  // read for three's screenSize
  const d = checkDescription(structuredClone(opts.description))
  const computed = fieldBuffers(d).filter(b => staticBuffers[b] == null)
  const missing = Object.keys(d.buffers).filter(
    b => staticBuffers[b] == null && !computed.includes(b)
  )
  if (missing.length > 0)
    throw new Error(`no bytes and no field map: ${missing.join(' ')}`)

  const { textures, createTexture } = createTextures(device, d.textures)

  const samplers = mapValues(d.samplers, s => device.createSampler(s))
  const buffers = mapValues(d.buffers, (b, label) =>
    device.createBuffer({
      label,
      size: Math.ceil(b.size / 4) * 4,
      usage: b.usage | BUFFER_COPY_DST
    })
  )
  const { layouts, pipelines } = createPipelines(device, d)

  let external: Record<string, GpuTexture> = {}
  // bind groups never name the canvas, so they outlive a frame
  let bindGroups: Record<string, GpuBindGroup> = {}
  const resources: Resources = {
    pipeline: name => pipelines[name]!,
    buffer: name => buffers[name]!,
    view(name, descriptor) {
      const texture = external[name] ?? textures[name]
      if (texture == null) throw new Error(`no texture ${name}`)
      return texture.createView(descriptor)
    },
    bindGroup(name) {
      bindGroups[name] ??= createBindGroup(device, d, name, {
        layouts,
        pipelines,
        samplers,
        buffers,
        view: (texture, v) => resources.view(texture, v)
      })
      return bindGroups[name]
    }
  }

  function run(steps: Step[], sources: FieldSources): void {
    const sites = writeSites(d, steps)
    steps.forEach((step, i) => {
      if (step.kind === 'write') {
        const bytes = writeBytes(d, step, sites[i]!, sources)
        device.queue.writeBuffer(buffers[step.buffer]!, step.offset, bytes)
      } else if (step.kind === 'submit') submit(device, step, resources)
      else throw new Error(`upload step ${step.texture} outside init`)
    })
  }

  // every computed buffer as three leaves it before a frame's own writes
  function writeImages(sources: FieldSources): void {
    for (const name of computed)
      device.queue.writeBuffer(buffers[name]!, 0, bufferImage(d, name, sources))
  }

  return {
    textures,
    buffers,
    async init(sources) {
      for (const [name, bytes] of Object.entries(staticBuffers))
        device.queue.writeBuffer(buffers[name]!, 0, bytes)
      writeImages(sources)
      for (const step of d.schedule.init) {
        if (step.kind === 'write')
          throw new Error(`init write to ${step.buffer} is not described`)
        if (step.kind === 'submit') submit(device, step, resources)
        else await opts.upload(step, textures[step.texture]!)
      }
    },
    frame(k, sources, canvas) {
      external = canvas == null ? {} : { canvas }
      writeImages(sources)
      run(d.schedule.frames[framePart(k)]!, sources)
      external = {}
    },
    linear(sources) {
      run(d.schedule.linear, sources)
    },
    resize(width, height) {
      resizeTextures(d.textures, width, height).forEach(createTexture)
      bindGroups = {}
    }
  }
}

// Canvas-sized textures follow the canvas. Viewports in the schedule are not
// rewritten yet, so a resize is only correct for passes that set none
export function resizeTextures(
  info: Description['textures'],
  width: number,
  height: number
): string[] {
  const canvas = info['canvas']
  if (canvas == null) throw new Error('the description has no canvas')
  const [w, h] = canvas.size
  const resized: string[] = []
  for (const [name, t] of Object.entries(info)) {
    if (t.size[0] !== w || t.size[1] !== h) continue
    t.size = [width, height, ...t.size.slice(2)]
    resized.push(name)
  }
  return resized
}
