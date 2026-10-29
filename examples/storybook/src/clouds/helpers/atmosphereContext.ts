import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

// Set up like the WebGL original: accurateShadowScattering off (one shifted
// lookup, runtime.glsl:189-210, same frame, -1.0 ms), and the scattering LUT
// not the raymarch (ADR-013 Amendment 6: 6.62 vs 8.75 ms)
export function createAtmosphereContext(): AtmosphereContext {
  const context = new AtmosphereContext()
  context.accurateShadowScattering = false
  context.raymarchScattering = false
  // The WebGL package's ground albedo, 0.1 against WebGPU's 0.3. It feeds the
  // LUT precompute, and 0.3 lit the clear sky 1.10x (ADR-013 Amendment 1)
  context.parameters.groundAlbedo.setScalar(0.1)
  return context
}
