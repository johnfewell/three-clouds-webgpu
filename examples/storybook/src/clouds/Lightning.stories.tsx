import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as LightningStory } from './Clouds-Lightning'
import { lightningArgs, lightningArgTypes } from './controls/lightningControls'

export default {
  title: 'clouds-webgpu/Lightning'
} satisfies Meta

// Low sun behind storm clouds, looking slightly up at the dense cloud core
const stormPose = {
  longitude: 30,
  latitude: 35,
  height: 1200,
  heading: 0,
  pitch: 2,
  distance: 12000
}

// 1. Visible flash illuminating the cloud from within
export const LightningFlash = createStory(LightningStory, {
  props: stormPose,
  args: {
    ...lightningArgs(),
    'experimental-lightning': true,
    lightningFlash: true,
    flashIntensity: 3.5e9,
    animateFlashes: false
  },
  argTypes: lightningArgTypes()
})

// 2. Storm baseline with no flash lit, showing the dark unlit cloud
export const LightningOff = createStory(LightningStory, {
  props: stormPose,
  args: {
    ...lightningArgs(),
    'experimental-lightning': false,
    lightningFlash: false,
    animateFlashes: false
  },
  argTypes: lightningArgTypes()
})

// 3. Periodic animated lightning flashes (CPU envelope schedule)
export const LightningStorm = createStory(LightningStory, {
  props: stormPose,
  args: {
    ...lightningArgs(),
    'experimental-lightning': true,
    lightningFlash: false,
    animateFlashes: true
  },
  argTypes: lightningArgTypes()
})
