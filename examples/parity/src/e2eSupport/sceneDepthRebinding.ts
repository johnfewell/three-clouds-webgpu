import { DataTexture, RedFormat } from 'three'
import { texture } from 'three/tsl'

import type { ParityProbe } from '../../e2e/parityProbe'

export async function measureSceneDepthRebinding(probe: ParityProbe) {
  const side = probe.sideBHandle
  if (side == null) throw new Error('Scene-depth probe requires side B')
  const pass = side.cloudsPass
  const original = pass.sceneDepth
  if (original == null)
    throw new Error('Scene-depth probe requires scene depth')
  const nearTexture = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat)
  const farTexture = new DataTexture(new Uint8Array([255]), 1, 1, RedFormat)
  nearTexture.needsUpdate = true
  farTexture.needsUpdate = true
  const near = texture(nearTexture)
  const far = texture(farTexture)
  const temporalUpscale = pass.cloudsContext.temporalUpscale
  pass.cloudsContext.temporalUpscale = false
  const inputs = [
    { label: 'original', depth: original },
    { label: 'far', depth: far },
    { label: 'near', depth: near },
    { label: 'far-again', depth: far },
    { label: 'null', depth: null },
    { label: 'near-from-null', depth: near },
    { label: 'original-again', depth: original }
  ]
  const measurements = []
  try {
    for (const { label, depth } of inputs) {
      pass.sceneDepth = depth
      await probe.renderOnce('B', {
        time: 10,
        frame: 0,
        warmup: 4,
        resetHistory: false
      })
      const pixels = await probe.readLayer()
      const count = pixels.width * pixels.height
      if (count === 0) throw new Error('Scene-depth probe read zero pixels')
      let opacity = 0
      for (let offset = 3; offset < pixels.data.length; offset += 4) {
        const alpha = pixels.data[offset]!
        if (!Number.isFinite(alpha)) {
          throw new Error(`Scene-depth probe read non-finite opacity: ${label}`)
        }
        opacity += alpha
      }
      measurements.push({ label, opacity: opacity / count, pixels: count })
    }
    return {
      measurements,
      stablePass: side.cloudsPass === pass,
      errors: [...probe.errors]
    }
  } finally {
    pass.sceneDepth = original
    pass.cloudsContext.temporalUpscale = temporalUpscale
    nearTexture.dispose()
    farTexture.dispose()
  }
}
