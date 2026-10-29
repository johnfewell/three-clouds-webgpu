#!/usr/bin/env node
// Per-stage GPU cost, A vs B, paired and alternating (epic: the layer-model knobs)
// B: per-pass timestamps, exclusive cost by END order (tiled-GPU passes start
// together). A: TIME_ELAPSED segments, checked against whole-frame queries.
// Counts from each side's march target, with A's reset-per-call `out` counter
// patched to `inout` at runtime (the run refuses if that fails)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { benchmarkUrl, launchBenchmarkBrowser } from './browser.mjs'
import { CLOCK_PROTOCOL, installClockProbe } from './clock.mjs'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    output: { type: 'string' },
    cases: { type: 'string', default: 'baseline-medium' },
    sizes: { type: 'string', default: '1280x720' },
    arms: { type: 'string', default: 'A,B' },
    n: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '64' },
    frames: { type: 'string', default: '30' },
    'skip-counts': { type: 'boolean', default: false },
    // GPU state control: heat-ms runs probe dispatches before warm-up,
    // probe-band 'lo,hi' (ms) gates each arm on the ALU probe with retries
    // The band is for this kernel on one machine: calibrate it, do not copy it
    'heat-ms': { type: 'string', default: '0' },
    'probe-band': { type: 'string' },
    'probe-retries': { type: 'string', default: '2' },
    // The ramp guard's positive control: every frame in the second half of
    // the timed loop renders twice beside a concurrent ALU load, a deliberate
    // step the guard must flag on both sides
    'self-test-ramp': { type: 'boolean', default: false }
  }
})
if (!values.url || !values.output)
  throw new Error('Required: --url LOCAL_PARITY_SERVER --output NEW_JSON')
const N = Number(values.n)
const band = values['probe-band']?.split(',').map(Number) ?? null
if (band && !(band.length === 2 && band[0] < band[1]))
  throw new Error('--probe-band must be lo,hi')
const retries = Number(values['probe-retries'])
if (!(N >= 1)) throw new Error('--n must be >= 1')

// B arms. 'B' is the harness as captured (atmosphere raymarch pinned to 256
// samples, ddf); the others size the atmosphere term
const ARMS = {
  A: { side: 'A' },
  B: { side: 'B' },
  'B-atmos-default': { side: 'B', scatteringSamples: [4, 14] },
  'B-atmos-lookup': { side: 'B', atmosphereProfile: 'lookup-both' }
}
const arms = values.arms.split(',').map(id => {
  if (!ARMS[id]) throw new Error(`Unknown arm ${id}`)
  return { id, ...ARMS[id] }
})
const sizes = values.sizes.split(',').map(s => {
  const [w, h] = s.split('x').map(Number)
  if (!(w > 0 && h > 0)) throw new Error(`Bad size ${s}`)
  return { width: w, height: h }
})
const cases = values.cases.split(',').filter(Boolean)
if (!cases.length || !sizes.length || !arms.length)
  throw new Error('Refusing to measure zero cases, sizes or arms')

