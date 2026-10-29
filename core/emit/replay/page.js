// The replay page: runs a description for N frames from reset, then the linear
// readback, and compares named textures byte for byte with oracle snapshots
// Driven by core/scripts/prove.mjs, which serves this folder and the files

import { createReplay } from './replay.js'
import { snapshot } from './snapshot.js'

const json = async url => (await fetch(url)).json()

// unpadded rows only: the padding past w * bpt is not texture data
function compareBytes(meta, a, b) {
  let differing = 0
  let first = -1
  const row = meta.w * meta.bpt
  for (let z = 0; z < meta.d; z++)
    for (let y = 0; y < meta.h; y++) {
      const o = (z * meta.h + y) * meta.bpr
      for (let x = 0; x < row; x++)
        if (a[o + x] !== b[o + x]) {
          differing++
          if (first < 0) first = o + x
        }
    }
  return { differing, first, of: meta.w * meta.h * meta.d * meta.bpt }
}

async function run(device, base, frames, edit) {
  const description = await json(`${base}/generated/description.json`)
  const state = await json(`${base}/generated/state.json`)
  const replay = await createReplay(
    device,
    description,
    state,
    `${base}/assets`
  )
  edit?.(replay)
  for (let k = 0; k < frames; k++) await replay.frame(k)
  await replay.linear()
  return replay
}

window.__replayProve = async ({ base, frames, compare, coverage }) => {
  const adapter = await navigator.gpu.requestAdapter()
  const description = await json(`${base}/generated/description.json`)
  const wanted = description.device.requiredFeatures.filter(f =>
    adapter.features.has(f)
  )
  const device = await adapter.requestDevice({ requiredFeatures: wanted })
  const errors = []
  device.addEventListener('uncapturederror', e => errors.push(e.error.message))

  const replay = await run(device, base, frames)
  const results = {}
  const mine = {}
  for (const { name, file, meta } of compare) {
    const ours = await snapshot(device, replay.textures[name])
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
    else results[name] = compareBytes(meta, ours.bytes, theirs)
  }

  // Positive controls: the comparator must see more frames, and a uniform
  // written BY NAME through the field map must reach the march
  const controls = {}
  // two frames, so linear again follows the parity it reads
  await replay.frame(frames)
  await replay.frame(frames + 1)
  await replay.linear()
  const extra = await snapshot(device, replay.textures.linear)
  controls.extraFrame = compareBytes(extra, extra.bytes, mine.linear.bytes)
  const edited = await run(device, base, frames, r =>
    r.setField('CloudsPass.object', 'parameter_coverage', [coverage])
  )
  for (const name of ['layer', 'linear']) {
    const s = await snapshot(device, edited.textures[name])
    controls[`coverage:${name}`] = compareBytes(s, s.bytes, mine[name].bytes)
  }
  await device.queue.onSubmittedWorkDone()
  return { errors, results, controls, features: wanted }
}
window.__replayReady = true
