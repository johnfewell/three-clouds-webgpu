import type { Fixture } from './fixtures.mjs'

export function makeSkyCache(
  fixture: Fixture,
  upper?: number[],
  lower?: number[],
  size?: number,
  steps?: number
): {
  size: number
  volumes: Uint16Array[]
  buildMilliseconds: number
  steps: number
  directions: number[][]
}
export function makePhaseWeights(
  width?: number,
  height?: number,
  integrationDirections?: number
): {
  width: number
  height: number
  tables: Uint16Array[]
  phase: readonly [number, number, number]
  integrationDirections: number
}
