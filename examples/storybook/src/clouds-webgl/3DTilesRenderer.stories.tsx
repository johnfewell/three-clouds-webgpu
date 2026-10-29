// Vendored from three-geospatial storybook/src/clouds/3DTilesRenderer.stories.tsx
// @ b012ad06 (MIT, Copyright (c) 2024 Shota Matsuda), the WebGL reference
// storybook. Edited: the title carries the clouds-webgl prefix.

import type { Meta, StoryFn } from '@storybook/react-vite'

import { Story } from './3DTilesRenderer-Story'

export default {
  title: 'clouds-webgl/3D Tiles Renderer Integration',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta

export const Tokyo: StoryFn = () => (
  <Story
    dayOfYear={170}
    timeOfDay={7.5}
    exposure={10}
    longitude={139.8146}
    latitude={35.7455}
    heading={-110}
    pitch={-9}
    distance={1000}
    coverage={0.35}
  />
)

export const Fuji: StoryFn = () => (
  <Story
    dayOfYear={200}
    timeOfDay={17.5}
    exposure={10}
    longitude={138.634}
    latitude={35.5}
    heading={-91}
    pitch={-27}
    distance={8444}
    coverage={0.4}
  />
)

export const London: StoryFn = () => (
  <Story
    dayOfYear={0}
    timeOfDay={9.4}
    exposure={15}
    longitude={-0.1293}
    latitude={51.4836}
    heading={-94}
    pitch={-7}
    distance={3231}
    coverage={0.35}
  />
)

// Added here (not upstream): the same pose as the WebGPU Toronto story, so
// the pair stays comparable
export const Toronto: StoryFn = () => (
  <Story
    dayOfYear={172}
    timeOfDay={8.5}
    exposure={10}
    longitude={-79.3871}
    latitude={43.6426}
    heading={90}
    pitch={-6}
    distance={3500}
    coverage={0.35}
  />
)
