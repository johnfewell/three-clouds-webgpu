import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as BasicStory } from './Clouds-Basic'
import {
  evolvingWeatherArgs,
  evolvingWeatherArgTypes
} from './controls/evolvingWeatherControls'

export default {
  title: 'clouds-webgpu/Evolving Weather'
} satisfies Meta

// The Basic pose, shared with the Experiments stories
const basicPose = {
  longitude: 30,
  latitude: 35,
  height: 300,
  heading: 0,
  pitch: -5,
  distance: 1000
}

const evolveArgTypes = evolvingWeatherArgTypes()

const evolveArgs = {
  ...evolvingWeatherArgs(),
  'experimental-evolvingWeather': true,
  // The wind field is the motion here. `animate` off leaves
  // localWeatherVelocity and the shape velocities at zero, so the evolution
  // moves the clouds and nothing else does
  animate: false,
  cloudMotion: 'weather' as const
}

// The held arms stop the clock at one time, so a frame is a pure function of
// that number and the stills are reproducible
const held = (time: number) => ({
  ...evolveArgs,
  evolutionRunning: false,
  evolutionTime: time
})

export const Evolve = createStory(BasicStory, {
  props: {
    ...basicPose,
    description: (
      <p>
        Evolving weather: the cloud map drifts on a swirling wind and each cell
        grows and fades over its lifetime. The clock runs at 10x real time; set
        the speed, wind and lifetime under <em>evolving weather</em>.
      </p>
    )
  },
  args: evolveArgs,
  argTypes: evolveArgTypes
})

// The A arm: the same pose and held time with the evolution off through the
// shared experimentMode radio, so a still pair differs by the feature alone
export const EvolveOff = createStory(BasicStory, {
  props: {
    ...basicPose,
    description: (
      <p>
        The same sky with evolving weather off, held at 150 s: the static
        weather map the other stories start from.
      </p>
    )
  },
  args: { ...held(150), experimentMode: 'baseline' },
  argTypes: evolveArgTypes
})

export const EvolveGrowing = createStory(BasicStory, {
  props: {
    ...basicPose,
    description: (
      <p>
        Evolving weather held at 150 s, a quarter of a cell lifetime in, when
        most cells are growing. Run the clock to watch them change.
      </p>
    )
  },
  args: held(150),
  argTypes: evolveArgTypes
})

export const EvolveDecaying = createStory(BasicStory, {
  props: {
    ...basicPose,
    description: (
      <p>
        Evolving weather held at 520 s, past the peak, when the same cells are
        thinning out.
      </p>
    )
  },
  args: held(520),
  argTypes: evolveArgTypes
})

// The drift is a flow map, so its stretch of the map is bounded: an hour in
// reads like the first minute
export const EvolveAfterAnHour = createStory(BasicStory, {
  props: {
    ...basicPose,
    description: (
      <p>
        Evolving weather held at one hour. The wind keeps the map from
        stretching however long the clock runs, so this reads like the first
        minute.
      </p>
    )
  },
  args: held(3600),
  argTypes: evolveArgTypes
})
