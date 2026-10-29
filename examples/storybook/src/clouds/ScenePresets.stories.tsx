import type { Meta } from '@storybook/react-vite'
import { scenePresets, type ScenePresetName } from 'three-clouds-webgpu'

import { createStory } from '../vendor/components/createStory'
import {
  SCENE_PRESET_POSES,
  Story as ScenePresetsStory
} from './Clouds-ScenePresets'
import {
  scenePresetsArgs,
  scenePresetsArgTypes
} from './controls/scenePresetsControls'

export default {
  title: 'clouds-webgpu/Scene Presets',
  globals: {
    ground: 'ocean'
  }
} satisfies Meta

function forPreset(scenePreset: ScenePresetName) {
  const preset = scenePresets[scenePreset]
  return createStory(ScenePresetsStory, {
    globals: {
      ground: 'ocean'
    },
    props: SCENE_PRESET_POSES[scenePreset],
    args: {
      ...scenePresetsArgs(scenePreset),
      toneMappingExposure: Number((10 * preset.exposure).toFixed(2))
    },
    argTypes: scenePresetsArgTypes()
  })
}

// Interactive selector for all eight presets plus time-of-day control
export const ScenePresets = forPreset('stunningSunset')

export const PartlyCloudy = forPreset('partlyCloudy')

export const Fluffy = forPreset('fluffy')

export const Pixar = forPreset('pixar')

export const StunningSunset = forPreset('stunningSunset')

export const MoonlitNight = forPreset('moonlitNight')

export const Hazy = forPreset('hazy')

export const Thunderstorm = forPreset('thunderstorm')

export const StormyEvening = forPreset('stormyEvening')
