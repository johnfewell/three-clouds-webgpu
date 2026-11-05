export interface CloudLayerParams {
  readonly channel: 'r' | 'g' | 'b' | 'a'
  readonly altitude: number
  readonly height: number
  readonly densityScale: number
  readonly shapeAmount: number
  readonly shapeDetailAmount: number
  readonly weatherExponent: number
  readonly shapeAlteringBias: number
  readonly coverageFilterWidth: number
  readonly densityProfile: {
    readonly expTerm: number
    readonly exponent: number
    readonly linearTerm: number
    readonly constantTerm: number
  }
}

export declare const LAYERS: readonly CloudLayerParams[]
export declare const SCENE: {
  readonly bottomRadius: number
  readonly coverage: number
  readonly scatteringCoefficient: number
  readonly absorptionCoefficient: number
  readonly skyLightScale: number
  readonly groundBounceScale: number
  readonly powderScale: number
  readonly powderExponent: number
  readonly scatterAnisotropy1: number
  readonly scatterAnisotropy2: number
  readonly scatterAnisotropyMix: number
  readonly localWeatherRepeat: readonly [number, number]
  readonly localWeatherOffset: readonly [number, number]
  readonly shapeRepeat: readonly [number, number, number]
  readonly shapeOffset: readonly [number, number, number]
  readonly shapeDetailRepeat: readonly [number, number, number]
  readonly shapeDetailOffset: readonly [number, number, number]
  readonly shapeDetail: boolean
  readonly turbulence: boolean
  readonly minStepSize: number
  readonly maxStepSize: number
  readonly maxIterationCount: number
  readonly maxIterationCountToSun: number
  readonly minDensity: number
  readonly minExtinction: number
  readonly multiScatteringOctaves: number
}
