// A WebGPU device that does no GPU work and records every call three makes
// three's own backend then builds the real pipelines, layouts and bind groups
// in node, so the emitter reads them instead of re-deriving three's rules

export interface GpuOp {
  op: string
  // id of the object the method was called on, 0 for the device and globals
  self: number
  // id of the object the call returned, when it returned one
  ret?: number
  args: unknown[]
}

export interface GpuTrace {
  ops: GpuOp[]
  // the fake object for each id, so a reader can follow references
  objects: Map<number, FakeObject>
  mark(label: string): void
}

const TEXTURE_USAGE = {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16
}
const BUFFER_USAGE = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512
}
const SHADER_STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
const MAP_MODE = { READ: 1, WRITE: 2 }
const COLOR_WRITE = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

// What Chrome on the Mac mini's Metal adapter reports (the spike's hardware
// recording, 2026-10-08). three emits different WGSL and pipelines without
// core-features-and-limits (compatibility mode) or subgroups
const FEATURES = [
  'core-features-and-limits',
  'depth-clip-control',
  'depth32float-stencil8',
  'texture-compression-bc',
  'texture-compression-bc-sliced-3d',
  'texture-compression-etc2',
  'texture-compression-astc',
  'texture-compression-astc-sliced-3d',
  'timestamp-query',
  'indirect-first-instance',
  'shader-f16',
  'rg11b10ufloat-renderable',
  'bgra8unorm-storage',
  'float32-filterable',
  'float32-blendable',
  'clip-distances',
  'dual-source-blending',
  'subgroups',
  'texture-formats-tier1',
  'texture-formats-tier2'
]

const LIMITS: Record<string, number> = {
  maxTextureDimension1D: 16384,
  maxTextureDimension2D: 16384,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 2048,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 10,
  maxDynamicStorageBuffersPerPipelineLayout: 8,
  maxSampledTexturesPerShaderStage: 48,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 10,
  maxStorageTexturesPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 128,
  maxComputeWorkgroupStorageSize: 32768,
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024,
  maxComputeWorkgroupSizeY: 1024,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
  subgroupMinSize: 4,
  subgroupMaxSize: 128
}

export class FakeObject {
  // the descriptor as plain data, other GPU objects as {$r: id}
  readonly descriptor: unknown
  constructor(
    readonly kind: string,
    readonly id: number,
    descriptor: unknown
  ) {
    this.descriptor = snapshot(descriptor)
  }
}

