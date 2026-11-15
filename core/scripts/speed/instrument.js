// Injected before any page script on BOTH bench pages, so the core and the
// three package are timed by the same code. Adds a timestamp pair to every
// render and compute pass (the frame's GPU envelope is first start to last
// end), and times shader and pipeline creation (compile on the CPU side)
;(() => {
  const SLOTS = 1024
  const perDevice = new Map()
  const createSlots = device => ({
    querySet: device.createQuerySet({ type: 'timestamp', count: SLOTS }),
    resolve: device.createBuffer({
      size: SLOTS * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    }),
    read: device.createBuffer({
      size: SLOTS * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    }),
    next: 0,
    labels: []
  })
  const slots = device => {
    let s = perDevice.get(device)
    if (s == null) {
      s = createSlots(device)
      perDevice.set(device, s)
    }
    return s
  }
  const speed = (window.__speedInstrument = {
    timing: false,
    // time inside canvas texture acquisition and queue submit while timing,
    // so a frame's CPU can be split from waits the GPU causes
    acquireMs: 0,
    submitMs: 0,
    compile: { calls: 0, ms: 0, byKind: {} },
    // passes timed since the last collect, then the GPU envelope in ms
    async collect(device) {
      const s = slots(device)
      const n = s.next
      s.next = 0
      if (n === 0) return null
      const encoder = device.createCommandEncoder()
      encoder.resolveQuerySet(s.querySet, 0, n, s.resolve, 0)
      encoder.copyBufferToBuffer(s.resolve, 0, s.read, 0, n * 8)
      device.queue.submit([encoder.finish()])
      await s.read.mapAsync(GPUMapMode.READ, 0, n * 8)
      const t = new BigUint64Array(s.read.getMappedRange(0, n * 8).slice(0))
      s.read.unmap()
      let first = null
      let last = null
      const list = []
      for (let i = 0; i < n; i += 2) {
        if (t[i] === 0n || t[i + 1] < t[i]) continue
        if (first == null || t[i] < first) first = t[i]
        if (last == null || t[i + 1] > last) last = t[i + 1]
        list.push({ label: s.labels[i / 2] ?? '?', start: t[i], end: t[i + 1] })
      }
      s.labels = []
      if (first == null) return null
      // Exclusive cost by END order: tiled-GPU passes start together, so a
      // pass is charged from the later of its start and the previous end
      list.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
      let latest = first
      const passes = list.map(p => {
        const from = p.start > latest ? p.start : latest
        const exclusive = p.end > from ? Number(p.end - from) / 1e6 : 0
        if (p.end > latest) latest = p.end
        return {
          label: p.label,
          ms: Number(p.end - p.start) / 1e6,
          exclusive
        }
      })
      return { ms: Number(last - first) / 1e6, passes: n / 2, list: passes }
    }
  })
  // three requests timestamp-query itself, the core asks for what its
  // description lists. Make sure both devices can take the pass timestamps
  const requestDevice = GPUAdapter.prototype.requestDevice
  GPUAdapter.prototype.requestDevice = function (desc = {}) {
    const features = new Set(desc.requiredFeatures ?? [])
    if (this.features.has('timestamp-query')) features.add('timestamp-query')
    return requestDevice.call(this, {
      ...desc,
      requiredFeatures: [...features]
    })
  }
  const wrapTime = (proto, name, field) => {
    const original = proto[name]
    proto[name] = function (...args) {
      if (!speed.timing) return original.apply(this, args)
      const t0 = performance.now()
      try {
        return original.apply(this, args)
      } finally {
        speed[field] += performance.now() - t0
      }
    }
  }
  wrapTime(GPUCanvasContext.prototype, 'getCurrentTexture', 'acquireMs')
  wrapTime(GPUQueue.prototype, 'submit', 'submitMs')
  const createCommandEncoder = GPUDevice.prototype.createCommandEncoder
  GPUDevice.prototype.createCommandEncoder = function (...args) {
    const encoder = createCommandEncoder.apply(this, args)
    encoder.__device = this
    return encoder
  }
  for (const method of ['beginRenderPass', 'beginComputePass']) {
    const original = GPUCommandEncoder.prototype[method]
    GPUCommandEncoder.prototype[method] = function (desc = {}) {
      if (!speed.timing || desc.timestampWrites || this.__device == null)
        return original.call(this, desc)
      const s = slots(this.__device)
      if (s.next + 2 > SLOTS) return original.call(this, desc)
      const i = s.next
      s.next += 2
      const pass = original.call(this, {
        ...desc,
        timestampWrites: {
          querySet: s.querySet,
          beginningOfPassWriteIndex: i,
          endOfPassWriteIndex: i + 1
        }
      })
      pass.__slot = { s, index: i / 2 }
      return pass
    }
  }
  // A pass is named by the first pipeline set on it (three and the core both
  // label their pipelines)
  for (const proto of [
    GPURenderPassEncoder.prototype,
    GPUComputePassEncoder.prototype
  ]) {
    const setPipeline = proto.setPipeline
    proto.setPipeline = function (pipeline) {
      const slot = this.__slot
      if (slot != null && slot.s.labels[slot.index] == null)
        slot.s.labels[slot.index] = pipeline.label || '(unlabelled)'
      return setPipeline.call(this, pipeline)
    }
  }
  const timed = (kind, fn, isAsync) =>
    function (...args) {
      const t0 = performance.now()
      const record = () => {
        const ms = performance.now() - t0
        speed.compile.calls++
        speed.compile.ms += ms
        const k = (speed.compile.byKind[kind] ??= { calls: 0, ms: 0 })
        k.calls++
        k.ms += ms
      }
      const out = fn.apply(this, args)
      if (isAsync)
        return out.then(
          v => {
            record()
            return v
          },
          e => {
            record()
            throw e
          }
        )
      record()
      return out
    }
  const proto = GPUDevice.prototype
  proto.createShaderModule = timed('shader', proto.createShaderModule)
  proto.createRenderPipeline = timed('render', proto.createRenderPipeline)
  proto.createComputePipeline = timed('compute', proto.createComputePipeline)
  proto.createRenderPipelineAsync = timed(
    'renderAsync',
    proto.createRenderPipelineAsync,
    true
  )
  proto.createComputePipelineAsync = timed(
    'computeAsync',
    proto.createComputePipelineAsync,
    true
  )
})()