// ---------------------------------------------------------------- page side
// Serialized by Playwright: no module scope
async function measureStagesInPage({
  side,
  warmup,
  frames,
  scatteringSamples,
  selfTestRamp
}) {
  const p = window.__parity
  // One ALU probe after every frame, outside the measured window (clock.mjs)
  // The first call builds the probe's device, so it runs before warm-up
  const clockProbe = window.__clockProbe
  const probing = clockProbe ? (await clockProbe()) != null : false
  const probe = async () => (probing ? await clockProbe() : null)
  const renders = (f, total) => (selfTestRamp && f >= total / 2 ? 2 : 1)
  // B coalesces a second render into the first (frame nodes run once per
  // browser frame), so the self-test also loads the GPU during the frame
  const load = async (f, total) => {
    if (renders(f, total) > 1) await window.__clockLoad?.(16384)
  }
  const handle = side === 'A' ? p.sideAHandle : p.sideBHandle
  if (!handle) throw new Error(`side ${side} unavailable`)
  ;(side === 'A' ? p.sideBHandle : p.sideAHandle)?.dispose()
  const renderer = handle.renderer
  const clouds = side === 'A' ? handle.clouds : handle.cloudsContext
  if (scatteringSamples) {
    const s = handle.atmosphereContext.scatteringSampleCount.value
    s.fromArray(scatteringSamples)
    if (String(s.toArray()) !== String(scatteringSamples))
      throw new Error('scatteringSamples did not apply')
  }
  handle.resetTemporalHistory()
  const nextFrame = () => new Promise(r => requestAnimationFrame(r))
  const render = frame => {
    if (side === 'A') {
      clouds.frameOverride = frame
      handle.render(0)
    } else {
      clouds.time = 0
      clouds.frame = frame
      handle.render()
    }
  }
  const out = { side, frames: [] }

  if (side === 'A') {
    const gl = renderer.getContext()
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    if (!ext) throw new Error('EXT_disjoint_timer_query_webgl2 unavailable')
    // ANGLE/Metal TIME_ELAPSED is command-buffer granular, so odd
    // frames SKIP one stage's render and time the frame whole: stage cost =
    // base - knockout. Static targets keep downstream work identical
    let skip = null
    const wrap = (obj, label, what) => {
      if (!obj || typeof obj.render !== 'function')
        throw new Error(`A hook target missing: ${what}`)
      const original = obj.render
      obj.render = function (...args) {
        if (skip === label) {
          skipped++
          return
        }
        return original.apply(this, args)
      }
    }
    let skipped = 0
    const timeWhole = fn => {
      const query = gl.createQuery()
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
      try {
        fn()
      } finally {
        gl.endQuery(ext.TIME_ELAPSED_EXT)
      }
      return query
    }
    const effectLabel = pass => {
      const effects = pass.effects ?? []
      if (effects.includes(clouds)) return 'composite'
      if (effects.some(e => /ToneMapping/.test(e.constructor.name)))
        return 'output'
      return `pass:${pass.constructor.name}`
    }
    const passLabels = handle.composer.passes.map(pass => {
      const name = pass.constructor.name
      if (name === 'RenderPass') return 'scene'
      if (name === 'NormalPass') return 'scene'
      if (name === 'CopyPass') return 'output'
      if (name === 'EffectPass') return effectLabel(pass)
      return `pass:${name}`
    })
    if (!passLabels.includes('composite'))
      throw new Error('A: no EffectPass holds the clouds effect')
    handle.composer.passes.forEach((pass, i) =>
      wrap(pass, passLabels[i], `composer[${i}]`)
    )
    wrap(clouds.shadowPass.currentPass, 'shadowMap', 'shadowPass.currentPass')
    wrap(clouds.shadowPass.resolvePass, 'shadowResolve', 'shadowPass.resolve')
    wrap(clouds.cloudsPass.currentPass, 'march', 'cloudsPass.currentPass')
    wrap(clouds.cloudsPass.resolvePass, 'cloudsResolve', 'cloudsPass.resolve')

    const waitForGpu = async () => {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush()
      const deadline = performance.now() + 5000
      for (;;) {
        const s = gl.clientWaitSync(fence, 0, 0)
        if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED) break
        if (s === gl.WAIT_FAILED || performance.now() > deadline)
          throw new Error('WebGL fence failed')
        await new Promise(r => setTimeout(r, 0))
      }
      gl.deleteSync(fence)
    }
    const readQuery = async query => {
      const deadline = performance.now() + 5000
      while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() > deadline) throw new Error('query timeout')
        await new Promise(r => setTimeout(r, 0))
      }
      const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6
      gl.deleteQuery(query)
      return ms
    }
    for (let f = 0; f < warmup; f++) {
      await nextFrame()
      render(f)
      await waitForGpu()
      await probe()
    }
    const labels = [
      ...new Set([
        ...passLabels,
        'shadowMap',
        'shadowResolve',
        'march',
        'cloudsResolve'
      ])
    ]
    out.modes = labels
    for (let f = 0; f < 2 * frames * labels.length; f++) {
      await nextFrame()
      const mode = f % 2 === 0 ? 'base' : labels[((f - 1) / 2) % labels.length]
      skip = mode === 'base' ? null : mode
      skipped = 0
      const total = 2 * frames * labels.length
      await load(f, total)
      const query = timeWhole(() => {
        for (let r = 0; r < renders(f, total); r++) render(warmup + f)
      })
      skip = null
      await waitForGpu()
      const ms = await readQuery(query)
      if (gl.getParameter(ext.GPU_DISJOINT_EXT))
        throw new Error('GPU disjoint: frame rejected')
      out.frames.push({ mode, ms, skipped, probeMs: await probe() })
    }
    return out
  }

  // ---- side B
  const backend = renderer.backend
  if (!backend?.isWebGPUBackend || backend.trackTimestamp !== true)
    throw new Error('B: WebGPU timestamp tracking unavailable')
  const names = new Map()
  const draw = backend.draw
  // Knockout frames skip every draw of one stage (same rotation as side A);
  // the pass itself still begins and ends
  let skip = null
  let skipped = 0
  backend.draw = function (object, ...args) {
    const uid = this.getTimestampUID(object.context)
    const set = names.get(uid) ?? new Set()
    const label =
      object.material.name || object.object.name || object.material.type
    set.add(label)
    names.set(uid, set)
    // A pass with NO draw is never encoded, and its unwritten timestamps fail
    // the whole frame's resolve silently. So the draw is kept and emptied
    // (drawRange count 0): the pass exists, its fragment work does not
    if (skip != null && stageOf([label]) === skip) {
      const range = object.geometry?.drawRange
      if (!range) throw new Error(`B: cannot empty draw of ${label}`)
      const count = range.count
      range.count = 0
      skipped++
      try {
        return draw.call(this, object, ...args)
      } finally {
        range.count = count
      }
    }
    return draw.call(this, object, ...args)
  }
  const stageOf = labels => {
    const s = [...labels]
    if (s.includes('RenderPipeline')) return 'composite'
    if (s.includes('CloudsPass')) return 'march'
    if (s.includes('CloudsResolve')) return 'cloudsResolve'
    if (s.includes('ShadowResolve')) return 'shadowResolve'
    if (s.includes('ShadowVelocity')) return 'shadowVelocity'
    if (s.includes('ShadowPass')) return 'shadowMap'
    if (s.some(n => /Stars|Background|ground/.test(n))) return 'scene'
    return `other:${s.join('+') || 'unlabelled'}`
  }
  let invalid = 0
  const drain = async () => {
    const passes = []
    for (const type of ['render', 'compute']) {
      const pool = backend.timestampQueryPool?.[type]
      if (!pool || pool.currentQueryIndex === 0) continue
      const offsets = [...pool.queryOffsets.entries()]
      const buffer = pool.resultBuffer
      if (!offsets.length || !buffer)
        throw new Error('B: timestamp pool shape changed')
      const getMappedRange = buffer.getMappedRange
      let captured = false
      buffer.getMappedRange = function (...args) {
        const range = getMappedRange.apply(this, args)
        const t = new BigUint64Array(range)
        for (const [uid, off] of offsets) {
          const start = t[off]
          const end = t[off + 1]
          // Unwritten queries resolve to 0 (WebGPU spec): a pass that was not
          // encoded this frame. Anything else invalid still fails.
          if (start == null || end == null || end < start || start === 0n) {
            invalid++
            continue
          }
          passes.push({
            type,
            uid,
            stage:
              type === 'compute'
                ? 'compute'
                : stageOf(names.get(uid) ?? new Set()),
            start,
            end
          })
        }
        captured = true
        return range
      }
      try {
        await renderer.resolveTimestampsAsync(type)
      } finally {
        buffer.getMappedRange = getMappedRange
      }
      // three returns its last value while the result buffer is still mapped;
      // the queries stay queued, so report it and let the caller retry
      if (!captured) {
        out.failState = out.failState ?? []
        if (out.failState.length < 6)
          out.failState.push({
            type,
            mapState: buffer.mapState,
            idx: pool.currentQueryIndex,
            offsets: offsets.length,
            pending: !!pool.pendingResolve,
            disposed: pool.isDisposed
          })
        return null
      }
    }
    return passes
  }
  // A retried readback may carry two frames' passes: the frame is discarded
  let discarded = 0
  const drainFrame = async () => {
    const passes = await drain()
    if (passes) return passes
    discarded++
    for (let i = 0; i < 5; i++) {
      await nextFrame()
      if (await drain()) return null
    }
    throw new Error('B: timestamp readback never captured')
  }
  await drainFrame()
  for (let f = 0; f < warmup; f++) {
    await nextFrame()
    render(f)
    await drainFrame()
    await probe()
  }
  discarded = 0
  await backend.device.queue.onSubmittedWorkDone()
  const labels = [
    'scene',
    'shadowMap',
    'shadowVelocity',
    'shadowResolve',
    'march',
    'cloudsResolve',
    'composite'
  ]
  out.modes = labels
  for (let f = 0; f < 2 * frames * labels.length; f++) {
    await nextFrame()
    const mode = f % 2 === 0 ? 'base' : labels[((f - 1) / 2) % labels.length]
    skip = mode === 'base' ? null : mode
    skipped = 0
    await load(f, 2 * frames * labels.length)
    for (let r = 0; r < renders(f, 2 * frames * labels.length); r++)
      render(warmup + f)
    skip = null
    await backend.device.queue.onSubmittedWorkDone()
    invalid = 0
    const passes = await drainFrame()
    const probeMs = await probe()
    if (passes == null) {
      out.discards = out.discards ?? {}
      out.discards[mode] = (out.discards[mode] ?? 0) + 1
      continue
    }
    if (!passes.length) throw new Error('B: zero timed passes')
    // Unwritten or partial pairs come from emptied knockout passes only
    if (invalid && mode === 'base')
      throw new Error(`B: ${invalid} invalid timestamp pairs on a base frame`)
    passes.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
    const first = passes.reduce(
      (m, x) => (x.start < m ? x.start : m),
      passes[0].start
    )
    let latest = first
    const stages = {}
    for (const x of passes) {
      const from = x.start > latest ? x.start : latest
      const excl = x.end > from ? Number(x.end - from) / 1e6 : 0
      stages[x.stage] = (stages[x.stage] ?? 0) + excl
      if (x.end > latest) latest = x.end
    }
    const ms = Number(latest - first) / 1e6
    out.frames.push(
      mode === 'base'
        ? { mode, ms, skipped, stages, probeMs }
        : { mode, ms, skipped, invalid, probeMs }
    )
  }
  out.discardedFrames = discarded
  if (discarded > 0.1 * 2 * frames * labels.length)
    throw new Error(
      `B: ${discarded} frames discarded (> 10%): ${JSON.stringify(out.discards)} ${JSON.stringify(out.failState)}`
    )
  return out
}

