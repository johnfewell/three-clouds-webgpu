// The harness atmosphere profiles (examples/parity/src/atmosphereProfile.ts,
// ADR-013 Amendment 6). 'reference' is the LUT lookup; the RAYMARCH modes are
// the opt-in pin and the per-consumer sample ablations. benchmarkProfile.test.ts
// checks both lists against atmosphereProfile.ts
export const ATMOSPHERE_MODES = [
  'reference',
  'raymarch-256',
  'samples-scene-64',
  'samples-clouds-64',
  'lookup-both'
]
export const RAYMARCH_MODES = [
  'raymarch-256',
  'samples-scene-64',
  'samples-clouds-64'
]

// Diagnostic ablations are not visual-parity-qualified benchmark variants
export function validateProfileOptions(profile, backend) {
  if (backend !== 'webgpu') throw new Error('Profiling requires WebGPU')
  if (
    profile.atmosphereMode != null &&
    !ATMOSPHERE_MODES.includes(profile.atmosphereMode)
  )
    throw new Error('Unknown atmosphere profile mode')
  const samples = profile.scatteringSamples
  if (samples != null && (profile.qualityScreen || profile.atmosphereMode))
    throw new Error(
      'Sample overrides cannot be combined with atmosphere modes or quality screening'
    )
  if (
    samples != null &&
    (!Array.isArray(samples) ||
      samples.length !== 2 ||
      samples.some(
        value => !Number.isInteger(value) || value < 1 || value > 512
      ) ||
      samples[0] > samples[1])
  )
    throw new Error('scatteringSamples must be [min, max] integers in 1..512')
}

// A screening still, not an acceptance capture: no shadow/sequence receipts
// Run before timing, while both renderer handles are still available
export async function screenProfileQuality() {
  const p = window.__parity
  const metrics = await import('/src/metrics/index.ts')
  for (const side of ['A', 'B'])
    await p.renderOnce(side, { time: 0, frame: 0, warmup: 64 })
  await p.readLinear('B')
  await p.renderOnce('B', { time: 0, frame: 0, warmup: 4, resetHistory: false })
  const a = await p.readLinear('A')
  const b = await p.readLinear('B')
  if (
    !a.data.length ||
    a.data.length !== b.data.length ||
    a.width !== b.width ||
    a.height !== b.height
  )
    throw new Error('Invalid screening readback dimensions')
  const de = metrics.computeDeltaE(a.data, b.data, a.width, a.height, 4)
  const plate = {
    A: metrics.computePlateStats(a.data, 4),
    B: metrics.computePlateStats(b.data, 4)
  }
  const layer = await p.readLayer()
  plate.B.cloudFraction = metrics.computeCloudFraction(layer.data, 4)
  const result = {
    kind: 'static-quality-screen-only',
    width: a.width,
    height: a.height,
    ssim: metrics.computeSSIM(a.data, b.data, a.width, a.height, 4),
    deMean: de.deMean,
    deP95: de.deP95,
    histDist: metrics.computeHistogramDistance(
      a.data,
      b.data,
      a.width,
      a.height,
      4
    ),
    plate
  }
  for (const key of ['ssim', 'deMean', 'deP95', 'histDist'])
    if (!Number.isFinite(result[key]))
      throw new Error(`Invalid screening metric: ${key}`)
  return result
}

export function validateAtmosphereReceipt(profile, mode) {
  if (!profile.frames.length) throw new Error('Empty atmosphere receipt')
  const raymarch = RAYMARCH_MODES.includes(mode)
  if (
    profile.integration?.cloudsRaymarch !== raymarch ||
    profile.integration?.sceneRaymarch !== raymarch
  )
    throw new Error('Atmosphere integration override did not apply')
  // A lookup reads no sample count, so only the raymarch modes are checked
  if (!raymarch) return
  const target =
    mode === 'samples-scene-64'
      ? 'RenderPipeline'
      : mode === 'samples-clouds-64'
        ? 'CloudsPass'
        : null
  for (const frame of profile.frames)
    for (const name of ['CloudsPass', 'RenderPipeline']) {
      const passes = frame.filter(pass => pass.names.includes(name))
      const count = name === target ? 64 : 256
      if (
        !passes.length ||
        passes.some(
          pass => String(pass.scatteringSamples) !== String([count, count])
        )
      )
        throw new Error(`Atmosphere per-pass override did not apply: ${name}`)
    }
}

export function summarisePasses(frames) {
  if (!frames.length) throw new Error('Cannot profile zero frames')
  const groups = new Map()
  for (const frame of frames) {
    if (!frame.length) throw new Error('Cannot profile zero passes')
    const perFrame = new Map()
    for (const pass of frame) {
      if (!pass.names.length && pass.type === 'render')
        throw new Error(`Unlabelled render pass: ${pass.uid}`)
      if (!Number.isFinite(pass.ms) || pass.ms < 0)
        throw new Error('Invalid pass duration')
      const key = `${pass.type}:${[...pass.names].sort().join('+') || 'compute'}`
      perFrame.set(key, (perFrame.get(key) ?? 0) + pass.ms)
    }
    for (const [key, ms] of perFrame) {
      const values = groups.get(key) ?? []
      values.push(ms)
      groups.set(key, values)
    }
  }
  return Object.fromEntries(
    [...groups].map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return [
        key,
        {
          framesPresent: values.length,
          medianMs:
            (sorted[Math.floor((sorted.length - 1) / 2)] +
              sorted[Math.floor(sorted.length / 2)]) /
            2,
          values
        }
      ]
    })
  )
}
