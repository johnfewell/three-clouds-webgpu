import type { Meta } from '@storybook/react-vite'

import { createStory } from '../vendor/components/createStory'
import { Story as BasicStory } from './Clouds-Basic'
import { Story as CustomLayersStory } from './Clouds-CustomLayers'
import { Story as FallbackStory } from './Clouds-Fallback'
import { Story as GovernorStory } from './Clouds-Governor'
import { Story as VanillaStory } from './Clouds-Vanilla'
import { Story as WorldOriginRebasingStory } from './Clouds-WorldOriginRebasing'

import BasicCode from './Clouds-Basic?raw'
import CustomLayersCode from './Clouds-CustomLayers?raw'
import FallbackCode from './Clouds-Fallback?raw'
import GovernorCode from './Clouds-Governor?raw'
import VanillaCode from './Clouds-Vanilla?raw'
import WorldOriginRebasingCode from './Clouds-WorldOriginRebasing?raw'

export default {
  title: 'clouds-webgpu/Clouds',
  parameters: {
    docs: {
      codePanel: true,
      source: {
        language: 'tsx'
      }
    }
  }
} satisfies Meta

// The WebGL stories' locations (storybook/src/clouds/Clouds-*.tsx), three-
// geospatial @ b012ad06 (MIT, Copyright (c) 2024 Shota Matsuda). Copied values,
// with an explicit pose about them in place of OrbitControls' default offset

export const Basic = createStory(BasicStory, {
  props: {
    longitude: 30,
    latitude: 35,
    height: 300,
    heading: 0,
    pitch: -5,
    distance: 1000
  },
  parameters: { docs: { source: { code: BasicCode } } }
})

export const CustomLayers = createStory(CustomLayersStory, {
  props: {
    longitude: 30,
    latitude: 35,
    height: 500,
    heading: 0,
    pitch: -5,
    distance: 1000
  },
  parameters: { docs: { source: { code: CustomLayersCode } } }
})

export const WorldOriginRebasing = createStory(WorldOriginRebasingStory, {
  parameters: { docs: { source: { code: WorldOriginRebasingCode } } }
})

// Plain three.js, no r3f, no args: the WebGL Vanilla story's counterpart
export const Vanilla = VanillaStory
Vanilla.parameters = { docs: { source: { code: VanillaCode } } }

// Lab only (not in the showcase manifest): the Vanilla scene with the
// auto-quality governor armed and an injected-load control
export const Governor = GovernorStory
Governor.parameters = { docs: { source: { code: GovernorCode } } }

// Lab only: the WebGL fallback recipe's decision, mounting the WebGPU Basic
// story or the WebGL reference's at this pose
export const Fallback = createStory(FallbackStory, {
  props: {
    longitude: 30,
    latitude: 35,
    height: 300,
    heading: 0,
    pitch: -5,
    distance: 1000
  },
  parameters: { docs: { source: { code: FallbackCode } } }
})
