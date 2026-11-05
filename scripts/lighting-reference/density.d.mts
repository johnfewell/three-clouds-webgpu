import type { CloudAssets } from './assets.mjs'
import type { CloudLayerParams } from './scene.mjs'

export interface DensitySample {
  readonly densitySum: number
  readonly scattering: number
  readonly extinction: number
  readonly densities: number[]
}

export interface DensityEvaluator {
  densityAt(position: readonly number[], mipLevel?: number): DensitySample
  extinctionAt(position: readonly number[], mipLevel?: number): number
}

export declare function cubeSphereUv(
  x: number,
  y: number,
  z: number
): [number, number]
export declare function createDensityEvaluator(
  assets: CloudAssets,
  scene?: Record<string, unknown>,
  layers?: readonly CloudLayerParams[]
): DensityEvaluator
export declare function detailFadeStrength(mipLevel: number): number
export declare function mipLevelForDistance(distance: number): number