// Clock probes, on their own WebGPU device so side A's page has them
// too. ALU: a dependent-FMA kernel (clock-bound). BW: streams 64 MB (memory /
// fabric-bound). Both are medians of 9 timestamped dispatches.
async function clockProbeInPage({ heatMs, phase }) {
  let c = window.__clock
  if (!c) {
    const adapter = await navigator.gpu.requestAdapter()
    const dev = await adapter.requestDevice({
      requiredFeatures: ['timestamp-query']
    })
    const qs = dev.createQuerySet({ type: 'timestamp', count: 2 })
    const rb = dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    })
    const mb = dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    })
    const kernel = (code, entries) => {
      const pipe = dev.createComputePipeline({
        layout: 'auto',
        compute: {
          module: dev.createShaderModule({ code }),
          entryPoint: 'main'
        }
      })
      const bg = dev.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: entries.map((buffer, binding) => ({
          binding,
          resource: { buffer }
        }))
      })
      return async () => {
        const enc = dev.createCommandEncoder()
        const pass = enc.beginComputePass({
          timestampWrites: {
            querySet: qs,
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1
          }
        })
        pass.setPipeline(pipe)
        pass.setBindGroup(0, bg)
        pass.dispatchWorkgroups(1024)
        pass.end()
        enc.resolveQuerySet(qs, 0, 2, rb, 0)
        enc.copyBufferToBuffer(rb, 0, mb, 0, 16)
        dev.queue.submit([enc.finish()])
        await mb.mapAsync(GPUMapMode.READ)
        const t = new BigUint64Array(mb.getMappedRange().slice(0))
        mb.unmap()
        return Number(t[1] - t[0]) / 1e6
      }
    }
    const storage = size =>
      dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE })
    const alu = kernel(
      `@group(0) @binding(0) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 1e-6; var y = 1.0;
  for (var i = 0u; i < 2048u; i++) { x = fma(x, 1.0000001, 0.5); y = fma(y, 0.9999999, x * 1e-9); }
  o[id.x] = x + y; }`,
      [storage(65536 * 4)]
    )
    const bw = kernel(
      `@group(0) @binding(0) var<storage, read> a: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var s = vec4<f32>(0.0); let n = arrayLength(&a);
  for (var i = id.x; i < n; i += 65536u) { s += a[i]; }
  o[id.x] = s.x + s.y + s.z + s.w; }`,
      [storage(64 * 1024 * 1024), storage(65536 * 4)]
    )
    c = window.__clock = { alu, bw }
  }
  const median9 = async fn => {
    const v = []
    for (let i = 0; i < 9; i++) v.push(await fn())
    v.sort((a, b) => a - b)
    return v[4]
  }
  const out = {}
  if (phase === 'before') {
    out.aluBefore = await median9(c.alu)
    const end = performance.now() + heatMs
    while (performance.now() < end) await c.alu()
    out.aluAfterHeat = await median9(c.alu)
    out.bwAfterHeat = await median9(c.bw)
  } else {
    out.aluAfter = await median9(c.alu)
    out.bwAfter = await median9(c.bw)
  }
  return out
}

