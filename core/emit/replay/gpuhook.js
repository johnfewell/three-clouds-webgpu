// WebGPU recorder used by the replay proof
// unchanged: the recorder that captures the oracle side of the replay proof
// Page-side WebGPU call recorder. Injected with addInitScript before any module
// Records every device-level call in order, with object ids and data blobs,
// so a three-free page can replay it and an analyser can tabulate the graph
;(() => {
  if (!globalThis.GPUDevice) return
  const T = (globalThis.__gpuTrace = {
    ops: [],
    blobs: [],
    pending: [],
    textures: new Map(),
    live: new Map(),
    errors: [],
    recording: true
  })
  const ids = new WeakMap()
  let nextId = 1
  const idOf = o => {
    let i = ids.get(o)
    if (i == null) {
      i = nextId++
      ids.set(o, i)
      T.live.set(i, o)
    }
    return i
  }
  // native interfaces only: three 0.185 has its own GPU*Descriptor classes
  const NATIVE = [
    'GPUAdapter',
    'GPUDevice',
    'GPUQueue',
    'GPUBuffer',
    'GPUTexture',
    'GPUTextureView',
    'GPUSampler',
    'GPUBindGroupLayout',
    'GPUPipelineLayout',
    'GPUBindGroup',
    'GPUShaderModule',
    'GPURenderPipeline',
    'GPUComputePipeline',
    'GPUCommandEncoder',
    'GPUCommandBuffer',
    'GPURenderPassEncoder',
    'GPUComputePassEncoder',
    'GPURenderBundle',
    'GPURenderBundleEncoder',
    'GPUQuerySet',
    'GPUExternalTexture',
    'GPUCanvasContext'
  ]
    .map(n => globalThis[n])
    .filter(Boolean)
  const isGPU = v =>
    v != null && typeof v === 'object' && NATIVE.some(c => v instanceof c)
  const blob = bytes => {
    T.blobs.push(new Uint8Array(bytes))
    return T.blobs.length - 1
  }
  const ser = v => {
    if (v == null || typeof v !== 'object') return v
    if (isGPU(v)) return { $r: idOf(v) }
    if (v instanceof ArrayBuffer)
      return { $b: blob(v.slice(0)), t: 'ArrayBuffer' }
    if (ArrayBuffer.isView(v))
      return {
        $b: blob(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)),
        t: v.constructor.name
      }
    if (Array.isArray(v)) return v.map(ser)
    if (v instanceof Set) return [...v].map(ser)
    if (typeof v[Symbol.iterator] === 'function' && !(v instanceof String))
      return [...v].map(ser)
    const o = {}
    for (const k in v) {
      const x = v[k]
      if (typeof x !== 'function') o[k] = ser(x)
    }
    return o
  }
  const rec = op => {
    if (T.recording) T.ops.push(op)
    return op
  }
  const orig = {}
  const wrap = (cls, name, fn) => {
    const proto = globalThis[cls]?.prototype
    if (!proto || typeof proto[name] !== 'function') return
    const o = proto[name]
    orig[cls + '.' + name] = o
    proto[name] = function (...args) {
      return fn.call(this, o, args)
    }
  }
  const generic = (cls, name) =>
    wrap(cls, name, function (o, args) {
      const op = rec({
        op: cls + '.' + name,
        self: idOf(this),
        args: ser(args)
      })
      const r = o.apply(this, args)
      if (r instanceof Promise) {
        r.then(v => {
          if (isGPU(v)) {
            ids.set(v, op.ret ?? (op.ret = nextId++))
            T.live.set(op.ret, v)
          }
        })
        if (/Async$/.test(name)) op.ret = nextId++
      } else if (isGPU(r)) op.ret = idOf(r)
      return r
    })

  // adapter + device creation: features and limits for the replay
  wrap('GPU', 'requestAdapter', async function (o, args) {
    const a = await o.apply(this, args)
    if (a) rec({ op: 'requestAdapter', args: ser(args), ret: idOf(a) })
    return a
  })
  wrap('GPUAdapter', 'requestDevice', async function (o, args) {
    const d = await o.apply(this, args)
    const desc = args[0] ?? {}
    const limits = {}
    for (const k in desc.requiredLimits ?? {})
      if (desc.requiredLimits[k] != null) limits[k] = desc.requiredLimits[k]
    rec({
      op: 'requestDevice',
      self: idOf(this),
      features: [...(desc.requiredFeatures ?? [])],
      limits,
      ret: idOf(d),
      queue: idOf(d.queue)
    })
    d.addEventListener('uncapturederror', e =>
      T.errors.push(String(e.error?.message ?? e))
    )
    return d
  })

  // textures: force COPY_SRC so any texture can be snapshotted, and keep the
  // descriptor for the snapshot and the inventory
  wrap('GPUDevice', 'createTexture', function (o, args) {
    const d = { ...args[0] }
    if (!((d.sampleCount ?? 1) > 1)) d.usage |= GPUTextureUsage.COPY_SRC
    if (/^depth/.test(d.format) && !((d.sampleCount ?? 1) > 1))
      d.usage |= GPUTextureUsage.TEXTURE_BINDING
    const t = o.call(this, d)
    const id = idOf(t)
    T.textures.set(id, { desc: ser(d), destroyed: false })
    rec({
      op: 'GPUDevice.createTexture',
      self: idOf(this),
      args: [ser(d)],
      ret: id
    })
    return t
  })
  wrap('GPUTexture', 'destroy', function (o, args) {
    const id = idOf(this)
    const e = T.textures.get(id)
    if (e) e.destroyed = true
    rec({ op: 'GPUTexture.destroy', self: id, args: [] })
    return o.apply(this, args)
  })
  // canvas texture: the replay substitutes an offscreen texture
  wrap('GPUCanvasContext', 'configure', function (o, args) {
    const d = { ...args[0] }
    d.usage =
      (d.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC
    rec({ op: 'GPUCanvasContext.configure', self: idOf(this), args: [ser(d)] })
    this.__fmt = d.format
    this.__usage = d.usage
    return o.call(this, d)
  })
  wrap('GPUCanvasContext', 'getCurrentTexture', function (o, args) {
    const t = o.apply(this, args)
    const id = idOf(t)
    if (!T.textures.has(id)) {
      const desc = {
        size: [t.width, t.height, 1],
        format: t.format,
        usage: t.usage,
        canvas: true
      }
      T.textures.set(id, { desc, destroyed: false })
      rec({ op: 'canvasTexture', self: idOf(this), desc, ret: id })
    }
    return t
  })
  // mapped-at-creation buffers: the bytes written into the range are data
  const ranges = new WeakMap()
  wrap('GPUBuffer', 'getMappedRange', function (o, args) {
    const r = o.apply(this, args)
    if (!ranges.has(this)) ranges.set(this, [])
    ranges.get(this).push({ off: args[0] ?? 0, ab: r })
    return r
  })
  wrap('GPUBuffer', 'unmap', function (o, args) {
    const rs = ranges.get(this)
    if (rs) {
      for (const { off, ab } of rs)
        if (ab.byteLength)
          rec({
            op: 'mappedWrite',
            self: idOf(this),
            off,
            $b: blob(ab.slice(0))
          })
      ranges.delete(this)
    }
    rec({ op: 'GPUBuffer.unmap', self: idOf(this), args: [] })
    return o.apply(this, args)
  })
  // images: upload as usual, then snapshot the destination so the replay
  // can use writeTexture with the decoded bytes
  wrap('GPUQueue', 'copyExternalImageToTexture', function (o, args) {
    const r = o.apply(this, args)
    const [, dst, size] = args
    const op = rec({
      op: 'externalImage',
      self: idOf(this),
      dst: ser({ ...dst, texture: undefined }),
      texture: idOf(dst.texture),
      size: ser(size),
      snap: null
    })
    T.pending.push(
      snapshot(dst.texture, dst.mipLevel ?? 0).then(s => {
        op.snap = s
      })
    )
    return r
  })

  const BPT = {
    r8unorm: 1,
    r8snorm: 1,
    r8uint: 1,
    rg8unorm: 2,
    rgba8unorm: 4,
    'rgba8unorm-srgb': 4,
    bgra8unorm: 4,
    'bgra8unorm-srgb': 4,
    r16float: 2,
    rg16float: 4,
    rgba16float: 8,
    r32float: 4,
    rg32float: 8,
    rgba32float: 16,
    r32uint: 4,
    rgba32uint: 16,
    rgb10a2unorm: 4,
    rg11b10ufloat: 4,
    depth32float: 4,
    r16uint: 2,
    rg32uint: 8
  }
  // copies one mip of every layer/slice into a padded buffer
  async function snapshot(tex, mip = 0) {
    const C = orig
    const dev = T.device
    const fmt = tex.format
    if (fmt === 'depth24plus') return depthSnapshot(tex)
    const bpt = BPT[fmt]
    if (!bpt) return { skipped: 'format ' + fmt }
    const w = Math.max(1, tex.width >> mip)
    const h = tex.dimension === '1d' ? 1 : Math.max(1, tex.height >> mip)
    const d =
      tex.dimension === '3d'
        ? Math.max(1, tex.depthOrArrayLayers >> mip)
        : tex.depthOrArrayLayers
    const bpr = Math.ceil((w * bpt) / 256) * 256
    const size = bpr * h * d
    const buf = C['GPUDevice.createBuffer'].call(dev, {
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    })
    const enc = C['GPUDevice.createCommandEncoder'].call(dev)
    C['GPUCommandEncoder.copyTextureToBuffer'].call(
      enc,
      {
        texture: tex,
        mipLevel: mip,
        aspect: fmt.startsWith('depth') ? 'depth-only' : 'all'
      },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
      [w, h, d]
    )
    C['GPUQueue.submit'].call(dev.queue, [
      C['GPUCommandEncoder.finish'].call(enc)
    ])
    await C['GPUBuffer.mapAsync'].call(buf, GPUMapMode.READ)
    const bytes = new Uint8Array(
      C['GPUBuffer.getMappedRange'].call(buf).slice(0)
    )
    C['GPUBuffer.unmap'].call(buf)
    C['GPUBuffer.destroy'].call(buf)
    return { fmt, w, h, d, bpr, bpt, $b: blob(bytes) }
  }
  // depth24plus cannot be copied: textureLoad it into an f32 storage buffer
  async function depthSnapshot(tex) {
    const C = orig
    const dev = T.device
    const w = tex.width
    const h = tex.height
    const code = `@group(0) @binding(0) var d: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= ${w}u || g.y >= ${h}u) { return; }
  o[g.y * ${w}u + g.x] = textureLoad(d, vec2i(g.xy), 0);
}`
    const module = C['GPUDevice.createShaderModule'].call(dev, { code })
    const pipe = C['GPUDevice.createComputePipeline'].call(dev, {
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    })
    const size = w * h * 4
    const sb = C['GPUDevice.createBuffer'].call(dev, {
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    })
    const rb = C['GPUDevice.createBuffer'].call(dev, {
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    })
    const bg = C['GPUDevice.createBindGroup'].call(dev, {
      layout: C['GPUComputePipeline.getBindGroupLayout'].call(pipe, 0),
      entries: [
        {
          binding: 0,
          resource: C['GPUTexture.createView'].call(tex, {
            aspect: 'depth-only'
          })
        },
        { binding: 1, resource: { buffer: sb } }
      ]
    })
    const enc = C['GPUDevice.createCommandEncoder'].call(dev)
    const pass = C['GPUCommandEncoder.beginComputePass'].call(enc)
    C['GPUComputePassEncoder.setPipeline'].call(pass, pipe)
    C['GPUComputePassEncoder.setBindGroup'].call(pass, 0, bg)
    C['GPUComputePassEncoder.dispatchWorkgroups'].call(
      pass,
      Math.ceil(w / 8),
      Math.ceil(h / 8)
    )
    C['GPUComputePassEncoder.end'].call(pass)
    C['GPUCommandEncoder.copyBufferToBuffer'].call(enc, sb, 0, rb, 0, size)
    C['GPUQueue.submit'].call(dev.queue, [
      C['GPUCommandEncoder.finish'].call(enc)
    ])
    await C['GPUBuffer.mapAsync'].call(rb, GPUMapMode.READ)
    const bytes = new Uint8Array(
      C['GPUBuffer.getMappedRange'].call(rb).slice(0)
    )
    C['GPUBuffer.unmap'].call(rb)
    return {
      fmt: 'depth24plus-as-r32float',
      w,
      h,
      d: 1,
      bpr: w * 4,
      bpt: 4,
      $b: blob(bytes)
    }
  }
  T.snapshot = snapshot

  const GENERIC = {
    GPUDevice: [
      'createBuffer',
      'createSampler',
      'createShaderModule',
      'createBindGroupLayout',
      'createPipelineLayout',
      'createBindGroup',
      'createRenderPipeline',
      'createComputePipeline',
      'createRenderPipelineAsync',
      'createComputePipelineAsync',
      'createCommandEncoder',
      'createQuerySet',
      'createRenderBundleEncoder',
      'importExternalTexture',
      'pushErrorScope',
      'popErrorScope'
    ],
    GPUTexture: ['createView'],
    GPUBuffer: ['destroy', 'mapAsync'],
    GPUQuerySet: ['destroy'],
    GPURenderPipeline: ['getBindGroupLayout'],
    GPUComputePipeline: ['getBindGroupLayout'],
    GPUQueue: ['writeBuffer', 'writeTexture', 'submit'],
    GPUCommandEncoder: [
      'beginRenderPass',
      'beginComputePass',
      'copyBufferToBuffer',
      'copyBufferToTexture',
      'copyTextureToBuffer',
      'copyTextureToTexture',
      'clearBuffer',
      'resolveQuerySet',
      'finish',
      'pushDebugGroup',
      'popDebugGroup',
      'insertDebugMarker'
    ],
    GPURenderPassEncoder: [
      'setPipeline',
      'setBindGroup',
      'setVertexBuffer',
      'setIndexBuffer',
      'draw',
      'drawIndexed',
      'drawIndirect',
      'drawIndexedIndirect',
      'setViewport',
      'setScissorRect',
      'setBlendConstant',
      'setStencilReference',
      'executeBundles',
      'beginOcclusionQuery',
      'endOcclusionQuery',
      'end',
      'pushDebugGroup',
      'popDebugGroup',
      'insertDebugMarker'
    ],
    GPUComputePassEncoder: [
      'setPipeline',
      'setBindGroup',
      'dispatchWorkgroups',
      'dispatchWorkgroupsIndirect',
      'end',
      'pushDebugGroup',
      'popDebugGroup',
      'insertDebugMarker'
    ],
    GPURenderBundleEncoder: [
      'setPipeline',
      'setBindGroup',
      'setVertexBuffer',
      'setIndexBuffer',
      'draw',
      'drawIndexed',
      'finish'
    ]
  }
  // createBuffer/getMappedRange/unmap/destroy/mapAsync/createCommandEncoder/
  // copyTextureToBuffer/submit/finish originals must exist before wrapping
  for (const [cls, names] of Object.entries(GENERIC))
    for (const n of names) {
      const p = globalThis[cls]?.prototype
      if (p && typeof p[n] === 'function' && !orig[cls + '.' + n])
        orig[cls + '.' + n] = p[n]
    }
  for (const k of ['GPUBuffer.getMappedRange', 'GPUBuffer.unmap'])
    if (!orig[k]) orig[k] = GPUBuffer.prototype[k.split('.')[1]]
  for (const [cls, names] of Object.entries(GENERIC))
    for (const n of names) generic(cls, n)
  // re-point the originals captured above at the raw functions, since
  // generic() overwrote orig[] with the pre-wrap function (same thing)
  const devHook = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = async function (...a) {
    const d = await devHook.apply(this, a)
    T.device = d
    return d
  }

  // end of session: snapshot every live texture, serialise everything
  T.finish = async () => {
    T.recording = false
    await Promise.all(T.pending)
    const snaps = {}
    for (const [id, e] of T.textures) {
      if (e.destroyed || e.desc.canvas) continue
      const t = T.live.get(id)
      try {
        snaps[id] = await snapshot(t, 0)
      } catch (err) {
        snaps[id] = { error: String(err) }
      }
    }
    const textures = {}
    for (const [id, e] of T.textures) textures[id] = e
    return { snaps, textures }
  }
  T.serialise = async extra => {
    const parts = []
    let off = 0
    const index = T.blobs.map(b => {
      const r = [off, b.byteLength]
      off += b.byteLength
      parts.push(b)
      return r
    })
    const all = new Blob(parts)
    T.allBlob = all
    return JSON.stringify({ ops: T.ops, index, errors: T.errors, ...extra })
  }
  T.blobChunk = async (start, len) => {
    const b = T.allBlob.slice(start, start + len)
    const ab = await b.arrayBuffer()
    let s = ''
    const u = new Uint8Array(ab)
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
    return btoa(s)
  }
  T.blobSize = () => T.allBlob.size
})()
