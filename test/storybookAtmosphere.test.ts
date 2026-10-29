// The WebGPU stories are compared side by side with the WebGL originals, so
// their atmosphere must precompute the same LUTs. The two takram packages
// disagree on groundAlbedo (0.1 vs 0.3), and the WebGPU default lit the
// Minimal Setup clear sky 1.10x brighter than the original (ADR-013 Amendment 1)
import { describe, expect, it } from 'vitest'

import { AtmosphereParameters } from '@takram/three-atmosphere'
import { AtmosphereParameters as AtmosphereParametersWebGPU } from '@takram/three-atmosphere/webgpu'

import { createAtmosphereContext } from '../examples/storybook/src/clouds/helpers/atmosphereContext'
import { log } from './helpers/log'

describe('storybook createAtmosphereContext', () => {
  it('precomputes with the WebGL original ground albedo', () => {
    const webgl = new AtmosphereParameters().groundAlbedo
    const webgpu = new AtmosphereParametersWebGPU().groundAlbedo
    const story = createAtmosphereContext().parameters.groundAlbedo
    log('storybook-ground-albedo', {
      webgl: [webgl.r, webgl.g, webgl.b].join(' '),
      webgpuDefault: webgpu.toArray().join(' '),
      story: story.toArray().join(' ')
    })
    expect(story.toArray()).toEqual([webgl.r, webgl.g, webgl.b])
  })

  it('still differs from the WebGPU package default', () => {
    // If upstream aligns the defaults this fails, and the pin can go
    const webgl = new AtmosphereParameters().groundAlbedo
    const webgpu = new AtmosphereParametersWebGPU().groundAlbedo
    expect(webgpu.toArray()).not.toEqual([webgl.r, webgl.g, webgl.b])
  })
})
