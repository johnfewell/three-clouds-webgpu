import type { NodeFrame } from 'three/webgpu'

import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'

// ADR-013 Amendment 6: side B reads the scattering LUT by default,
// as side A does ('reference', with 'lookup-both' kept as an alias)
// 'raymarch-256' restores the former harness pin, 'samples-*' raymarch too
export const atmosphereProfileModes = [
  'reference',
  'raymarch-256',
  'samples-scene-64',
  'samples-clouds-64',
  'lookup-both'
] as const

export type AtmosphereProfileMode = (typeof atmosphereProfileModes)[number]

/** Whether side B ray-marches the atmosphere in this profile */
export function profileRaymarches(mode: AtmosphereProfileMode): boolean {
  return mode !== 'reference' && mode !== 'lookup-both'
}

/**
 * The atmosphere profile side B actually runs (ADR-013 Amendment 6). An
 * explicit diagnostic profile on the URL wins, then a case's registered
 * exception (CaseDefinition.atmosphereException, reason stated there), then
 * the default LUT lookup.
 */
export function effectiveAtmosphereProfile(
  urlProfile: AtmosphereProfileMode,
  caseException?: { readonly mode: AtmosphereProfileMode }
): AtmosphereProfileMode {
  if (urlProfile !== 'reference') return urlProfile
  return caseException?.mode ?? 'reference'
}

export function parseAtmosphereProfile(
  value: string | null,
  diagnostic: boolean,
  capture: boolean
): AtmosphereProfileMode {
  if (value == null || value === 'reference') return 'reference'
  if (!diagnostic || capture)
    throw new Error('Atmosphere profiles require e2e=1 without capture=1')
  const mode = atmosphereProfileModes.find(mode => mode === value)
  if (mode == null) throw new Error(`Unknown atmosphere profile: ${value}`)
  return mode
}

export function configureAtmosphereProfile(
  atmosphere: AtmosphereContext,
  mode: AtmosphereProfileMode
): void {
  // Parity pin: side A resolves a shadowed view ray with the single Bruneton
  // branch, so side B takes it too. The library default (true) adds branches
  // that cost up to 4 combined-scattering lookups per shadowed pixel
  atmosphere.accurateShadowScattering = false
  atmosphere.raymarchScattering = profileRaymarches(mode)
  if (!profileRaymarches(mode)) return
  // The raymarch profiles converge B's Monte-Carlo inscatter onto the integral
  // side A's LUT stores; 256 was the first count at which coverage-020 passed
  // (ADR-013 Amendment 4). The library default stays (4, 14).
  atmosphere.scatteringSampleCount.value.set(256, 256)
  if (mode === 'raymarch-256') return
  // Update before each material's uniforms are uploaded. The profiling runner
  // verifies both consumers' actual counts at backend.draw, after this update
  const target = mode === 'samples-scene-64' ? 'RenderPipeline' : 'CloudsPass'
  atmosphere.scatteringSampleCount.onObjectUpdate((frame: NodeFrame) => {
    const count = frame.material?.name === target ? 64 : 256
    atmosphere.scatteringSampleCount.value.set(count, count)
  })
}
