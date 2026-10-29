// Only exposed in explicit e2e mode. Normal consumers keep the animated demo
export interface R3FSmokeProbe {
  frames: number
  cloudsEnabled: boolean
  // Filled by <Globe> under ?tiles=1: the renderer's own counters plus what
  // the loaded tile meshes carry, sampled every 30 frames
  tiles?: R3FTilesProbe
}

export interface R3FTilesProbe {
  sampledAtFrame: number
  errorTarget: number
  visible: number
  active: number
  inFrustum: number
  loaded: number
  inCache: number
  queued: number
  downloading: number
  parsing: number
  failed: number
  loadEnds: number
  loadErrors: number
  meshes: number
  withNormals: number
  basicMaterials: number
  otherMaterials: number
  transparentMaterials: number
}

export type R3FSmokeWindow = Window & { __r3fSmoke?: R3FSmokeProbe }

export const smokeProbe: R3FSmokeProbe | null = new URLSearchParams(
  location.search
).has('e2e')
  ? { frames: 0, cloudsEnabled: true }
  : null

if (smokeProbe != null) {
  ;(window as R3FSmokeWindow).__r3fSmoke = smokeProbe
}
