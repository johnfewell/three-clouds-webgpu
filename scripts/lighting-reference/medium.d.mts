export interface PathTraceOptions {
  origin: readonly number[]
  direction: readonly number[]
  medium: {
    transmittance?(
      origin: readonly number[],
      direction: readonly number[],
      rng: () => number
    ): number
    sampleCollision?(
      origin: readonly number[],
      direction: readonly number[],
      rng: () => number
    ): { point: number[]; distance: number } | null
    extinctionAt(point: readonly number[], distance?: number): number
    densityAt(
      point: readonly number[],
      distance?: number
    ): { extinction: number; scattering: number }
    intervals(
      origin: readonly [number, number, number],
      direction: readonly [number, number, number]
    ): number[][]
  }
  sunDirection: readonly number[]
  scene: Record<string, unknown>
  samples: number
  seed: number
  maxBounces?: number
  maxDistance?: number
  skyRadiance?: (
    direction: readonly number[],
    origin: readonly number[]
  ) => readonly number[]
}

export declare function henyeyGreenstein(g: number, cosTheta: number): number
export declare function phaseFunction(
  cosTheta: number,
  attenuation: number,
  g1: number,
  g2: number,
  mix: number
): number
export declare function scenePhase(
  cosTheta: number,
  scene: Record<string, unknown>
): number
export declare function sampleHenyeyGreenstein(g: number, u: number): number
export declare function samplePhaseDirection(
  axis: readonly number[],
  scene: Record<string, unknown>,
  rng: () => number
): { direction: number[]; weight: number }
export declare function createRng(seed: number): () => number
export declare function hashSeed(text: string, index: number): number
export declare function rayShellIntervals(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  rInner: number,
  rOuter: number
): number[][]
export declare function bandRadii(
  bands: number[][],
  bottomRadius: number
): number[][]
export declare function sunTransmittance(
  position: readonly number[],
  sunDirection: readonly number[],
  medium: PathTraceOptions['medium'],
  scene: Record<string, unknown>,
  rng: () => number,
  distance?: number
): number
export declare function traceInScatteredRadiance(options: PathTraceOptions): {
  total: number
  single: number
  sky: number[]
  skySingle: number[]
  truncatedSamples: number
}
export declare function analyticHomogeneousSingleScatter(options: {
  sigmaS: number
  sigmaT: number
  height: number
  viewCos: number
  phaseAt: number
  sunIrradiance?: number
}): number
export declare function createHomogeneousMedium(options: {
  sigmaS: number
  sigmaT: number
  height: number
}): PathTraceOptions['medium']
