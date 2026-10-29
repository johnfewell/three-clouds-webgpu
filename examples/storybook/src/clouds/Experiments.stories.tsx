import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as BasicStory } from './Clouds-Basic'
import { Story as CustomLayersStory } from './Clouds-CustomLayers'
import { weatherArgs, weatherArgTypes } from './WeatherVariety'

export default {
  title: 'clouds-webgpu/Experiments'
} satisfies Meta

// Use the existing authored scenes and their original camera placements
// Only the experiment and explicitly listed rendering conditions differ
const basicPose = {
  longitude: 30,
  latitude: 35,
  height: 300,
  heading: 0,
  pitch: -5,
  distance: 1000
}
const customPose = { ...basicPose, height: 500 }
// Two regions is about 200 km, which one frame can show as a boundary. Eight
// puts six across a horizon view and the frame averages every vocabulary
const regionalPose = {
  ...basicPose,
  height: 16000,
  distance: 140000,
  pitch: -6
}
const regionalArgs = { cloudTypeRegions: 2 }
// High enough to look down on the deck, so the regions are patches on a map
// rather than a gradient along a horizon
const fromAbovePose = {
  ...basicPose,
  height: 60000,
  distance: 40000,
  pitch: -35
}

export const CloudFrontRefinement = createStory(CustomLayersStory, {
  props: customPose,
  args: { 'experimental-cloudFrontRefinement': true }
})

export const ComputeResolve = createStory(BasicStory, {
  props: basicPose,
  args: { 'experimental-computeResolve': true }
})

export const WindReprojection = createStory(CustomLayersStory, {
  props: customPose,
  args: {
    'experimental-windReprojection': true,
    animate: true,
    cloudMotion: 'shape'
  }
})

export const DistantCloudShadows = createStory(BasicStory, {
  props: basicPose,
  args: {
    'experimental-distantCloudShadows': true,
    'clouds-maxIterationCountToSun': 0
  }
})

export const DirectionalSkylight = createStory(CustomLayersStory, {
  props: customPose,
  args: { 'experimental-directionalSkylight': true }
})

// One sky holding more than one cloud type: the map's regions drive the
// density parameters, so the frame shows cumulus beside stratiform
export const CloudTypeMap = createStory(CustomLayersStory, {
  props: regionalPose,
  args: { 'experimental-cloudTypeMap': true, ...regionalArgs }
})

// The off state of the same scene, for the side-by-side stills
export const CloudTypeMapBaseline = createStory(CustomLayersStory, {
  props: regionalPose,
  args: { experimentMode: 'baseline', ...regionalArgs }
})

// The same two from above the deck, where a region is a patch rather than a
// gradient
export const CloudTypeMapFromAbove = createStory(CustomLayersStory, {
  props: fromAbovePose,
  args: { 'experimental-cloudTypeMap': true, ...regionalArgs }
})

export const CloudTypeMapFromAboveBaseline = createStory(CustomLayersStory, {
  props: fromAbovePose,
  args: { experimentMode: 'baseline', ...regionalArgs }
})

// Seeded weather in place of the baked map. Baseline is the baked map, so the
// two stills differ only in the opt-in
export const ProceduralWeather = createStory(BasicStory, {
  props: basicPose,
  args: {
    ...weatherArgs(),
    'experimental-proceduralWeather': true
  },
  argTypes: weatherArgTypes()
})

// The four shape knobs. Each story is the same scene with one magnitude up and
// every other at the library's neutral, so the pair beside it is the reference
const shapePose = { ...customPose, pitch: -2 }
const bankShape = { horizonCoverage: 0.35 }

export const HorizonCoverageBank = createStory(CustomLayersStory, {
  props: shapePose,
  args: { ...bankShape }
})

export const HorizonCoverageBankBaseline = createStory(CustomLayersStory, {
  props: shapePose,
  args: { experimentMode: 'baseline' }
})

export const DarkerCloudBases = createStory(CustomLayersStory, {
  props: { ...shapePose, distance: 3000 },
  args: { baseShadow: 1.6 }
})

export const DarkerCloudBasesBaseline = createStory(CustomLayersStory, {
  props: { ...shapePose, distance: 3000 },
  args: { experimentMode: 'baseline' }
})

// Leaning tops read best from a low sun, where the shear has a shadow to move
export const WindSkew = createStory(CustomLayersStory, {
  props: shapePose,
  args: { windSkewEast: 320, windSkewNorth: -120 }
})

export const WindSkewBaseline = createStory(CustomLayersStory, {
  props: shapePose,
  args: { experimentMode: 'baseline' }
})

export const EdgeShape = createStory(CustomLayersStory, {
  props: { ...shapePose, distance: 3000 },
  args: { erosionShape: 1.2 }
})

export const EdgeShapeBaseline = createStory(CustomLayersStory, {
  props: { ...shapePose, distance: 3000 },
  args: { experimentMode: 'baseline' }
})

// Tilted up from the Basic pose so the frame is mostly sky: the deck sits at
// 10 km, behind the cumulus, and the stills compare it against the same sky
// without it. The year is pinned so the sun is the same on every run
const cirrusPose = { ...basicPose, pitch: 28 }
const noon = { dayOfYear: 172, timeOfDay: 12, year: 2026 }
const lowSun = { dayOfYear: 172, timeOfDay: 18.9, year: 2026 }

export const CirrusDeck = createStory(BasicStory, {
  props: cirrusPose,
  args: { 'experimental-cirrusDeck': true, ...noon }
})

export const CirrusDeckOff = createStory(BasicStory, {
  props: cirrusPose,
  args: { 'experimental-cirrusDeck': false, ...noon }
})

export const CirrusDeckLowSun = createStory(BasicStory, {
  props: cirrusPose,
  args: { 'experimental-cirrusDeck': true, ...lowSun }
})

export const CirrusDeckLowSunOff = createStory(BasicStory, {
  props: cirrusPose,
  args: { 'experimental-cirrusDeck': false, ...lowSun }
})
