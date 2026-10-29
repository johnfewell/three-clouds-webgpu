// The runtime proof page: runs core/src/runtime on a description with every
// uniform computed by RuntimeSession from setup.json, then compares named
// textures byte for byte with the oracle. Driven by prove-runtime.mjs
import { snapshot } from './snapshot.js'

const json = async url => (await fetch(url)).json()
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

// unpadded rows only: the padding past w * bpt is not texture data
function compareBytes(meta, a, b) {
  let differing = 0
  let first = -1
  let maxDiff = 0
  const row = meta.w * meta.bpt
  for (let z = 0; z < meta.d; z++)
    for (let y = 0; y < meta.h; y++) {
      const o = (z * meta.h + y) * meta.bpr
      for (let x = 0; x < row; x++)
        if (a[o + x] !== b[o + x]) {
          differing++
          if (first < 0) first = o + x
          maxDiff = Math.max(maxDiff, Math.abs(a[o + x] - b[o + x]))
        }
    }
  return { differing, first, maxDiff, of: meta.w * meta.h * meta.d * meta.bpt }
}

// The unpadded texel bytes' SHA-256, so a report names exactly what it saw
async function texelSha(meta, bytes) {
  const row = meta.w * meta.bpt
  const packed = new Uint8Array(row * meta.h * meta.d)
  for (let i = 0; i < meta.h * meta.d; i++)
    packed.set(bytes.subarray(i * meta.bpr, i * meta.bpr + row), i * row)
  const digest = await crypto.subtle.digest('SHA-256', packed)
  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

// Bytes for buffers the core does not compute: geometry, the star catalogue
// and the app's own scene object. Never a buffer with a field map otherwise
function staticBuffers(d, state, appBuffers) {
  const out = {}
  const initial = { ...state.initial.init, ...state.initial.frames }
  for (const [name, b] of Object.entries(d.buffers)) {
    if ((b.fields?.length ?? 0) > 0 && !appBuffers.includes(name)) continue
    if (initial[name] == null) throw new Error(`no bytes for ${name}`)
    out[name] = b64(initial[name])
  }
  return out
}

// 'resizeFrom' builds from another size's description, then resizes to ours
let descriptionDir = 'generated'

async function run(R, device, base, plan, edit) {
  const description = await json(`${base}/${descriptionDir}/description.json`)
  const state = await json(`${base}/generated/state.json`)
  const setup = await json(`${base}/generated/setup.json`)
  edit?.(setup)
  const session = new R.RuntimeSession(setup)
  // the oracle's protocol: build and settle, reset, then frames from reset
  for (let k = 0; k < 4; k++) {
    session.update()
    session.afterRender()
  }
  session.resetHistory()
  const statics = staticBuffers(description, state, ['ground.object'])
  const runtime = R.createRuntime({
    device,
    description,
    staticBuffers: statics,
    upload: R.browserUpload(
      device.queue,
      description.textures,
      `${base}/assets`
    )
  })
  if (descriptionDir !== 'generated')
    runtime.resize(setup.size.width, setup.size.height)
  for (let k = 0; k < plan.length; k++) {
    // the harness's frame for this step: pinned, or counting through the
    // Bayer cells for a temporal case (warmupFramePlan)
    session.inputs.frame = plan[k]
    const sources = session.update()
    if (k === 0) await runtime.init(sources)
    runtime.frame(k, sources)
    session.afterRender()
  }
  runtime.linear(session.sources)
  return { runtime, session, statics: Object.keys(statics) }
}

// A fault the exit test injects into the compared run, which must then fail
const FAULTS = {
  sun: setup => {
    setup.inputs.sunDirection.x += 1e-4
    setup.atmosphere.sunDirectionECEF.x += 1e-4
  }
}

window.__runtimeProve = async ({
  base,
  runtimeUrl,
  plan: oraclePlan,
  compare,
  resizeFrom,
  fault = null
}) => {
  // One frame past the oracle's
  const plan =
    fault === 'frame' ? [...oraclePlan, oraclePlan.at(-1) + 1] : oraclePlan
  descriptionDir = resizeFrom ? 'resizeFrom' : 'generated'
  const R = await import(runtimeUrl)
  const adapter = await navigator.gpu.requestAdapter()
  const description = await json(`${base}/generated/description.json`)
  const wanted = description.device.requiredFeatures.filter(f =>
    adapter.features.has(f)
  )
  const device = await adapter.requestDevice({ requiredFeatures: wanted })
  const errors = []
  device.addEventListener('uncapturederror', e => errors.push(e.error.message))

  const { runtime, session, statics } = await run(
    R,
    device,
    base,
    plan,
    FAULTS[fault]
  )
  const results = {}
  const mine = {}
  for (const { name, file, meta } of compare) {
    const ours = await snapshot(device, runtime.textures[name])
    if (ours.skipped != null) {
      results[name] = { skipped: ours.skipped }
      continue
    }
    mine[name] = ours
    const theirs = new Uint8Array(
      await (await fetch(`${base}/oracle/${file}`)).arrayBuffer()
    )
    if (ours.bpr !== meta.bpr || ours.h !== meta.h || ours.d !== meta.d)
      results[name] = { mismatchedShape: { ours, meta } }
    else
      results[name] = {
        ...compareBytes(meta, ours.bytes, theirs),
        oursSha256: await texelSha(ours, ours.bytes),
        oracleSha256: await texelSha(meta, theirs)
      }
  }

  // Positive controls: two more frames must move the output, and a CPU input
  // changed in setup.json must reach the march through the field map
  const controls = {}
  for (const k of [plan.length, plan.length + 1]) {
    session.inputs.frame = plan.at(-1) + k - plan.length + 1
    runtime.frame(k, session.update())
    session.afterRender()
  }
  runtime.linear(session.sources)
  const extra = await snapshot(device, runtime.textures.linear)
  controls['extraFrame:linear'] = compareBytes(
    extra,
    extra.bytes,
    mine.linear.bytes
  )
  const nudged = await run(R, device, base, plan, setup => {
    setup.inputs.coverage *= 1.01
  })
  for (const name of ['layer', 'linear']) {
    const s = await snapshot(device, nudged.runtime.textures[name])
    controls[`coverage+1%:${name}`] = compareBytes(s, s.bytes, mine[name].bytes)
  }
  // A sun nudged by 1e-4 in both the clouds' and the atmosphere's inputs
  const sunNudged = await run(R, device, base, plan, setup => {
    for (const v of [
      setup.inputs.sunDirection,
      setup.atmosphere.sunDirectionECEF
    ]) {
      v.x += 1e-4
    }
  })
  for (const name of ['layer', 'linear']) {
    const s = await snapshot(device, sunNudged.runtime.textures[name])
    controls[`sunNudge:${name}`] = compareBytes(s, s.bytes, mine[name].bytes)
  }
  await device.queue.onSubmittedWorkDone()
  return {
    errors,
    results,
    controls,
    features: wanted,
    statics,
    plan,
    resizeFrom,
    fault
  }
}
window.__runtimeReady = true
