import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as EnvironmentStory } from './Clouds-Environment'

export default {
  title: 'clouds-webgpu/Cloud Environment'
} satisfies Meta

// 30E 35N at 300 m, the Basic pose, so the clouds in the reflection are the
// ones a reader already knows from every other story on the port
const pose = {
  longitude: 30,
  latitude: 35,
  height: 300,
  heading: 0,
  pitch: 4,
  distance: 2600
}

export const MirrorAndGloss = createStory(EnvironmentStory, { props: pose })

// The same scene with the option off, for the cost arm that makes the on arm a
// number rather than an impression: the option's whole cost is the difference
// between these two, and it only shows with the display refresh cap lifted
export const MirrorAndGlossOff = createStory(EnvironmentStory, {
  props: pose,
  args: { 'experimental-cloudEnvironment': false }
})
