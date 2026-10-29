// GPU clock-state control for frame timing (docs/BENCHMARKS.md, "Clock
// state"). The Mac mini's GPU switches clock states mid-run, so a timed frame
// is paired with a fixed ALU probe dispatched right after it, outside the
// measured window, and frames are compared in probe units (frame / probe)

export const CLOCK_PROTOCOL = 'alu-probe-per-frame-v1'

// Defaults: a run whose last-third median differs from its first-third
// median by more than 25 % ramped. The probe itself moving by more than 15 %
// means the clock state changed inside the run
export const RAMP_LIMIT = 1.25
export const PROBE_DRIFT_LIMIT = 1.15

// Serialized by Playwright without module scope (addInitScript). Defines
// window.__clockProbe(), one timed dependent-FMA dispatch on its own device
// (ms, or null without WebGPU), and window.__clockLoad(groups) for the self-test
export function installClockProbe() {
  let state = null
  const setup = async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter?.features.has('timestamp-query')) return null
    const device = await adapter.requestDevice({
      requiredFeatures: ['timestamp-query']
    })
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 1e-6; var y = 1.0;
  for (var i = 0u; i < 2048u; i++) { x = fma(x, 1.0000001, 0.5); y = fma(y, 0.9999999, x * 1e-9); }
  o[id.x] = x + y; }`
    })
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    })
    const out = device.createBuffer({
      size: 65536 * 4,
      usage: GPUBufferUsage.STORAGE
    })
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: out } }]
    })
    const querySet = device.createQuerySet({ type: 'timestamp', count: 2 })
    const resolve = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    })
    const read = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    })
    return { device, pipeline, bindGroup, querySet, resolve, read }
  }
  window.__clockLoad = async groups => {
    state ??= await setup()
    if (!state) return false
    const encoder = state.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(state.pipeline)
    pass.setBindGroup(0, state.bindGroup)
    pass.dispatchWorkgroups(groups)
    pass.end()
    state.device.queue.submit([encoder.finish()])
    return true
  }
  window.__clockProbe = async () => {
    state ??= await setup()
    if (!state) return null
    const { device, pipeline, bindGroup, querySet, resolve, read } = state
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass({
      timestampWrites: {
        querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1
      }
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(1024)
    pass.end()
    encoder.resolveQuerySet(querySet, 0, 2, resolve, 0)
    encoder.copyBufferToBuffer(resolve, 0, read, 0, 16)
    device.queue.submit([encoder.finish()])
    await read.mapAsync(GPUMapMode.READ)
    const t = new BigUint64Array(read.getMappedRange().slice(0))
    read.unmap()
    return Number(t[1] - t[0]) / 1e6
  }
}

export function median(values) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

// Frame time in probe units, frame by frame. Null when the probe is missing
// or invalid for any frame: a partial normalisation would mix clock states
export function toProbeUnits(frameMs, probeMs) {
  if (!Array.isArray(probeMs) || probeMs.length !== frameMs.length) return null
  if (!probeMs.every(p => Number.isFinite(p) && p > 0)) return null
  return frameMs.map((ms, i) => ms / probeMs[i])
}

// Last-third median over first-third median. 1 is flat, 2 is the doubling
// seen on 2026-10-08. Needs at least 6 values to say anything
export function thirdsRatio(values) {
  if (values.length < 6) return null
  const third = Math.floor(values.length / 3)
  return median(values.slice(-third)) / median(values.slice(0, third))
}

const outside = (ratio, limit) =>
  ratio != null && (ratio > limit || ratio < 1 / limit)

// The guard. A run is unstable when its frames ramp or the probe says the
// clock state changed while it ran. Reasons are kept, never just a boolean
export function clockStability(
  frameMs,
  probeMs,
  { rampLimit = RAMP_LIMIT, probeDriftLimit = PROBE_DRIFT_LIMIT } = {}
) {
  const frameRamp = thirdsRatio(frameMs)
  const units = toProbeUnits(frameMs, probeMs)
  const probeDrift = units ? thirdsRatio(probeMs) : null
  const reasons = []
  if (outside(frameRamp, rampLimit))
    reasons.push(
      `frame time ramped ${frameRamp.toFixed(2)}x from the first to the last third`
    )
  if (outside(probeDrift, probeDriftLimit))
    reasons.push(
      `clock probe moved ${probeDrift.toFixed(2)}x within the run (clock state changed)`
    )
  return {
    protocol: CLOCK_PROTOCOL,
    frameRamp,
    probeDrift,
    normalised: units != null,
    probeMedianMs: units ? median(probeMs) : null,
    unitsMedian: units ? median(units) : null,
    stable: reasons.length === 0,
    reasons
  }
}