// Primary-march sample counts from each side's march render target
async function countSamplesInPage({ side }) {
  const p = window.__parity
  if (side === 'A') {
    const clouds = p.sideAHandle.clouds
    const mat = clouds.cloudsPass.currentMaterial
    const re = /\bout\s+ivec3\s+sampleCount\b/g
    const before = (mat.fragmentShader.match(re) ?? []).length
    if (before !== 2)
      throw new Error(
        `A counter patch: expected 2 'out ivec3 sampleCount', found ${before}`
      )
    mat.fragmentShader = mat.fragmentShader.replace(
      re,
      'inout ivec3 sampleCount'
    )
    mat.needsUpdate = true
  }
  p.set({ debug: 'sample-count' })
  await p.renderOnce(side, { time: 0, frame: 0, warmup: 8 })
  let data, width, height
  if (side === 'B') {
    const r = await p.readLayer()
    ;({ data, width, height } = r)
  } else {
    const { DataUtils } =
      await import('/node_modules/three/build/three.module.js')
    const renderer = p.sideAHandle.renderer
    const rt = p.sideAHandle.clouds.cloudsPass.currentRenderTarget
    width = rt.width
    height = rt.height
    const raw = new Uint16Array(width * height * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, raw)
    data = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++)
      data[i] = DataUtils.fromHalfFloat(raw[i])
  }
  const n = width * height
  if (!n) throw new Error('zero-pixel count readback')
  let steps = 0,
    shape = 0,
    detail = 0,
    marched = 0
  for (let i = 0; i < n; i++) {
    const x = data[4 * i] * 500
    const y = data[4 * i + 1] * 5
    const z = data[4 * i + 2] * 5
    if (!Number.isFinite(x + y + z)) throw new Error('non-finite count')
    steps += x
    shape += y
    detail += z
    if (x > 0) marched++
  }
  return {
    side,
    width,
    height,
    pixels: n,
    marchedPixels: marched,
    perPixel: { steps: steps / n, shape: shape / n, detail: detail / n },
    perFrame: { steps, shape, detail }
  }
}

