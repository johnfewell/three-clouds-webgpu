import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import {
  Story as CloudTypesStory,
  type CloudTypeArg
} from './Clouds-CloudTypes'

import CloudTypesCode from './Clouds-CloudTypes?raw'

export default {
  title: 'clouds-webgpu/CloudTypes',
  parameters: {
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      }
    }
  }
} satisfies Meta

// One story per named cloud type, at the pose the rest of the clouds stories
// use (30°E, 35°N, 300 m), so the six stills differ only in the sky
const props = {
  longitude: 30,
  latitude: 35,
  height: 300,
  heading: 0,
  pitch: -5,
  distance: 1000
}

const preset = (cloudType: CloudTypeArg, pose: Partial<typeof props> = {}) =>
  createStory(CloudTypesStory, {
    props: { ...props, ...pose },
    args: { cloudType },
    parameters: { docs: { source: { code: CloudTypesCode } } }
  })

// The presets off, so every 'on' still has its 'off' twin on the next page
export const Off = preset('off')

export const FairWeatherCumulus = preset('fairWeatherCumulus')
export const StratocumulusDeck = preset('stratocumulusDeck')

export const OvercastSheet = preset('overcastSheet')

export const HighCirrus = preset('highCirrus')

// Fog is a 600 m bank, so the camera at 260 m sits inside it and reads the
// billows receding, where from 2 m it is a whiteout with no structure to read
export const GroundFog = preset('groundFog', { height: 260, pitch: -9 })

export const MixedSky = preset('mixedSky')

// The selector itself, so the six presets can be compared by clicking rather
// than by six separate pages
export const Selector = createStory(CloudTypesStory, {
  props
})
