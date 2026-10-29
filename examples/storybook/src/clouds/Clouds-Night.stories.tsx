import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as NightStory } from './Clouds-Night'
import { moonlightArgs, moonlightArgTypes } from './controls/moonlightControls'

export default {
  title: 'clouds-webgpu/Night'
} satisfies Meta

// The Basic location, one pose for all three arms. PointOfView's heading is the
// CAMERA's azimuth and it looks back at the target, so heading 320 looks along
// azimuth 140, which is where a nearly full moon sits at the default date
const basicPose = {
  longitude: 30,
  latitude: 35,
  height: 300,
  heading: 320,
  pitch: -8,
  distance: 1000
}

// The A arm: the same pose and the same date with the moonlight experiment off
// through the shared experimentMode radio, and the stock sky. The pair is the
// whole claim, one control away
export const NightOff = createStory(NightStory, {
  props: basicPose,
  args: {
    ...moonlightArgs(),
    nightSky: false,
    'experimental-moonlight': false,
    experimentMode: 'experiments'
  },
  argTypes: moonlightArgTypes()
})

export const Night = createStory(NightStory, {
  props: basicPose,
  args: {
    ...moonlightArgs(),
    nightSky: true,
    'experimental-moonlight': true
  },
  argTypes: moonlightArgTypes()
})

// An hour earlier, with the sun just under the horizon: the handover is a fade
// across civil twilight, so this arm shows the two lights sharing the march
export const Twilight = createStory(NightStory, {
  props: basicPose,
  args: {
    ...moonlightArgs(),
    nightSky: true,
    'experimental-moonlight': true,
    dayOfYear: 151,
    timeOfDay: 19
  },
  argTypes: moonlightArgTypes()
})
