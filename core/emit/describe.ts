// Turns a fake-device trace into the description: named resources, pipelines
// and layouts, uniform field maps, and the queue schedule of init, three frames
// and the linear readback. core/DESCRIPTION.md is the format's contract

import { createHash } from 'node:crypto'

import type { FakeObject, GpuOp, GpuTrace } from './fakeGpu'
import {
  moduleBindings,
  parseStructs,
  structLayout,
  type Binding,
  type Field
} from './wgslLayout'

export const DESCRIPTION_FORMAT = 'three-clouds-core/description'
export const DESCRIPTION_VERSION = 1

type Ref = { $r: number }
type Json = Record<string, unknown>

export interface DescribeOptions {
  // fake GPUTexture id -> name, for textures three leaves unlabelled
  textureNames: Map<number, string>
  // marks in the trace: init runs from the start to `reset`, frames from each
  // `frame-k` to the next mark, the linear readback from `linear` to `end`
  frames: number
  source: Json
}

export interface Description {
  format: string
  version: number
  source: Json
  device: { requiredFeatures: string[] }
  modules: Record<string, { stage: string; sha256: string; code: string }>
  textures: Record<string, Json>
  samplers: Record<string, Json>
  buffers: Record<string, Json & { fields?: Field[] }>
  bindGroupLayouts: Record<string, Json[]>
  bindGroups: Record<string, { layout: string; entries: Json[] }>
  pipelines: Record<string, Json>
  schedule: { init: Step[]; frames: Step[][]; linear: Step[] }
}

export type Step =
  | {
      kind: 'write'
      buffer: string
      offset: number
      size: number
      fields: string[]
    }
  | { kind: 'writeTexture'; texture: string; args: unknown }
  | { kind: 'copyExternalImage'; texture: string; args: unknown }
  | { kind: 'submit'; commands: Json[] }

// The case values the schedule's writes carry, kept apart from the contract
export interface State {
  // buffer contents before the first step of each schedule part
  initial: { init: Record<string, string>; frames: Record<string, string> }
  // the bytes of each write step, base64, in schedule order
  writes: { init: string[]; frames: string[][]; linear: string[] }
}

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v !== '' ? v : fallback
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const isRef = (v: unknown): v is Ref =>
  v != null && typeof v === 'object' && '$r' in v

