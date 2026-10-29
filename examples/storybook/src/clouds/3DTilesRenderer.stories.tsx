import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story } from './3DTilesRenderer-Story'

import Code from './3DTilesRenderer-Story?raw'

export default {
  title: 'clouds-webgpu/3D Tiles Renderer Integration',
  parameters: {
    docs: {
      codePanel: true,
      source: {
        language: 'tsx',
        code: Code
      }
    }
  }
} satisfies Meta

// Parameters verbatim from the WebGL storybook's storybook/src/clouds/
// 3DTilesRenderer.stories.tsx, three-geospatial @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda). Copied values, not code

export const Tokyo = createStory(Story, {
  props: {
    longitude: 139.8146,
    latitude: 35.7455,
    heading: -110,
    pitch: -9,
    distance: 1000
  },
  args: {
    dayOfYear: 170,
    timeOfDay: 7.5,
    toneMappingExposure: 10,
    coverage: 0.35
  }
})

export const Fuji = createStory(Story, {
  props: {
    longitude: 138.634,
    latitude: 35.5,
    heading: -91,
    pitch: -27,
    distance: 8444
  },
  args: {
    dayOfYear: 200,
    timeOfDay: 17.5,
    toneMappingExposure: 10,
    coverage: 0.4
  }
})

export const London = createStory(Story, {
  props: {
    longitude: -0.1293,
    latitude: 51.4836,
    heading: -94,
    pitch: -7,
    distance: 3231
  },
  args: {
    dayOfYear: 0,
    timeOfDay: 9.4,
    toneMappingExposure: 15,
    coverage: 0.35
  }
})

// Not in the WebGL storybook upstream: the same pose is added to this
// repository's WebGL stories so the pair stays comparable. The skyline from
// over the harbour, the CN Tower as the target, a June morning
export const Toronto = createStory(Story, {
  props: {
    longitude: -79.3871,
    latitude: 43.6426,
    heading: 90,
    pitch: -6,
    distance: 3500
  },
  args: {
    dayOfYear: 172,
    timeOfDay: 8.5,
    toneMappingExposure: 10,
    coverage: 0.35
  }
})
