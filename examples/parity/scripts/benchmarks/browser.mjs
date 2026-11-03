import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { installClockProbe } from './clock.mjs'
import { screenProfileQuality, validateProfileOptions } from './profile.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const parityRoot = join(here, '../..')
const root = join(parityRoot, '../..')
const require = createRequire(join(parityRoot, 'package.json'))
const playwrightPackage = dirname(
  require.resolve('@playwright/test/package.json')
)

export const DEFAULT_FLAGS = Object.freeze(['--enable-unsafe-webgpu'])

export class BenchmarkUnsupportedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BenchmarkUnsupportedError'
  }
}

export async function launchBenchmarkBrowser({
  headless = false,
  flags = DEFAULT_FLAGS,
  channel = process.env.BENCHMARK_BROWSER_CHANNEL
} = {}) {
  const { chromium } = await import(
    pathToFileURL(join(playwrightPackage, 'index.mjs'))
  )
  const options = { headless, args: [...flags] }
  if (channel) {
    options.channel = channel
  }
  return chromium.launch(options)
}

export function summarise(values) {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error('cannot summarise zero samples')
  if (values.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('invalid timing sample')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    values: [...values],
    count: values.length,
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1]
  }
}

export function benchmarkUrl(baseURL, scene) {
  const url = new URL(baseURL)
  url.search = new URLSearchParams({
    case: scene.caseName,
    e2e: '1',
    w: String(scene.width),
    h: String(scene.height)
  }).toString()
  return url.toString()
}

// Record the device selected by the renderer, not a second adapter request
// that could select another GPU on a hybrid PC
function recordDevices() {
  window.__benchmarkDevices = new WeakMap()
  if (!navigator.gpu) return
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
  navigator.gpu.requestAdapter = async options => {
    const adapter = await requestAdapter(options)
    if (!adapter) return adapter
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {}
    const metadata = {
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
      description: info.description ?? '',
      fallback: adapter.isFallbackAdapter ?? null,
      features: [...adapter.features].sort(),
      options
    }
    const requestDevice = adapter.requestDevice.bind(adapter)
    adapter.requestDevice = async descriptor => {
      const device = await requestDevice(descriptor)
      window.__benchmarkDevices.set(device, metadata)
      return device
    }
    return adapter
  }
}