export function describe(
  trace: GpuTrace,
  opts: DescribeOptions
): { description: Description; state: State } {
  const ops = trace.ops
  const markAt = (label: string) => {
    const i = ops.findIndex(o => o.op === 'mark' && o.args[0] === label)
    if (i < 0) throw new Error(`trace has no mark ${label}`)
    return i
  }
  const obj = (r: Ref | number): FakeObject => {
    const id = typeof r === 'number' ? r : r.$r
    const o = trace.objects.get(id)
    if (o == null) throw new Error(`unknown GPU object ${id}`)
    return o
  }
  const desc = (r: Ref | number) => obj(r).descriptor as Json

  // views and command buffers point back at what made them
  const viewOf = new Map<number, { texture: number; view: unknown }>()
  const commandBufferOf = new Map<number, number>()
  for (const o of ops) {
    if (o.op === 'GPUTexture.createView' && o.ret != null)
      viewOf.set(o.ret, { texture: o.self, view: o.args[0] ?? {} })
    if (o.op === 'GPUCommandEncoder.finish' && o.ret != null)
      commandBufferOf.set(o.ret, o.self)
  }
  const encoderOps = new Map<number, GpuOp[]>()
  const passOwner = new Map<number, number>()
  for (const o of ops) {
    if (
      /^GPU(CommandEncoder|RenderPassEncoder|ComputePassEncoder|RenderBundleEncoder)\./.test(
        o.op
      )
    ) {
      const owner = o.op.startsWith('GPUCommandEncoder')
        ? o.self
        : (passOwner.get(o.self) ?? o.self)
      if (o.op.startsWith('GPUCommandEncoder.begin') && o.ret != null)
        passOwner.set(o.ret, owner)
      if (!encoderOps.has(owner)) encoderOps.set(owner, [])
      encoderOps.get(owner)!.push(o)
    }
  }

  const names = new Names()
  const out: Description = {
    format: DESCRIPTION_FORMAT,
    version: DESCRIPTION_VERSION,
    source: opts.source,
    device: { requiredFeatures: [] },
    modules: {},
    textures: {},
    samplers: {},
    buffers: {},
    bindGroupLayouts: {},
    bindGroups: {},
    pipelines: {},
    schedule: { init: [], frames: [], linear: [] }
  }
  const request = ops.find(o => o.op === 'GPUAdapter.requestDevice')
  out.device.requiredFeatures = ((request?.args[0] as Json | undefined)?.[
    'requiredFeatures'
  ] ?? []) as string[]

  const textureName = (id: number): string => {
    const t = obj(id) as unknown as Json
    const name = names.of(
      'texture',
      id,
      () => {
        const given = opts.textureNames.get(id)
        if (given != null) return given
        return str(t['label'], 'texture')
      },
      t['label'] === 'canvas'
    )
    if (out.textures[name] == null) {
      const d = desc(id)
      out.textures[name] = {
        size: [t['width'], t['height'], t['depthOrArrayLayers']],
        format: t['format'],
        dimension: t['dimension'],
        mipLevelCount: t['mipLevelCount'],
        sampleCount: t['sampleCount'],
        usage: t['usage'],
        ...(t['label'] === 'canvas' ? { external: 'canvas' } : {}),
        ...(d['viewFormats'] != null ? { viewFormats: d['viewFormats'] } : {})
      }
    }
    return name
  }
  const samplerName = (id: number) => {
    const d = desc(id)
    const key = JSON.stringify(d)
    return names.byContent('sampler', key, () => {
      const filter = (k: string) => str(d[k], 'nearest')
      const n = `${filter('magFilter')}-${filter('minFilter')}-${filter('mipmapFilter')}.${str(d['addressModeU'], 'clamp-to-edge')}`
      out.samplers[n] = d
      return n
    })
  }

  // pipelines: name from three's label, layout and modules named after it
  const pipelineName = (id: number): string =>
    names.of('pipeline', id, () => {
      const d = desc(id)
      const label = str(d['label'], 'pipeline')
        .replace(/^(render|compute)Pipeline_/, '')
        .replace(/_\d+$/, '')
      return label
    })
  const pipelineBindings = new Map<string, Binding[]>()
  const pipelineStructs = new Map<string, ReturnType<typeof parseStructs>>()
  const describePipeline = (id: number): string => {
    const name = pipelineName(id)
    if (out.pipelines[name] != null) return name
    const d = desc(id)
    const compute = d['compute'] != null
    const moduleName = (stage: string, s: Json): string => {
      const code = String(desc(s['module'] as Ref)['code'])
      const m = `${name}.${stage}`
      out.modules[m] = { stage, sha256: sha(code), code }
      const prior = pipelineBindings.get(name) ?? []
      pipelineBindings.set(name, [...prior, ...moduleBindings(code)])
      pipelineStructs.set(name, {
        ...pipelineStructs.get(name),
        ...parseStructs(code)
      })
      return m
    }
    // 'auto': the runtime asks the pipeline for its group layouts
    const layout =
      d['layout'] === 'auto'
        ? 'auto'
        : (desc(d['layout'] as Ref)['bindGroupLayouts'] as Ref[]).map(
            (l, g) => {
              const n = names.of('bindGroupLayout', l.$r, () => `${name}.g${g}`)
              out.bindGroupLayouts[n] ??= desc(l)['entries'] as Json[]
              return n
            }
          )
    const p: Json = { kind: compute ? 'compute' : 'render', layout }
    if (compute) {
      const c = d['compute'] as Json
      p['compute'] = {
        module: moduleName('compute', c),
        entryPoint: c['entryPoint']
      }
    } else {
      const v = d['vertex'] as Json
      const f = d['fragment'] as Json | undefined
      p['vertex'] = {
        module: moduleName('vertex', v),
        entryPoint: v['entryPoint'],
        buffers: v['buffers']
      }
      if (f != null)
        p['fragment'] = {
          module: moduleName('fragment', f),
          entryPoint: f['entryPoint'],
          targets: f['targets']
        }
      p['primitive'] = d['primitive']
      p['depthStencil'] = d['depthStencil']
      p['multisample'] = d['multisample']
    }
    p['bindings'] = dedupeBindings(pipelineBindings.get(name) ?? [])
    out.pipelines[name] = p
    return name
  }

  const bufferName = (id: number, hint: () => string) =>
    names.of('buffer', id, hint)
  const touchBuffer = (id: number, name: string) => {
    const b = obj(id) as unknown as Json
    out.buffers[name] ??= { size: b['size'], usage: b['usage'] }
    return name
  }
  // a uniform buffer bound at (group, binding) of a pipeline gets that
  // binding's struct as its field map
  const attachFields = (
    buffer: string,
    pipeline: string,
    group: number,
    binding: number
  ) => {
    const decl = pipelineBindings
      .get(pipeline)
      ?.find(b => b.group === group && b.binding === binding)
    if (decl == null || decl.kind !== 'uniform') return
    const layout = structLayout(decl.type, pipelineStructs.get(pipeline)!)
    const entry = out.buffers[buffer]!
    if (entry.fields == null) {
      entry['struct'] = decl.type
      entry.fields = layout.fields
    } else if (JSON.stringify(entry.fields) !== JSON.stringify(layout.fields)) {
      throw new Error(`buffer ${buffer} is bound to two different structs`)
    }
  }

  const resource = (
    r: unknown,
    pipeline: string | null,
    group: number,
    binding: number
  ): Json => {
    if (isRef(r)) {
      const o = obj(r)
      if (o.kind === 'GPUSampler') return { sampler: samplerName(r.$r) }
      if (o.kind === 'GPUTextureView') {
        const v = viewOf.get(r.$r)!
        return { texture: textureName(v.texture), view: v.view }
      }
      throw new Error(`unexpected binding resource ${o.kind}`)
    }
    const br = r as Json
    const id = (br['buffer'] as Ref).$r
    const name = bufferName(id, () => {
      const decl = pipelineBindings
        .get(pipeline ?? '')
        ?.find(b => b.group === group && b.binding === binding)
      return `${pipeline}.${decl?.name ?? `g${group}b${binding}`}`
    })
    touchBuffer(id, name)
    if (pipeline != null) attachFields(name, pipeline, group, binding)
    const e: Json = { buffer: name }
    if (br['offset'] != null) e['offset'] = br['offset']
    if (br['size'] != null) e['size'] = br['size']
    return e
  }
  const bindGroupName = (id: number, pipeline: string | null, group: number) =>
    names.of(
      'bindGroup',
      id,
      () => `${pipeline}.g${group}`,
      false,
      n => {
        const d = desc(id)
        const auto = desc(d['layout'] as Ref)['auto'] as number | undefined
        out.bindGroups[n] = {
          layout:
            auto != null
              ? `auto:${pipeline}.g${auto}`
              : (names.get('bindGroupLayout', (d['layout'] as Ref).$r) ??
                `${pipeline}.g${group}`),
          entries: (d['entries'] as Json[]).map(e => ({
            binding: e['binding'],
            ...resource(e['resource'], pipeline, group, e['binding'] as number)
          }))
        }
      }
    )

  // one encoder's commands with every object reference resolved to a name
  const encodeCommands = (encoder: number): Json[] => {
    const cmds: Json[] = []
    let pipeline: string | null = null
    for (const o of encoderOps.get(encoder) ?? []) {
      const method = o.op.split('.')[1]!
      const a = o.args
      if (method === 'beginRenderPass') {
        const d = a[0] as Json
        cmds.push({
          cmd: 'beginRenderPass',
          colorAttachments: ((d['colorAttachments'] as Json[]) ?? []).map(c =>
            c == null ? null : attachment(c)
          ),
          depthStencilAttachment:
            d['depthStencilAttachment'] == null
              ? undefined
              : attachment(d['depthStencilAttachment'] as Json)
        })
      } else if (method === 'beginComputePass') {
        cmds.push({ cmd: 'beginComputePass' })
      } else if (method === 'setPipeline') {
        pipeline = describePipeline((a[0] as Ref).$r)
        cmds.push({ cmd: 'setPipeline', pipeline })
      } else if (method === 'setBindGroup') {
        cmds.push({
          cmd: 'setBindGroup',
          index: a[0],
          bindGroup: bindGroupName((a[1] as Ref).$r, pipeline, a[0] as number)
        })
      } else if (method === 'setVertexBuffer') {
        const id = (a[1] as Ref).$r
        const name = touchBuffer(
          id,
          bufferName(id, () => `${pipeline}.vertex${String(a[0])}`)
        )
        cmds.push({
          cmd: 'setVertexBuffer',
          slot: a[0],
          buffer: name,
          offset: a[2],
          size: a[3]
        })
      } else if (method === 'setIndexBuffer') {
        const id = (a[0] as Ref).$r
        const name = touchBuffer(
          id,
          bufferName(id, () => `${pipeline}.index`)
        )
        cmds.push({
          cmd: 'setIndexBuffer',
          buffer: name,
          format: a[1],
          offset: a[2],
          size: a[3]
        })
      } else if (method === 'executeBundles') {
        // inlined: a bundle is a recorded list of the same draw commands
        for (const bundle of a[0] as Ref[]) {
          const enc = ops.find(
            x => x.ret === bundle.$r && x.op.endsWith('finish')
          )
          if (enc == null) throw new Error('render bundle without encoder')
          cmds.push(
            ...encodeCommands(enc.self).filter(c => c['cmd'] !== 'finish')
          )
        }
      } else if (method === 'finish' || method === 'end') {
        if (method === 'end') cmds.push({ cmd: 'end' })
      } else {
        cmds.push({
          cmd: method,
          args: a.map(x => (isRef(x) ? refName(x) : x))
        })
      }
    }
    return cmds
  }
  const attachment = (c: Json): Json => {
    const view = viewOf.get((c['view'] as Ref).$r)!
    const { view: _v, resolveTarget: _r, ...rest } = c
    return { ...rest, texture: textureName(view.texture), view: view.view }
  }
  const refName = (r: Ref): string => {
    const o = obj(r)
    if (o.kind === 'GPUTexture') return textureName(r.$r)
    if (o.kind === 'GPUBuffer')
      return touchBuffer(
        r.$r,
        bufferName(r.$r, () => `buffer${r.$r}`)
      )
    if (o.kind === 'GPUQuerySet') return `querySet${r.$r}`
    throw new Error(`unresolved reference ${o.kind}`)
  }

  // the queue's own order is the schedule: writes land before later submits
  const writes = {
    init: [] as string[],
    frames: [] as string[][],
    linear: [] as string[]
  }
  const schedule = (
    from: number,
    to: number,
    sink: string[],
    keep: (encoders: number[]) => boolean
  ): Step[] => {
    const steps: Step[] = []
    for (let i = from; i < to; i++) {
      const o = ops[i]!
      if (o.op === 'GPUQueue.submit') {
        const encoders = (o.args[0] as Ref[]).map(cb =>
          commandBufferOf.get(cb.$r)!
        )
        // decided before encoding, which names what it touches
        if (!keep(encoders)) continue
        const commands = encoders.flatMap(encodeCommands)
        steps.push({ kind: 'submit', commands })
      } else if (o.op === 'GPUQueue.writeBuffer') {
        const [buf, offset, bytes] = o.args as [Ref, number, Uint8Array]
        steps.push({
          kind: 'write',
          buffer: `#${buf.$r}`,
          offset,
          size: bytes.length,
          fields: []
        })
        sink.push(b64(bytes))
      } else if (o.op === 'GPUQueue.writeTexture') {
        const [dst, , layout, size] = o.args as [
          Json,
          unknown,
          unknown,
          unknown
        ]
        steps.push({
          kind: 'writeTexture',
          texture: textureName((dst['texture'] as Ref).$r),
          args: { ...dst, texture: undefined, layout, size }
        })
      } else if (o.op === 'GPUQueue.copyExternalImageToTexture') {
        const [src, dst, size] = o.args as [Json, Json, unknown]
        steps.push({
          kind: 'copyExternalImage',
          texture: textureName((dst['texture'] as Ref).$r),
          args: { source: src, dst: { ...dst, texture: undefined }, size }
        })
      }
    }
    return steps
  }

  const reset = markAt('reset')
  // init: everything before the steady frames that the frames do not repeat:
  // the LUT precompute, asset uploads and mip chains
  const frameStart = (k: number) => markAt(`frame-${k}`)
  const linear = markAt('linear')
  const end = markAt('end')
  for (let k = 0; k < opts.frames; k++) {
    const to = k + 1 < opts.frames ? frameStart(k + 1) : linear
    const sink: string[] = []
    out.schedule.frames.push(schedule(frameStart(k), to, sink, () => true))
    writes.frames.push(sink)
  }
  out.schedule.linear = schedule(linear, end, writes.linear, () => true)
  const framePipelines = new Set(
    Object.keys(out.pipelines).length === 0
      ? []
      : [...trace.objects.keys()].filter(
          id => names.get('pipeline', id) != null
        )
  )
  // through executeBundles too: three's mip blits are recorded as bundles
  const pipelinesOf = (encoders: number[]): number[] =>
    encoders.flatMap(e =>
      (encoderOps.get(e) ?? []).flatMap(o => {
        if (o.op.endsWith('.setPipeline')) return [(o.args[0] as Ref).$r]
        if (!o.op.endsWith('.executeBundles')) return []
        return pipelinesOf(
          (o.args[0] as Ref[]).map(
            b => ops.find(x => x.ret === b.$r && x.op.endsWith('finish'))!.self
          )
        )
      })
    )
  // a warm-up frame ran earlier builds of the frame pipelines: same label,
  // another object. Those are not init
  const baseLabel = (id: number) =>
    str(desc(id)['label'], '').replace(/_\d+$/, '')
  const frameLabels = new Set([...framePipelines].map(baseLabel))
  const initPass = (encoders: number[]) =>
    pipelinesOf(encoders).some(
      id => !framePipelines.has(id) && !frameLabels.has(baseLabel(id))
    )
  out.schedule.init = mergeUploads(
    schedule(0, reset, [], initPass).filter(s => s.kind !== 'write')
  )

  // writes resolve to names now that every buffer has one. Writes to buffers
  // no kept step reads are dropped, with their bytes
  const resolveWrites = (steps: Step[], sink: string[]) => {
    const keptSteps: Step[] = []
    const keptBytes: string[] = []
    let w = 0
    for (const s of steps) {
      if (s.kind !== 'write') {
        keptSteps.push(s)
        continue
      }
      const bytes = sink[w++]!
      const name = names.get('buffer', Number(s.buffer.slice(1)))
      if (name == null) continue
      const fields = (out.buffers[name]?.fields ?? [])
        .filter(
          f => f.offset < s.offset + s.size && f.offset + f.size > s.offset
        )
        .map(f => f.name)
      keptSteps.push({ ...s, buffer: name, fields })
      keptBytes.push(bytes)
    }
    return { steps: keptSteps, bytes: keptBytes }
  }
  const state: State = {
    initial: { init: {}, frames: {} },
    writes: { init: [], frames: [], linear: [] }
  }
  out.schedule.frames = out.schedule.frames.map((steps, k) => {
    const r = resolveWrites(steps, writes.frames[k]!)
    state.writes.frames.push(r.bytes)
    return r.steps
  })
  const lin = resolveWrites(out.schedule.linear, writes.linear)
  out.schedule.linear = lin.steps
  state.writes.linear = lin.bytes

  // buffer contents at the start of the init schedule and at the reset
  state.initial.frames = bufferContents(trace, reset, names)
  // init buffers are static once made, so their contents at the reset are
  // the ones init read
  const initBuffers = new Set(
    out.schedule.init.flatMap(s =>
      s.kind !== 'submit'
        ? []
        : s.commands.flatMap(c => {
            if (c['cmd'] === 'setBindGroup')
              return out.bindGroups[c['bindGroup'] as string]!.entries.flatMap(
                e => (e['buffer'] != null ? [e['buffer'] as string] : [])
              )
            return c['buffer'] != null ? [c['buffer'] as string] : []
          })
    )
  )
  state.initial.init = Object.fromEntries(
    Object.entries(state.initial.frames).filter(([k]) => initBuffers.has(k))
  )
  return { description: out, state }
}