// ---------------------------------------------------------------- node side
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sha = f => createHash('sha256').update(f).digest('hex')
const sharedJs = await readFile(resolve(root, 'build/shared.js'))
const report = {
  protocol: 'clouds-stages-v1',
  benchmark: 'per-stage-gpu-cost',
  createdAt: new Date().toISOString(),
  idleConfirmed: process.env.BENCHMARK_IDLE === '1',
  git: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
  gitDirty: execFileSync('git', [
    '-C',
    root,
    'status',
    '--porcelain',
    '--',
    'src',
    'examples/parity/src'
  ])
    .toString()
    .trim(),
  builtSharedSha256: sha(sharedJs),
  scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  machine: {
    cpu: os.cpus()[0]?.model,
    os: os.version(),
    node: process.version
  },
  method: {
    n: N,
    warmup: Number(values.warmup),
    frames: Number(values.frames),
    heatMs: Number(values['heat-ms']),
    probeBand: band,
    clock: CLOCK_PROTOCOL,
    selfTestRamp: values['self-test-ramp'],
    order:
      'per case x size: pairs alternate ABBA; a fresh browser context per arm',
    B: 'exclusive by end order over labelled timestamp passes',
    A: 'paired knockouts: whole-frame TIME_ELAPSED; odd frames skip one stage (ANGLE/Metal timer queries cannot split stages)'
  },
  runs: [],
  gateRejects: [],
  counts: []
}
const output = resolve(values.output)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, '{}\n', { flag: 'wx' })
const save = () => writeFile(output, JSON.stringify(report, null, 1) + '\n')

