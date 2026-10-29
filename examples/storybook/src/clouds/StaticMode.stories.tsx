import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as StaticModeStory } from './Clouds-StaticMode'
import {
  staticModeArgs,
  staticModeArgTypes
} from './controls/staticModeControls'

export default {
  title: 'clouds-webgpu/Static Mode'
} satisfies Meta

const staticPose = {
  longitude: 30,
  latitude: 35,
  height: 2500,
  heading: 0,
  pitch: -3,
  distance: 25000
}

// 1. Static mode active: GPU idles when camera and weather are still
export const StaticMode = createStory(StaticModeStory, {
  props: staticPose,
  args: {
    ...staticModeArgs(),
    'experimental-staticMode': true,
    simulateMotion: false
  },
  argTypes: staticModeArgTypes()
})

// 2. Static mode disabled: continuous baseline rendering
export const StaticModeDisabled = createStory(StaticModeStory, {
  props: staticPose,
  args: {
    ...staticModeArgs(),
    'experimental-staticMode': false,
    simulateMotion: false
  },
  argTypes: staticModeArgTypes()
})

// 3. Simulated cloud drift: inputs change every frame, resuming full rendering
export const StaticModeMoving = createStory(StaticModeStory, {
  props: staticPose,
  args: {
    ...staticModeArgs(),
    'experimental-staticMode': true,
    simulateMotion: true
  },
  argTypes: staticModeArgTypes()
})