// Every named buffer's bytes as of op `at`, replayed from the trace
function bufferContents(
  trace: GpuTrace,
  at: number,
  names: Names
): Record<string, string> {
  const shadow = new Map<number, Uint8Array>()
  for (let i = 0; i < at; i++) {
    const o = trace.ops[i]!
    if (o.op === 'GPUDevice.createBuffer' && o.ret != null)
      shadow.set(
        o.ret,
        new Uint8Array(
          Math.ceil(((o.args[0] as Json)['size'] as number) / 4) * 4
        )
      )
    else if (o.op === 'GPUQueue.writeBuffer') {
      const [buf, offset, bytes] = o.args as [Ref, number, Uint8Array]
      shadow.get(buf.$r)?.set(bytes, offset)
    } else if (o.op === 'mappedWrite') {
      const [offset, bytes] = o.args as [number, Uint8Array]
      shadow.get(o.self)?.set(bytes, offset)
    }
  }
  const out: Record<string, string> = {}
  for (const [id, bytes] of shadow) {
    const name = names.get('buffer', id)
    if (name != null) out[name] = b64(bytes)
  }
  return out
}

// a volume is uploaded one writeTexture per layer, merged to one step
function mergeUploads(steps: Step[]): Step[] {
  const out: Step[] = []
  for (const s of steps) {
    const last = out[out.length - 1]
    if (
      s.kind === 'writeTexture' &&
      last?.kind === 'writeTexture' &&
      last.texture === s.texture
    ) {
      ;(last.args as unknown[]).push(s.args)
      continue
    }
    out.push(s.kind === 'writeTexture' ? { ...s, args: [s.args] } : s)
  }
  return out
}