const browser = await launchBenchmarkBrowser()
report.chrome = browser.version()
const openPage = async (caseName, size, atmosphereProfile) => {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1
  })
  await context.addInitScript(installClockProbe)
  // Same local-only routing as browser.mjs runBrowserJob
  await context.route('**/*', async route => {
    const u = new URL(route.request().url())
    if (u.pathname.endsWith('/favicon.ico'))
      return route.fulfill({ status: 204, body: '' })
    if (u.pathname.endsWith('/stars.bin'))
      return route.fulfill({
        path: resolve(
          root,
          'examples/parity/node_modules/@takram/three-atmosphere/assets/stars.bin'
        )
      })
    if (u.pathname.endsWith('/stbn.bin'))
      return route.fulfill({
        path: resolve(root, 'test/fixtures/experimental/stbn.bin')
      })
    if (
      u.origin === new URL(values.url).origin ||
      ['data:', 'blob:'].includes(u.protocol)
    )
      return route.continue()
    return route.abort()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  const served = []
  page.on('response', r => {
    if (/\/build\/shared\.js/.test(r.url())) served.push(r)
  })
  const url = new URL(benchmarkUrl(values.url, { caseName, ...size }))
  if (atmosphereProfile)
    url.searchParams.set('atmosphereProfile', atmosphereProfile)
  await page.goto(url.toString(), { waitUntil: 'load' })
  await page.waitForFunction(() => window.__parity != null, null, {
    timeout: 120000
  })
  if (!served.length) throw new Error('page did not load build/shared.js')
  const servedSha = sha(await served[0].body())
  const servedUrl = served[0].url()
  if (!decodeURIComponent(servedUrl).includes(root))
    throw new Error(`served library is not from ${root}: ${servedUrl}`)
  return { context, page, errors, servedSha, servedUrl }
}
try {
  for (const caseName of cases)
    for (const size of sizes) {
      for (let rep = 0; rep < N; rep++) {
        const order = rep % 2 === 0 ? arms : [...arms].reverse()
        for (const arm of order) {
          for (let attempt = 0; ; attempt++) {
            const { context, page, errors, servedSha, servedUrl } =
              await openPage(caseName, size, arm.atmosphereProfile)
            let rejected = null
            try {
              const clockBefore = await page.evaluate(clockProbeInPage, {
                heatMs: Number(values['heat-ms']),
                phase: 'before'
              })
              const result = await page.evaluate(measureStagesInPage, {
                side: arm.side,
                warmup: Number(values.warmup),
                frames: Number(values.frames),
                scatteringSamples: arm.scatteringSamples ?? null,
                selfTestRamp: values['self-test-ramp']
              })
              const clockAfter = await page.evaluate(clockProbeInPage, {
                phase: 'after'
              })
              if (errors.length) throw new Error(`console errors: ${errors[0]}`)
              const clock = { ...clockBefore, ...clockAfter }
              const out = !band
                ? []
                : [clock.aluAfterHeat, clock.aluAfter].filter(
                    v => !(v >= band[0] && v <= band[1])
                  )
              const entry = {
                case: caseName,
                ...size,
                arm: arm.id,
                rep,
                attempt,
                servedSha,
                servedUrl,
                clock,
                ...result
              }
              if (out.length && attempt < retries) {
                rejected = entry
                report.gateRejects.push({ ...entry, frames: undefined })
              } else {
                if (out.length) entry.gateFailed = true
                report.runs.push(entry)
              }
              console.log(
                `${caseName} ${size.width}x${size.height} ${arm.id} rep ${rep} ` +
                  `alu ${clock.aluAfterHeat.toFixed(3)}/${clock.aluAfter.toFixed(3)} ` +
                  `bw ${clock.bwAfterHeat.toFixed(3)}/${clock.bwAfter.toFixed(3)} ` +
                  (rejected ? 'REJECTED, retrying' : 'ok')
              )
            } finally {
              await context.close()
            }
            await save()
            if (!rejected) break
          }
        }
      }
      if (!values['skip-counts'])
        for (const side of ['A', 'B']) {
          const { context, page, errors } = await openPage(caseName, size)
          try {
            const c = await page.evaluate(countSamplesInPage, { side })
            if (errors.length) throw new Error(`console errors: ${errors[0]}`)
            report.counts.push({ case: caseName, ...size, ...c })
            console.log(
              `${caseName} ${size.width}x${size.height} counts ${side} ok`
            )
          } finally {
            await context.close()
          }
          await save()
        }
    }
} finally {
  await browser.close()
  await save()
}
