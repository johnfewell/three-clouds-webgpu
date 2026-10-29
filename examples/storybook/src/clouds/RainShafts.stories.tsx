import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as RainShaftsStory } from './Clouds-RainShafts'
import {
  rainShaftsArgs,
  rainShaftsArgTypes
} from './controls/rainShaftsControls'

export default {
  title: 'clouds-webgpu/Rain Shafts'
} satisfies Meta

// Camera with view of convective tower and space beneath cloud base
const rainPose = {
  longitude: 30,
  latitude: 35,
  height: 2000,
  heading: 0,
  pitch: 6,
  distance: 40000
}

// 1. Visible rain curtains hanging under convective cells
export const RainShafts = createStory(RainShaftsStory, {
  props: rainPose,
  args: {
    ...rainShaftsArgs(),
    'experimental-rainShafts': true,
    'experimental-convectiveProfile': true,
    rainShaftStrength: 0.9,
    rainShaftDensity: 2e-4,
    rainShaftSlant: 0.35,
    timeOfDay: 15.5
  },
  argTypes: rainShaftsArgTypes()
})

// 2. Baseline without rain shafts for comparison
export const RainShaftsOff = createStory(RainShaftsStory, {
  props: rainPose,
  args: {
    ...rainShaftsArgs(),
    'experimental-rainShafts': false,
    'experimental-convectiveProfile': true,
    timeOfDay: 15.5
  },
  argTypes: rainShaftsArgTypes()
})

// 3. Dense heavy precipitation curtain
export const HeavyDownpour = createStory(RainShaftsStory, {
  props: rainPose,
  args: {
    ...rainShaftsArgs(),
    'experimental-rainShafts': true,
    'experimental-convectiveProfile': true,
    rainShaftStrength: 1.5,
    rainShaftDensity: 3.5e-4,
    rainShaftSlant: 0.45,
    timeOfDay: 15.5
  },
  argTypes: rainShaftsArgTypes()
})
