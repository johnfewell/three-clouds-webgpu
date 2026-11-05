export type Direction = readonly number[]
export function sphereDirections(count: number): number[][]
export function candidateDirections(): Record<'axes6' | 'corners8', number[][]>
export function integrateCellSky(
  directions: readonly Direction[],
  dense: readonly Direction[],
  view: Direction,
  phase: (cosine: number) => number,
  radiance: (direction: Direction) => number
): number
export function integrateUniformSky(
  directions: readonly Direction[],
  view: Direction,
  phase: (cosine: number) => number
): number
export function uniformSkyAudit(
  directions: readonly Direction[],
  views: readonly Direction[],
  phase: (cosine: number) => number,
  tolerance: number
): {
  directions: number
  views: number
  minimum: number
  maximum: number
  maximumError: number
  tolerance: number
  passed: boolean
}
