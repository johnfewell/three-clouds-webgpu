import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as ConvectiveStory } from './Clouds-Convective'

export default {
  title: 'clouds-webgpu/Convection'
} satisfies Meta

// The pose is the Basic one, pulled back to 40 km and lifted to 2 km so a
// 12 km tower fits the frame with sky above it. The only differences from
// Basic are the layer set, the flag and shadow.maxFar
const pose = {
  longitude: 30,
  latitude: 35,
  height: 2000,
  heading: 0,
  pitch: 8,
  distance: 40000
}

// The flag on: the tower, its anvil and the cell concentration
export const Cells = createStory(ConvectiveStory, {
  props: pose,
  args: { 'experimental-convectiveProfile': true }
})

// The flag off, same layer set and same camera. This is the honest comparison
// still: the tall slab alone, with no anvil and an unbroken coverage sheet
export const SameLayersFlagOff = createStory(ConvectiveStory, {
  props: pose,
  args: { 'experimental-convectiveProfile': false }
})

// Anvil only, no cell concentration: anvilStrength up, cellDensity 0
export const AnvilOnly = createStory(ConvectiveStory, {
  props: pose,
  args: {
    'experimental-convectiveProfile': true,
    'convective-cellDensity': 0
  }
})

// Cell concentration only, no shoulder. The two terms live in two samplers, so
// this pair with Cells is what shows the split
export const CellsOnly = createStory(ConvectiveStory, {
  props: pose,
  args: {
    'experimental-convectiveProfile': true,
    'convective-anvilStrength': 0
  }
})

// Low sun, where a 12 km top casts about 45 km of shadow and the default
// shadow.maxFar of 50 km barely covers it
export const LowSun = createStory(ConvectiveStory, {
  props: { ...pose, pitch: 4 },
  args: {
    'experimental-convectiveProfile': true,
    timeOfDay: 17.2
  }
})
