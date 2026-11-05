// The controlled scene every arm of the lighting experiment shares: one
// definition of the density, the coefficients, the phase, the sun, the camera
// and the resolution
//
// Cite: src/CloudLayers.ts (the default layer set)

/** The four layer slots, the three the library ships plus the empty fourth */
export const LAYERS = [
  {
    channel: 'r',
    altitude: 750,
    height: 650,
    densityScale: 0.2,
    shapeAmount: 1,
    shapeDetailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    densityProfile: {
      expTerm: 0,
      exponent: 0,
      linearTerm: 0.75,
      constantTerm: 0.25
    }
  },
  {
    channel: 'g',
    altitude: 1000,
    height: 1200,
    densityScale: 0.2,
    shapeAmount: 1,
    shapeDetailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    densityProfile: {
      expTerm: 0,
      exponent: 0,
      linearTerm: 0.75,
      constantTerm: 0.25
    }
  },
  {
    channel: 'b',
    altitude: 7500,
    height: 500,
    densityScale: 0.003,
    shapeAmount: 0.4,
    shapeDetailAmount: 0,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.5,
    densityProfile: {
      expTerm: 0,
      exponent: 0,
      linearTerm: 0.75,
      constantTerm: 0.25
    }
  },
  {
    channel: 'a',
    altitude: 0,
    height: 0,
    densityScale: 0.2,
    shapeAmount: 1,
    shapeDetailAmount: 1,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.6,
    densityProfile: {
      expTerm: 0,
      exponent: 0,
      linearTerm: 0.75,
      constantTerm: 0.25
    }
  }
]

/**
 * The scene state, in the units the port uses: metres for length, 1/metre
 * for the extinction coefficients
 */
export const SCENE = {
  bottomRadius: 6360000,
  coverage: 0.3,
  scatteringCoefficient: 1,
  absorptionCoefficient: 0,
  // The sky term, the ground bounce and the powder darkening are all off, so
  // the sun is the only light source in every arm and the multiple-scattering
  // problem is single-sourced
  skyLightScale: 0,
  groundBounceScale: 0,
  powderScale: 0,
  powderExponent: 150,
  // The phase function the port compiles in
  scatterAnisotropy1: 0.7,
  scatterAnisotropy2: -0.2,
  scatterAnisotropyMix: 0.5,
  // Texture placement
  localWeatherRepeat: [100, 100],
  localWeatherOffset: [0, 0],
  shapeRepeat: [0.0003, 0.0003, 0.0003],
  shapeOffset: [0, 0, 0],
  shapeDetailRepeat: [0.006, 0.006, 0.006],
  shapeDetailOffset: [0, 0, 0],
  // The march's own knobs, so the GPU arm and the CPU twin agree
  shapeDetail: false,
  turbulence: false,
  minStepSize: 50,
  maxStepSize: 1000,
  maxIterationCount: 500,
  maxIterationCountToSun: 2,
  minDensity: 1e-5,
  minExtinction: 1e-5,
  multiScatteringOctaves: 8
}