function dedupeBindings(bindings: Binding[]): Binding[] {
  const seen = new Map<string, Binding>()
  for (const b of bindings) seen.set(`${b.group}/${b.binding}`, b)
  return [...seen.values()].sort(
    (a, b) => a.group - b.group || a.binding - b.binding
  )
}

// Stable names: the first object to claim a base name keeps it, later ones
// get .1, .2 in trace order, so the same graph always names the same way
class Names {
  private byId = new Map<string, string>()
  private used = new Map<string, number>()
  private content = new Map<string, string>()
  get(kind: string, id: number): string | undefined {
    return this.byId.get(`${kind}:${id}`)
  }
  of(
    kind: string,
    id: number,
    base: () => string,
    shared = false,
    onCreate?: (name: string) => void
  ): string {
    const key = `${kind}:${id}`
    const known = this.byId.get(key)
    if (known != null) return known
    const b = base()
    let name = b
    if (!shared) {
      const n = this.used.get(`${kind}:${b}`) ?? 0
      this.used.set(`${kind}:${b}`, n + 1)
      if (n > 0) name = `${b}.${n}`
    }
    this.byId.set(key, name)
    onCreate?.(name)
    return name
  }
  byContent(kind: string, key: string, create: () => string): string {
    const k = `${kind}:${key}`
    const known = this.content.get(k)
    if (known != null) return known
    const name = create()
    this.content.set(k, name)
    return name
  }
}
