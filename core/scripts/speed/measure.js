// The measurement loop both bench pages run. `frame(i)` encodes and submits
// one frame and returns. Warm-up and the first frames are never sampled
const rAF = () => new Promise(resolve => requestAnimationFrame(resolve))
const median = v => {
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// GPU and CPU per frame: each frame waits for its GPU work, then the pass
// timestamps are read and the clock probe runs (all outside the CPU window)
export async function timedFrames({ device, frame, warmup, samples }) {
  const instrument = window.__speedInstrument
  for (let i = 0; i < warmup; i++) {
    await rAF()
    frame(i)
    await device.queue.onSubmittedWorkDone()
    await window.__clockProbe?.()
  }
  const out = {
    cpuMs: [],
    acquireMs: [],
    submitMs: [],
    gpuMs: [],
    passes: [],
    passList: [],
    probeMs: []
  }
  for (let i = 0; i < samples; i++) {
    await rAF()
    instrument.acquireMs = 0
    instrument.submitMs = 0
    instrument.timing = true
    const t0 = performance.now()
    frame(warmup + i)
    out.cpuMs.push(performance.now() - t0)
    instrument.timing = false
    out.acquireMs.push(instrument.acquireMs)
    out.submitMs.push(instrument.submitMs)
    await device.queue.onSubmittedWorkDone()
    const gpu = await instrument.collect(device)
    if (gpu == null) throw new Error('no pass timestamps in a sampled frame')
    out.gpuMs.push(gpu.ms)
    out.passes.push(gpu.passes)
    out.passList.push(gpu.list)
    out.probeMs.push(await window.__clockProbe?.())
  }
  return out
}

// An app loop with the display's own vsync: rAF drives it, at most two frames
// in flight, and a dropped frame is an interval with no new frame. Chrome
// presents at the display rate even with its frame-rate limit disabled
export async function vsyncLoop({ device, frame, warmup, seconds, start }) {
  await firstFrames(device, frame, warmup)
  const refreshMs = await displayRefreshMs()
  const inFlight = []
  const intervals = []
  let i = start + warmup
  let last = performance.now()
  const t0 = last
  const end = t0 + seconds * 1000
  while (performance.now() < end) {
    await rAF()
    const now = performance.now()
    intervals.push(now - last)
    last = now
    if (inFlight.length >= 2) await inFlight.shift()
    frame(i++)
    inFlight.push(device.queue.onSubmittedWorkDone())
  }
  await Promise.all(inFlight)
  const elapsed = performance.now() - t0
  const frames = i - start - warmup
  const dropped = intervals.filter(d => d > refreshMs * 1.5).length
  return {
    refreshMs,
    displayHz: 1000 / refreshMs,
    frames,
    intervals: intervals.length,
    fps: frames / (elapsed / 1000),
    dropped,
    droppedShare: intervals.length ? dropped / intervals.length : 0,
    longestMs: intervals.length ? Math.max(...intervals) : 0
  }
}

// The display's refresh: the shortest rAF interval over a short idle window of
// 30 frames, which is the vsync period on a display that is not dropping
export async function displayRefreshMs() {
  const samples = []
  let last = performance.now()
  for (let k = 0; k < 30; k++) {
    await rAF()
    const now = performance.now()
    samples.push(now - last)
    last = now
  }
  return Math.min(...samples)
}

// Startup marks: page script start, then each of the first frames done
// (three spreads LUT and pipeline builds over its first frames, the core does
// them in init), every frame in its own requestAnimationFrame
export const marks = { script: performance.now(), framesDone: [] }
export async function firstFrames(device, frame, n) {
  for (let i = 0; i < n; i++) {
    if (i > 0) await rAF()
    const t0 = performance.now()
    frame(i)
    if (i === 0) marks.firstFrameCpuMs = performance.now() - t0
    await device.queue.onSubmittedWorkDone()
    marks.framesDone.push(performance.now())
  }
}
