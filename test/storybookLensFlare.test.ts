// The WebGPU stories are compared side by side with the WebGL originals, whose
// <LensFlare /> adds (bloom + ghosts) at 0.005 and has no glare stage. The
// WebGPU node's defaults bloom 10x brighter (0.05) and add 4-ray spikes, which
// made the port's sun glow 10x the original's in Minimal Setup
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { lensFlare } from '@takram/three-geospatial/webgpu'

import { matchWebGLLensFlare } from '../examples/storybook/src/clouds/helpers/lensFlare'
import { log } from './helpers/log'

// The root package does not depend on the WebGL effects, the storybook does
async function webglLensFlareDefaults(): Promise<{ intensity: number }> {
  const storybook = join(
    import.meta.dirname,
    '../examples/storybook/package.json'
  )
  const entry = createRequire(storybook).resolve(
    '@takram/three-geospatial-effects'
  )
  const effects = (await import(pathToFileURL(entry).href)) as {
    lensFlareEffectOptionsDefaults: { intensity: number }
  }
  return effects.lensFlareEffectOptionsDefaults
}

describe('storybook matchWebGLLensFlare', () => {
  it('blooms at the WebGL LensFlareEffect intensity, with no glare', async () => {
    const webgl = await webglLensFlareDefaults()
    const upstream = lensFlare(null)
    const defaults = {
      bloom: upstream.bloomIntensity.value,
      glare: upstream.glareNode.intensity.value
    }
    const node = matchWebGLLensFlare(lensFlare(null))
    log('storybook-lens-flare', {
      webglIntensity: webgl.intensity,
      webgpuBloomDefault: defaults.bloom,
      webgpuGlareDefault: defaults.glare,
      storyBloom: node.bloomIntensity.value,
      storyGlare: node.glareNode.intensity.value
    })
    expect(node.bloomIntensity.value).toBe(webgl.intensity)
    expect(node.glareNode.intensity.value).toBe(0)
  })

  it('still differs from the WebGPU node defaults', async () => {
    // If upstream aligns the defaults this fails, and the helper can go
    const webgl = await webglLensFlareDefaults()
    const upstream = lensFlare(null)
    expect(upstream.bloomIntensity.value).not.toBe(webgl.intensity)
    expect(upstream.glareNode.intensity.value).toBeGreaterThan(0)
  })
})
