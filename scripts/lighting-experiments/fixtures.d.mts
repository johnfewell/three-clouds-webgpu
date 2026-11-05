import type { PathTraceOptions } from '../lighting-reference/medium.mjs'

export interface Fixture {
  shape: string
  thickness: number
  size: number
  data: Uint16Array
  nonzero: number
  minimum: readonly number[]
  maximum: readonly number[]
  hash: string
}
export const MANIFEST: {
  phase: readonly [number, number, number]
  minimum: readonly number[]
  maximum: readonly number[]
  bottomRadius: number
  volumeSize: number
  shapes: readonly string[]
}
export function makeFixture(
  shape?: string,
  thickness?: number,
  size?: number
): Fixture
export function boxInterval(
  origin: readonly number[],
  direction: readonly number[],
  minimum: readonly number[],
  maximum: readonly number[]
): number[] | null
export function voxelMedium(
  fixture: Fixture,
  scattering?: number,
  absorption?: number
): PathTraceOptions['medium'] & {
  density(point: readonly number[]): number
  majorant: number
  sampleCollision: NonNullable<PathTraceOptions['medium']['sampleCollision']>
  transmittance: NonNullable<PathTraceOptions['medium']['transmittance']>
}