// Plain data for the log: fake objects become {$r: id}, typed arrays a copy
export function snapshot(value: unknown, seen = new Set<unknown>()): unknown {
  if (value == null || typeof value !== 'object') return value
  if (value instanceof FakeObject) return { $r: value.id }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    )
  }
  // seen is the path from the root, so only a true cycle is cut. A value two
  // siblings share (one clearValue on two attachments) is copied both times
  if (seen.has(value)) return '[cycle]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(v => snapshot(v, seen))
    const iterable = value as { [Symbol.iterator]?: unknown }
    if (typeof iterable[Symbol.iterator] === 'function') {
      return [...(value as Iterable<unknown>)].map(v => snapshot(v, seen))
    }
    const out: Record<string, unknown> = {}
    for (const key in value) {
      const v = (value as Record<string, unknown>)[key]
      if (typeof v !== 'function') out[key] = snapshot(v, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

export function installFakeGpu(): GpuTrace {
  let nextId = 1
  const trace: GpuTrace = {
    ops: [],
    objects: new Map(),
    mark(label) {
      trace.ops.push({ op: 'mark', self: 0, args: [label] })
    }
  }
  const make = <T extends FakeObject>(o: T): T => {
    trace.objects.set(o.id, o)
    return o
  }
  const record = (op: string, self: number, args: unknown[], ret?: unknown) => {
    const entry: GpuOp = { op, self, args: args.map(a => snapshot(a)) }
    if (ret instanceof FakeObject) entry.ret = ret.id
    trace.ops.push(entry)
  }

  class Texture extends FakeObject {
    width: number
    height: number
    depthOrArrayLayers: number
    mipLevelCount: number
    sampleCount: number
    dimension: string
    format: string
    usage: number
    label: string
    constructor(desc: Record<string, unknown>) {
      super('GPUTexture', nextId++, desc)
      const size = desc['size'] as number[] | Record<string, number>
      const [w, h, d] = Array.isArray(size)
        ? size
        : [size['width'], size['height'], size['depthOrArrayLayers']]
      this.width = w ?? 1
      this.height = h ?? 1
      this.depthOrArrayLayers = d ?? 1
      this.mipLevelCount = (desc['mipLevelCount'] as number) ?? 1
      this.sampleCount = (desc['sampleCount'] as number) ?? 1
      this.dimension = (desc['dimension'] as string) ?? '2d'
      this.format = desc['format'] as string
      this.usage = desc['usage'] as number
      this.label = (desc['label'] as string) ?? ''
    }
    createView(desc?: unknown) {
      const view = make(new FakeObject('GPUTextureView', nextId++, desc))
      record('GPUTexture.createView', this.id, [desc], view)
      return view
    }
    destroy() {
      record('GPUTexture.destroy', this.id, [])
    }
  }

  class Buffer extends FakeObject {
    size: number
    usage: number
    mapState = 'unmapped'
    // the buffer's contents as the GPU would hold them
    readonly bytes: Uint8Array
    private mapped: { offset: number; range: ArrayBuffer }[] = []
    constructor(desc: Record<string, unknown>) {
      super('GPUBuffer', nextId++, desc)
      this.size = desc['size'] as number
      this.usage = desc['usage'] as number
      this.bytes = new Uint8Array(Math.ceil(this.size / 4) * 4)
      if (desc['mappedAtCreation'] === true) this.mapState = 'mapped'
    }
    getMappedRange(offset = 0, size?: number) {
      const end = size == null ? this.bytes.length : offset + size
      const range = this.bytes.slice(offset, end).buffer
      this.mapped.push({ offset, range })
      return range
    }
    mapAsync() {
      this.mapState = 'mapped'
      return Promise.resolve()
    }
    unmap() {
      for (const { offset, range } of this.mapped) {
        this.bytes.set(new Uint8Array(range), offset)
        record('mappedWrite', this.id, [offset, new Uint8Array(range)])
      }
      this.mapped = []
      this.mapState = 'unmapped'
    }
    destroy() {
      record('GPUBuffer.destroy', this.id, [])
    }
  }

  // An encoder or pass: every method is recorded and returns undefined, except
  // the few that hand back another object
  const recorder = (kind: string, desc: unknown): FakeObject => {
    const target = make(new FakeObject(kind, nextId++, desc))
    return new Proxy(target, {
      get(t, key) {
        if (key in t)
          return (t as unknown as Record<string, unknown>)[key as string]
        if (typeof key !== 'string') return undefined
        return (...args: unknown[]) => {
          let ret: unknown
          if (key === 'beginRenderPass') {
            ret = recorder('GPURenderPassEncoder', args[0])
          } else if (key === 'beginComputePass') {
            ret = recorder('GPUComputePassEncoder', args[0])
          } else if (key === 'finish') {
            ret = make(new FakeObject('GPUCommandBuffer', nextId++, null))
          }
          record(`${kind}.${key}`, t.id, args, ret)
          return ret
        }
      }
    })
  }

  const queue = {
    // recorded as [buffer, byteOffset, bytes]: WebGPU counts dataOffset and
    // size in ELEMENTS of a typed array, in bytes otherwise
    writeBuffer(
      buffer: Buffer,
      offset: number,
      data: ArrayBuffer | ArrayBufferView,
      dataOffset = 0,
      size?: number
    ) {
      const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data)
      const element =
        'BYTES_PER_ELEMENT' in view
          ? (view as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
          : 1
      const all = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      const bytes = all.slice(
        dataOffset * element,
        size == null ? undefined : (dataOffset + size) * element
      )
      buffer.bytes.set(bytes, offset)
      record('GPUQueue.writeBuffer', 0, [buffer, offset, bytes])
    },
    writeTexture(...args: unknown[]) {
      record('GPUQueue.writeTexture', 0, args)
    },
    // the source info as given (flipY, origin), the image as its size
    copyExternalImageToTexture(
      source: Record<string, unknown>,
      ...rest: unknown[]
    ) {
      const image = source['source'] as { width?: number; height?: number }
      const info = {
        ...source,
        source: { width: image.width, height: image.height }
      }
      record('GPUQueue.copyExternalImageToTexture', 0, [info, ...rest])
    },
    submit(buffers: unknown[]) {
      record('GPUQueue.submit', 0, [buffers])
    },
    onSubmittedWorkDone: () => Promise.resolve()
  }

  const shaderModule = (desc: Record<string, unknown>) =>
    Object.assign(make(new FakeObject('GPUShaderModule', nextId++, desc)), {
      getCompilationInfo: () => Promise.resolve({ messages: [] })
    })
  const pipeline = (kind: string, desc: Record<string, unknown>) =>
    Object.assign(make(new FakeObject(kind, nextId++, desc)), {
      getBindGroupLayout: (i: number) =>
        make(new FakeObject('GPUBindGroupLayout', nextId++, { auto: i }))
    })
  const creator =
    <T extends FakeObject>(op: string, build: (desc: never) => T) =>
    (desc: unknown) => {
      const ret = build(desc as never)
      record(`GPUDevice.${op}`, 0, [desc], ret)
      return ret
    }

  const device = {
    features: new Set(FEATURES),
    limits: LIMITS,
    queue,
    lost: new Promise(() => {}),
    addEventListener() {},
    removeEventListener() {},
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    destroy() {},
    createBuffer: creator('createBuffer', d => make(new Buffer(d))),
    createTexture: creator('createTexture', d => make(new Texture(d))),
    createSampler: creator('createSampler', d =>
      make(new FakeObject('GPUSampler', nextId++, d))
    ),
    createBindGroupLayout: creator('createBindGroupLayout', d =>
      make(new FakeObject('GPUBindGroupLayout', nextId++, d))
    ),
    createPipelineLayout: creator('createPipelineLayout', d =>
      make(new FakeObject('GPUPipelineLayout', nextId++, d))
    ),
    createBindGroup: creator('createBindGroup', d =>
      make(new FakeObject('GPUBindGroup', nextId++, d))
    ),
    createShaderModule: creator('createShaderModule', shaderModule),
    createRenderPipeline: creator('createRenderPipeline', d =>
      pipeline('GPURenderPipeline', d)
    ),
    createComputePipeline: creator('createComputePipeline', d =>
      pipeline('GPUComputePipeline', d)
    ),
    createRenderPipelineAsync(desc: unknown) {
      return Promise.resolve(device.createRenderPipeline(desc))
    },
    createComputePipelineAsync(desc: unknown) {
      return Promise.resolve(device.createComputePipeline(desc))
    },
    createQuerySet: creator('createQuerySet', d =>
      make(new FakeObject('GPUQuerySet', nextId++, d))
    ),
    createCommandEncoder(desc?: unknown) {
      const ret = recorder('GPUCommandEncoder', desc)
      record('GPUDevice.createCommandEncoder', 0, [desc], ret)
      return ret
    },
    createRenderBundleEncoder(desc?: unknown) {
      const ret = recorder('GPURenderBundleEncoder', desc)
      record('GPUDevice.createRenderBundleEncoder', 0, [desc], ret)
      return ret
    }
  }

  const adapter = {
    features: new Set(FEATURES),
    limits: LIMITS,
    info: { vendor: 'fake', architecture: 'fake' },
    requestDevice: (desc: unknown) => {
      record('GPUAdapter.requestDevice', 0, [desc])
      return Promise.resolve(device)
    }
  }

  const g = globalThis as Record<string, unknown>
  g['GPUTextureUsage'] = TEXTURE_USAGE
  g['GPUBufferUsage'] = BUFFER_USAGE
  g['GPUShaderStage'] = SHADER_STAGE
  g['GPUMapMode'] = MAP_MODE
  g['GPUColorWrite'] = COLOR_WRITE
  // three's animation loop asks for frames. The driver advances them itself
  g['self'] = globalThis
  g['requestAnimationFrame'] = () => 0
  g['cancelAnimationFrame'] = () => {}
  g['ProgressEvent'] ??= class ProgressEvent extends Event {}
  // three r186's draw tests the current pass with instanceof against this
  // global. The fake records no bundles, so an empty class answers false
  g['GPURenderBundleEncoder'] ??= class GPURenderBundleEncoder {}
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'node',
      gpu: {
        requestAdapter: () => Promise.resolve(adapter),
        getPreferredCanvasFormat: () => 'bgra8unorm'
      }
    }
  })
  return trace
}

// A canvas three can configure and draw into: each frame's current texture is
// a fresh fake texture, as a real swap chain does
export function createFakeCanvas(
  trace: GpuTrace,
  width: number,
  height: number
) {
  let configured: Record<string, unknown> | null = null
  const canvas = {
    width,
    height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    getContext(kind: string) {
      if (kind !== 'webgpu') return null
      return {
        canvas,
        configure(desc: Record<string, unknown>) {
          configured = desc
          trace.ops.push({
            op: 'GPUCanvasContext.configure',
            self: 0,
            args: [snapshot(desc)]
          })
        },
        unconfigure() {},
        getCurrentTexture() {
          const device = configured?.['device'] as {
            createTexture: (d: unknown) => FakeObject
          }
          const texture = device.createTexture({
            label: 'canvas',
            size: [canvas.width, canvas.height, 1],
            format: configured?.['format'],
            usage: configured?.['usage'] ?? TEXTURE_USAGE.RENDER_ATTACHMENT
          })
          trace.ops.push({
            op: 'canvasTexture',
            self: 0,
            ret: texture.id,
            args: []
          })
          return texture
        }
      }
    }
  }
  return canvas
}