// Playwright serializes this function without its module scope. Warmup,
// timestamp draining and pixel readback are outside the measured window
async function measureInPage({
  backend,
  scene,
  variant,
  warmupFrames,
  sampleFrames,
  profile
}) {
  const probe = window.__parity
  if (!probe) throw new Error('parity probe was not published')
  const side = backend === 'webgl' ? 'A' : 'B'
  const handle = side === 'A' ? probe.sideAHandle : probe.sideBHandle
  if (!handle) throw new Error(`UNSUPPORTED: ${backend} unavailable`)
  const clouds = side === 'A' ? handle.clouds : handle.cloudsContext
  const renderer = handle.renderer
  const gpuBackend = side === 'B' ? renderer.backend : null
  const passNames = new Map()
  const passScattering = new Map()
  const profileFrames = []
  let effectiveScatteringSamples = null
  let integration = null
  if (profile) {
    if (!gpuBackend?.isWebGPUBackend || !gpuBackend.trackTimestamp)
      throw new Error('Profiling requires WebGPU timestamp tracking')
    const samples = handle.atmosphereContext.scatteringSampleCount.value
    if (profile.scatteringSamples) samples.fromArray(profile.scatteringSamples)
    effectiveScatteringSamples = samples.toArray()
    integration = {
      cloudsRaymarch: handle.atmosphereContext.raymarchScattering,
      sceneRaymarch: handle.atmosphereContext.raymarchScattering
    }
    const draw = gpuBackend.draw
    // Pair draw labels with the same context UID the timestamp pool uses
    // Private three r185 API: missing labels/queries must fail, not look fast
    gpuBackend.draw = function (object, ...args) {
      const uid = this.getTimestampUID(object.context)
      const names = passNames.get(uid) ?? new Set()
      names.add(
        object.material.name || object.object.name || object.material.type
      )
      passNames.set(uid, names)
      if (['CloudsPass', 'RenderPipeline'].includes(object.material.name))
        passScattering.set(uid, samples.toArray())
      return draw.call(this, object, ...args)
    }
  }
  if (side === 'B' && !gpuBackend?.isWebGPUBackend)
    throw new Error('UNSUPPORTED: not a hardware WebGPU backend')
  const gl = side === 'A' ? renderer.getContext() : null
  const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2')
  const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info')
  const adapter = gpuBackend
    ? window.__benchmarkDevices.get(gpuBackend.device)
    : null
  if ((gpuBackend && !adapter) || (gl && !debugInfo))
    throw new Error('UNSUPPORTED: actual GPU identity could not be verified')
  const gpu = gl
    ? {
        vendor: String(
          gl.getParameter(debugInfo?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)
        ),
        renderer: String(
          gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)
        ),
        version: String(gl.getParameter(gl.VERSION)),
        timerQuery: !!ext
      }
    : adapter
  if (
    adapter?.fallback ||
    /swiftshader|llvmpipe|software rasterizer/i.test(JSON.stringify(gpu))
  )
    throw new Error('UNSUPPORTED: software adapter is not a hardware benchmark')

  const experiments = variant.experimental
  if (
    Object.values(experiments).some(Boolean) &&
    (side === 'A' || !('experimental' in clouds))
  )
    throw new Error(
      'UNSUPPORTED: experiments are unavailable on this renderer/build'
    )
  if (side === 'B' && 'experimental' in clouds) {
    clouds.experimental = experiments
    for (const [key, value] of Object.entries(experiments)) {
      if (clouds.experimental[key] !== value)
        throw new Error(`Experiment did not apply: ${key}`)
    }
  }
  const requested = scene.settings ?? {}
  const effective = {}
  const portOnly = new Set([
    'lightShaftsHalfResolution',
    'shadowUpdateInterval'
  ])
  for (const [key, value] of Object.entries(requested)) {
    if (side === 'A' && portOnly.has(key)) {
      effective[key] = 'not applicable'
      continue
    }
    const target =
      key === 'maxIterationCountToSun'
        ? clouds.clouds
        : key.startsWith('shadow')
          ? clouds.shadow
          : clouds
    const property =
      key === 'shadowUpdateInterval'
        ? 'updateInterval'
        : key === 'shadowTemporalPass'
          ? 'temporalPass'
          : key
    if (!target || !(property in target))
      throw new Error(`UNSUPPORTED: setting ${key} unavailable`)
    target[property] = value
    effective[key] = target[property]
    if (effective[key] !== value)
      throw new Error(`Setting did not apply: ${key}`)
  }
  const dt = scene.motion === 'shape' ? 1 / 60 : 0
  clouds.localWeatherVelocity.set(0, 0)
  clouds.shapeVelocity.set(dt ? 20 * clouds.shapeRepeat.x : 0, 0, 0)
  clouds.shapeDetailVelocity.set(dt ? 20 * clouds.shapeDetailRepeat.x : 0, 0, 0)
  clouds.localWeatherOffset.set(0, 0)
  clouds.shapeOffset.set(0, 0, 0)
  clouds.shapeDetailOffset.set(0, 0, 0)

  // E2E mode has no animation loop. Release the unmeasured renderer before
  // warming this one so its allocations cannot occupy benchmark VRAM
  const other = side === 'A' ? probe.sideBHandle : probe.sideAHandle
  other?.dispose()
  handle.resetTemporalHistory()
  const camera = {
    position: handle.camera.position.toArray(),
    quaternion: handle.camera.quaternion.toArray()
  }
  const canvas = renderer.domElement
  if (canvas.width !== scene.width || canvas.height !== scene.height)
    throw new Error(`Wrong physical viewport: ${canvas.width}x${canvas.height}`)
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))
  const waitForGpu = async () => {
    if (!gl) return gpuBackend.device.queue.onSubmittedWorkDone()
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!fence) throw new Error('Unable to allocate WebGL completion fence')
    gl.flush()
    try {
      const deadline = performance.now() + 5000
      for (;;) {
        const status = gl.clientWaitSync(fence, 0, 0)
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED)
          return
        if (status === gl.WAIT_FAILED || performance.now() > deadline)
          throw new Error('WebGL completion fence failed or timed out')
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    } finally {
      gl.deleteSync(fence)
    }
  }
  const render = frame => {
    if (document.visibilityState !== 'visible')
      throw new Error('Benchmark page is not visible')
    if (side === 'A') {
      clouds.frameOverride = frame
      handle.render(frame === 0 ? 0 : dt)
    } else {
      clouds.time = frame * dt
      clouds.frame = frame
      handle.render()
    }
  }
  const timestampEnabled =
    !!gpuBackend &&
    renderer.hasFeature('timestamp-query') &&
    gpuBackend.trackTimestamp === true
  const drain = async () => {
    const result = { passes: [] }
    let first = null
    let last = null
    for (const type of ['render', 'compute']) {
      const pool = gpuBackend?.timestampQueryPool?.[type]
      if (!pool) {
        result[type] = 0
        continue
      }
      if (!Number.isInteger(pool.currentQueryIndex))
        throw new Error('UNSUPPORTED: timestamp query instrumentation changed')
      // An empty three query pool returns lastValue. Do not charge an old
      // compute dispatch to a frame which dispatched nothing
      result[type] = 0
      if (pool.currentQueryIndex === 0) continue
      const offsets = [...pool.queryOffsets.entries()]
      if (!offsets.length || !pool.resultBuffer)
        throw new Error('UNSUPPORTED: timestamp query instrumentation changed')
      const buffer = pool.resultBuffer
      const getMappedRange = buffer.getMappedRange
      let captured = false
      // Three exposes sums of pass durations, which can overlap on tiled GPUs
      // Capture the same resolved queries to measure the first-to-last GPU
      // envelope, comparable to WebGL TIME_ELAPSED, while retaining pass sums
      buffer.getMappedRange = function (...args) {
        const range = getMappedRange.apply(this, args)
        const times = new BigUint64Array(range)
        for (const [uid, offset] of offsets) {
          const start = times[offset]
          const end = times[offset + 1]
          if (start == null || end == null || end < start)
            throw new Error('Invalid resolved GPU timestamp pair')
          first = first == null || start < first ? start : first
          last = last == null || end > last ? end : last
          result[type] += Number(end - start) / 1e6
          if (profile)
            result.passes.push({
              type,
              uid,
              names: [...(passNames.get(uid) ?? [])],
              scatteringSamples: passScattering.get(uid),
              startNs: String(start),
              endNs: String(end),
              ms: Number(end - start) / 1e6
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
      if (!captured) throw new Error('GPU timestamp readback was not captured')
    }
    result.envelope = first == null ? 0 : Number(last - first) / 1e6
    return result
  }
  if (timestampEnabled) await drain()
  // The probe's first call builds its device: keep that out of every sample
  // Warm-up frames are probed too, so the GPU sees the same load pattern
  const clockProbe = window.__clockProbe
  const probing = clockProbe ? (await clockProbe()) != null : false
  for (let frame = 0; frame < warmupFrames; frame++) {
    await nextFrame()
    render(frame)
    if (timestampEnabled) await drain()
    if (probing) await clockProbe()
  }
  await waitForGpu()

  const samples = {
    wallMs: [],
    renderMs: [],
    gpuMs: [],
    computeMs: [],
    gpuRenderMs: [],
    probeMs: []
  }
  let gpuReason = gl
    ? ext
      ? null
      : 'EXT_disjoint_timer_query_webgl2 unavailable'
    : timestampEnabled
      ? null
      : 'timestamp-query unavailable or disabled'
  const startFrame = clouds.frame
  for (let frame = 0; frame < sampleFrames; frame++) {
    await nextFrame()
    const query = ext ? gl.createQuery() : null
    if (ext && !query) throw new Error('Unable to allocate WebGL timer query')
    const start = performance.now()
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    render(warmupFrames + frame)
    if (query) gl.endQuery(ext.TIME_ELAPSED_EXT)
    samples.renderMs.push(performance.now() - start)
    await waitForGpu()
    samples.wallMs.push(performance.now() - start)
    if (query) {
      try {
        const deadline = performance.now() + 5000
        while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          if (performance.now() > deadline)
            throw new Error('WebGL timer query timed out')
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        if (gl.getParameter(ext.GPU_DISJOINT_EXT))
          gpuReason = 'GPU disjoint: whole sample batch rejected'
        else
          samples.gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6)
      } finally {
        gl.deleteQuery(query)
      }
    }
    if (timestampEnabled) {
      const timings = await drain()
      if (
        !(timings.render > 0) ||
        !(timings.compute >= 0) ||
        !(timings.envelope > 0)
      )
        throw new Error('Missing or invalid GPU timestamp sample')
      samples.gpuRenderMs.push(timings.render)
      samples.computeMs.push(timings.compute)
      samples.gpuMs.push(timings.envelope)
      if (profile) profileFrames.push(timings.passes)
    }
    if (probing) samples.probeMs.push(await clockProbe())
  }
  if (gl && ext && gl.getParameter(ext.GPU_DISJOINT_EXT))
    gpuReason = 'GPU disjoint: whole sample batch rejected'
  if (gpuReason) samples.gpuMs = []
  const endFrame = clouds.frame
  if (endFrame - startFrame !== sampleFrames)
    throw new Error(
      `Frame schedule did not advance: ${startFrame} -> ${endFrame}`
    )
  if (
    JSON.stringify(camera.position) !==
      JSON.stringify(handle.camera.position.toArray()) ||
    JSON.stringify(camera.quaternion) !==
      JSON.stringify(handle.camera.quaternion.toArray())
  )
    throw new Error('Camera moved during benchmark')
  const plate = await probe.readLinear(side)
  const pixels = plate.data
  if (!pixels?.length) throw new Error('No pixels read back')
  let sum = 0,
    square = 0,
    max = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
    if (!Number.isFinite(value)) throw new Error('Non-finite rendered pixel')
    sum += value
    square += value * value
    max = Math.max(max, value)
  }
  const count = pixels.length / 4
  const pixelStats = {
    count,
    mean: sum / count,
    variance: square / count - (sum / count) ** 2,
    max
  }
  if (!(max > 0) || !(pixelStats.variance > 1e-10))
    throw new Error('Blank rendered image')
  if (side === 'B') {
    const layer = await probe.readLayer()
    let cloudPixels = 0
    for (let i = 3; i < layer.data.length; i += 4)
      if (layer.data[i] > 0) cloudPixels++
    pixelStats.cloudPixels = cloudPixels
    if (!cloudPixels) throw new Error('No cloud pixels in selected workload')
  }
  return {
    ...(profile
      ? {
          profile: {
            effectiveScatteringSamples,
            integration,
            frames: profileFrames
          }
        }
      : {}),
    samples,
    gpuReason,
    environment: {
      errors: [...probe.errors],
      warnings: [...probe.warnings],
      frame: endFrame,
      startFrame,
      time: (warmupFrames + sampleFrames - 1) * dt,
      camera,
      effectiveSettings: effective,
      experimental: side === 'B' ? (clouds.experimental ?? null) : null,
      shapeVelocity: clouds.shapeVelocity.toArray(),
      shapeRepeat: clouds.shapeRepeat.toArray(),
      actualDimensions: { width: canvas.width, height: canvas.height },
      pixelStats,
      gpu,
      browser: navigator.userAgent,
      visibility: document.visibilityState,
      servedLibraryUrls: performance
        .getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(name =>
          /\/build\/(?:shared|index|webgpu)\.js(?:\?|$)/.test(name)
        )
    }
  }
}

export async function runBrowserJob(
  browser,
  {
    baseURL = 'http://localhost:4173',
    scene,
    variant,
    backend,
    warmupFrames,
    sampleFrames,
    timeout = 120000,
    screenshotPath,
    profile
  }
) {
  if (!['webgl', 'webgpu'].includes(backend)) throw new Error('Invalid backend')
  if (profile != null) validateProfileOptions(profile, backend)
  if (scene.dpr != null && scene.dpr !== 1)
    throw new Error('Use physical pixels with DPR=1')
  if (backend === 'webgl' && Object.values(variant.experimental).some(Boolean))
    throw new BenchmarkUnsupportedError(
      'WebGL does not implement port experiments'
    )
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: 1
  })
  const errors = []
  await context.addInitScript(recordDevices)
  // One ALU probe after every frame, outside the measured window
  await context.addInitScript(installClockProbe)
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/favicon.ico'))
      return route.fulfill({ status: 204, body: '' })
    if (url.pathname.endsWith('/stars.bin'))
      return route.fulfill({
        path: join(
          parityRoot,
          'node_modules/@takram/three-atmosphere/assets/stars.bin'
        )
      })
    if (url.pathname.endsWith('/stbn.bin'))
      return route.fulfill({
        path: join(root, 'test/fixtures/experimental/stbn.bin')
      })
    if (
      url.origin === new URL(baseURL).origin ||
      ['data:', 'blob:'].includes(url.protocol)
    )
      return route.continue()
    errors.push(`Unexpected network request: ${url.origin}${url.pathname}`)
    return route.abort()
  })
  const page = await context.newPage()
  let measurementTimer
  page.setDefaultTimeout(timeout)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    const url = new URL(benchmarkUrl(baseURL, scene))
    if (profile?.atmosphereMode)
      url.searchParams.set('atmosphereProfile', profile.atmosphereMode)
    // A sample-count override is a raymarch arm. The harness reads the LUT by
    // default (ADR-013 A6) and the method is fixed at build, so the raymarch
    // profile is chosen at load. The counts are a uniform, set after boot
    else if (profile?.scatteringSamples)
      url.searchParams.set('atmosphereProfile', 'raymarch-256')
    await page.goto(url.toString(), {
      waitUntil: 'load',
      timeout
    })
    await page.waitForFunction(() => window.__parity != null, null, { timeout })
    const screening = profile?.qualityScreen
      ? await page.evaluate(screenProfileQuality)
      : null
    const result = await Promise.race([
      page.evaluate(measureInPage, {
        backend,
        scene,
        variant,
        warmupFrames,
        sampleFrames,
        profile
      }),
      new Promise((_, reject) => {
        measurementTimer = setTimeout(
          () => reject(new Error('Benchmark measurement timed out')),
          timeout
        )
      })
    ])
    clearTimeout(measurementTimer)
    result.environment.errors.push(...errors)
    if (screenshotPath) await page.screenshot({ path: screenshotPath })
    const metric = values => (values.length ? summarise(values) : null)
    return {
      ...result,
      ...(screening ? { screening } : {}),
      samples: {
        wallMs: summarise(result.samples.wallMs),
        renderMs: summarise(result.samples.renderMs),
        gpuMs: metric(result.samples.gpuMs),
        computeMs: metric(result.samples.computeMs),
        gpuRenderMs: metric(result.samples.gpuRenderMs),
        probeMs: metric(result.samples.probeMs.filter(v => v != null))
      }
    }
  } catch (error) {
    if (error.message.includes('UNSUPPORTED:'))
      throw new BenchmarkUnsupportedError(error.message)
    throw error
  } finally {
    clearTimeout(measurementTimer)
    await context.close()
  }
}
