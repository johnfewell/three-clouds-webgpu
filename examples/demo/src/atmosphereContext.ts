import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

// Use the precomputed scattering LUT and WebGL-matched 0.1 ground albedo
export function createAtmosphereContext(): AtmosphereContext {
  const context = new AtmosphereContext()
  context.accurateShadowScattering = false
  context.raymarchScattering = false
  context.parameters.groundAlbedo.setScalar(0.1)
  return context
}
